// 官方「插件」页上这一组合包的配置区：**渲染得出来**、**点下去真的生效**。
//
// 和 `dsh-live2d-pet-desktop/tools/probe-plugin-page-meta.mjs` 分工不同：那条验的是宿主
// 那一半（标题 / 描述 / 图标读不读得出来，用的是宿主自己的 `readPluginMeta`），这条验
// 客户端这一半 —— `plugins.bundle.config` 注册上了**还不等于**渲染得出来。
//
// 这条 driver 的形状是抄 `cdp-settings-render.mjs` 的，理由也一样：这一节渲染在
// **宠物组件之外**（挂在插件页上），读组件内的东西会当场 `ReferenceError`，
// 而症状是"宠物一切正常、只有那一节崩" —— 套件里"注册上了"这种断言抓不到它。
//
//   node cdp-plugin-page.mjs        # 由 run-suite.mjs 拉起（自带服务器）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, browserPath, HERE, PROFILES } from './paths.mjs'
import { killBrowser, waitReady } from './ready.mjs'

const PORT = Number(process.env.PET_PORT ?? 8793)
const PROFILE = join(PROFILES, '_cdp-plugin-page')
// CDP 端口跟着分到的 slot 走（写死会在并发时抢端口，几秒内假红）。
const SLOT = Math.max(0, PORT - 8793)
const CDP_PORT = 9483 + SLOT

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
], { stdio: 'ignore', detached: process.platform !== 'win32' })

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

/** 点一个控件：走**浏览器层面的输入事件**（DOM 合成事件点不动 React 的处理函数）。 */
const clickControl = async (selector) => {
  const point = JSON.parse(await evaluate(`JSON.stringify((() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    // 自校验"这个点上真的是它"：默默点偏会让断言看起来像"功能没生效"。
    return { x, y, self: document.elementFromPoint(x, y) === el };
  })())`))
  if (point === null) return 'no-target'
  if (point.self !== true) return 'covered'
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  return 'ok'
}

// ---- 等假宿主把插件应用起来 --------------------------------------------------
let applied = false
for (let i = 0; i < 60 && !applied; i += 1) {
  applied = (await evaluate('String(window.__pluginSections !== undefined && window.__pluginSections["dsh-pet-live2d"] !== undefined)')) === 'true'
  if (!applied) await sleep(300)
}
check('配置区按**组合包包名**注册上了（键写错就查不到）', applied, JSON.stringify(await evaluate('JSON.stringify(Object.keys(window.__pluginSections ?? {}))')))

