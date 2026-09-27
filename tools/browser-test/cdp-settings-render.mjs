// 设置**正文**能不能渲染出来（这是套件之前的一个盲点）。
//
// 为什么要单开一个 driver：其它 driver 只验"设置那一节注册上了"（`__pluginSections` 里有
// 没有 `pet-settings`），**没有一个真的调用它的 render**。于是下面这种崩法可以悄悄溜过去：
//
//   ReferenceError: layerRef is not defined
//       at LayerControls (client.js)
//
// 症状是"宠物一切正常，只有设置页打不开" —— 因为设置页那一节渲染在**宠物组件之外**
// （挂在 DSH 设置页上），读组件内的 ref 会立刻炸。2026-09 真的踩过一次。
//
//   node cdp-settings-render.mjs        # 由 run-suite.mjs 拉起（自带服务器）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, browserPath, HERE, PROFILES } from './paths.mjs'

const PORT = Number(process.env.PET_PORT ?? 8793)
const PROFILE = join(PROFILES, '_cdp-settings-render')
const CDP_PORT = 9333

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { spawn } = await import('node:child_process')
const browser = spawn(browserPath(), [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  BASE + '/',
], { stdio: 'ignore' })

const waitForCdp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口没就绪')
}

const socket = new WebSocket(await waitForCdp())
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const cb = pending.get(message.id)
    if (cb) { pending.delete(message.id); cb(message) }
    return
  }
  events.push(message)
})
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
})
await send('Runtime.enable')
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result?.result?.value))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

// 等假宿主把插件应用起来。
let applied = false
for (let i = 0; i < 60 && !applied; i += 1) {
  applied = (await evaluate('String(window.__pluginSections !== undefined && window.__pluginSections["pet-settings"] !== undefined)')) === 'true'
  if (!applied) await sleep(300)
}
check('设置那一节注册上了', applied)
if (!applied) {
  console.log('（后面的断言依赖它，直接收尾）')
} else {
  // **真的渲染它** —— 这一步就是本 driver 的全部意义。
  const rendered = await evaluate(`(() => {
    const section = window.__pluginSections['pet-settings'];
    let host = document.getElementById('dsh-settings-probe');
    if (host === null) { host = document.createElement('div'); host.id = 'dsh-settings-probe'; document.body.appendChild(host); }
    try {
      window.ReactDOM.createRoot(host).render(window.React.createElement(section.render));
      return 'ok';
    } catch (error) {
      return 'THREW: ' + String((error && error.stack) || error).slice(0, 400);
    }
  })()`)
  check('渲染调用没抛', rendered === 'ok', String(rendered).slice(0, 300))
  await sleep(1200)

  const cards = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-card]")].map((n) => n.getAttribute("data-card")))'))
  check('设置正文渲染出了卡片', cards.length >= 5, cards.join(','))

  const layerButtons = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-layer-options] button")].map((n) => n.textContent))'))
  check('「显示位置」那张卡有三个选项', layerButtons.length === 3, layerButtons.join('/'))

  const flags = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-flag]")].map((n) => n.getAttribute("data-flag")))'))
  check('互动开关还在', flags.includes('patEnabled') && flags.includes('tailEnabled'), flags.join(','))

  // 页面侧**没有未捕获异常** —— "整节崩掉"必然在这里留下痕迹。
  const errors = JSON.parse(await evaluate('JSON.stringify(window.__errors ?? [])'))
  check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 300))

  // 顺带把显示层状态读口确认一遍（它是新加的，且设置页要用它）。
  const layerState = await evaluate('String(document.querySelector("#dsh-settings-probe [data-layer-status]")?.textContent ?? "(没有)")')
  check('显示层状态行渲染出来了', typeof layerState === 'string' && layerState !== '(没有)', String(layerState).slice(0, 120))
}

socket.close()
browser.kill()

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SETTINGS-RENDER ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length + '（端口 ' + PORT + '，harness ' + HERE + '）')
process.exit(failed.length === 0 ? 0 : 1)