if (!applied) {
  console.log('（后面的断言依赖它，直接收尾）')
} else {
  // **真的渲染它** —— 这一步就是本 driver 的全部意义。
  const rendered = await evaluate(`(() => {
    const section = window.__pluginSections['dsh-pet-live2d'];
    let host = document.getElementById('plugin-page-probe');
    if (host === null) { host = document.createElement('div'); host.id = 'plugin-page-probe'; document.body.appendChild(host); }
    try {
      window.ReactDOM.createRoot(host).render(window.React.createElement(section.render));
      return 'ok';
    } catch (error) {
      return 'THREW: ' + String((error && error.stack) || error).slice(0, 400);
    }
  })()`)
  check('渲染调用没抛', rendered === 'ok', String(rendered).slice(0, 300))
  await sleep(800)
  const probe = '#plugin-page-probe '

  const shape = JSON.parse(await evaluate(`JSON.stringify((() => {
    const root = document.querySelector('#plugin-page-probe [data-pet-plugin-page]');
    return {
      wrapped: root !== null,
      settingsScope: root !== null && root.hasAttribute('data-pet-settings'),
      status: root?.querySelector('[data-plugin-status]')?.textContent ?? null,
      cards: [...(root?.querySelectorAll('[data-card]') ?? [])].map((n) => n.getAttribute('data-card')),
      flags: [...(root?.querySelectorAll('[data-flag]') ?? [])].map((n) => n.getAttribute('data-flag')),
      sliders: [...(root?.querySelectorAll('[data-input]') ?? [])].map((n) => n.getAttribute('data-input')),
      layerChips: [...(root?.querySelectorAll('[data-layer-options] button') ?? [])].map((n) => n.textContent),
      note: root?.lastElementChild?.textContent ?? null,
    };
  })())`))
  check('配置区渲染出来了（且复用设置正文那套样式作用域）', shape.wrapped && shape.settingsScope, JSON.stringify(shape).slice(0, 200))
  check('三张卡：常用开关 / 手感 / 显示位置',
    shape.cards?.join(',') === 'plugin-flags,plugin-tuning,plugin-layer', String(shape.cards))
  check('六个常用开关都在', shape.flags?.join(',') === 'bubbleEnabled,soundEnabled,patEnabled,tailEnabled,spinEnabled,outfitArchive',
    String(shape.flags))
  check('只挑四根滑杆（不是把设置页整份搬过来）',
    shape.sliders?.join(',') === 'gazeRangePx,gazeWatchingRatio,fidgetQuietMs,soundVolume', String(shape.sliders))
  check('状态行说明"她在哪"', typeof shape.status === 'string' && shape.status.includes('当前宠物') && shape.status.includes('显示位置'),
    String(shape.status))
  check('末行指向完整设置那一处', typeof shape.note === 'string' && shape.note.includes('设置 → 桌宠'), String(shape.note))
  check('显示位置三个选项都在', shape.layerChips?.length === 3, String(shape.layerChips))

  // 观感也是契约：三个选项必须是"圆的、并排的"。少一层 `[data-reaction-set]` 壳
  // 就会挤成一行字（设置页那边实测过一次）。
  const chips = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#plugin-page-probe [data-layer-options] button')].map((n) => {
    const style = getComputedStyle(n); const box = n.getBoundingClientRect();
    return { radius: style.borderRadius, h: Math.round(box.height), top: Math.round(box.top) };
  }))`))
  check('三个选项是横排的胶囊', chips.length === 3 && new Set(chips.map((c) => c.top)).size === 1
    && chips.every((c) => c.radius === '999px' && c.h < 32), JSON.stringify(chips))

  // ---- 点一下真的写进插件状态（不是只改 DOM）-------------------------------
  const petReady = await waitReady(evaluate)
  check('宠物已就绪（读口在）', petReady)
  const readFlags = async () => JSON.parse(await evaluate('JSON.stringify(window.__dshLive2dPet.settingsOverrides().flags)'))
  const before = await readFlags()
  const toggle = await clickControl(probe + '[data-flag="bubbleEnabled"]')
  await sleep(400)
  const afterOff = await readFlags()
  check('点「显示气泡」把开关关掉（读的是插件状态，不是 DOM）',
    toggle === 'ok' && before.bubbleEnabled === true && afterOff.bubbleEnabled === false,
    toggle + ' / ' + JSON.stringify([before.bubbleEnabled, afterOff.bubbleEnabled]))
  const toggleBack = await clickControl(probe + '[data-flag="bubbleEnabled"]')
  await sleep(400)
  const afterOn = await readFlags()
  check('再点一下开回来', toggleBack === 'ok' && afterOn.bubbleEnabled === true, JSON.stringify(afterOn))

  // ---- 滑杆：拖了要落盘（共享写走宿主，harness 的 home 是可丢弃目录）---------
  const slider = await evaluate(`(() => {
    const input = document.querySelector('#plugin-page-probe [data-input="gazeRangePx"]');
    if (input === null) return 'no-slider';
    const original = input.value;
    try {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '420');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return original;
    } catch (error) { return 'THREW: ' + String(error) }
  })()`)
  await sleep(400)
  const tuning = JSON.parse(await evaluate('JSON.stringify(JSON.parse(window.localStorage.getItem("dsh-pet-live2d.settings.v1") ?? "null"))'))
  check('拖「注视满偏 px」写进了可调项存档', tuning?.gazeRangePx === 420,
    '原值 ' + String(slider) + ' → ' + JSON.stringify(tuning?.gazeRangePx))
  // 复位：套件里别的 driver 也会读这一份存档。
  await evaluate(`(() => {
    const input = document.querySelector('#plugin-page-probe [data-input="gazeRangePx"]');
    if (input === null) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(slider))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true })()`)
  await sleep(300)

  // 页面侧**没有未捕获异常** —— "这一节崩掉"必然在这里留下痕迹。
  const errors = JSON.parse(await evaluate('JSON.stringify(window.__errors ?? [])'))
  check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 300))
}

socket.close()
killBrowser(browser)

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('PLUGIN-PAGE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length
  + '（端口 ' + PORT + '，harness ' + HERE + '）')
process.exit(failed.length === 0 ? 0 : 1)
