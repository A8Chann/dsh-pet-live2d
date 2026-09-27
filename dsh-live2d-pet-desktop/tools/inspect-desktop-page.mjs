// 诊断"桌面端窗口可见，但看不到宠物"。
//
// 窗口几何已经确认是可见的（3440×1392、穿透标志也置上了），所以问题在页面里：要么没画出
// 模型，要么被 JS 藏了。这个脚本把页面的**真实状态**取回来，而不是猜：
//
//   * 根节点上的 data-layer / data-motion / data-phase（客户端自报的状态）
//   * canvas 的实际渲染尺寸与 CSS 尺寸（有一方为 0 就是没画）
//   * 引擎参数快照（全 0 = 没在跑）
//   * 页面里的未捕获异常（`window.__errors`）
//   * 截图（看一眼到底是空白还是画歪了）
//
//   node tools/inspect-desktop-page.mjs [--cdp 9401] [--shot .run/desktop-page.png]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const SHOT = argOf('--shot', join(DESKTOP, '.run', 'desktop-page.png'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面（先带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
  process.exit(2)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
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
  pending.set(id, (message) => resolve(message))
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
})
await send('Runtime.enable')
await send('Page.enable')
const evaluate = async (expression) => {
  const message = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (message.result?.exceptionDetails !== undefined) {
    return 'THREW: ' + String(message.result.exceptionDetails.text).slice(0, 200)
  }
  return message.result?.result?.value
}

console.log('页面 URL : ' + target.url)
console.log('标题     : ' + await evaluate('document.title'))

console.log('\n--- 客户端自报的状态（根节点上的 data-*）')
console.log(await evaluate(`JSON.stringify((() => {
  const el = document.querySelector('[data-dsh-live2d-pet]');
  if (el === null) return { found: false };
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return {
    found: true,
    layer: el.getAttribute('data-layer'),
    layerMode: el.getAttribute('data-layer-mode'),
    motion: el.getAttribute('data-motion'),
    phase: el.getAttribute('data-phase'),
    gaze: el.getAttribute('data-gaze'),
    visibility: style.visibility,
    display: style.display,
    opacity: style.opacity,
    zIndex: style.zIndex,
    box: { w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top), left: Math.round(box.left) },
  };
})())`))

console.log('\n--- canvas 的实际渲染尺寸 vs CSS 尺寸')
console.log(await evaluate(`JSON.stringify((() => {
  const c = document.querySelector('[data-dsh-live2d-pet] canvas');
  if (c === null) return { canvas: false };
  const box = c.getBoundingClientRect();
  return {
    canvas: true,
    attr: { w: c.width, h: c.height },
    css: { w: Math.round(box.width), h: Math.round(box.height) },
    contextLost: (() => { try { const gl = c.getContext('webgl2') || c.getContext('webgl'); return gl === null ? 'no-context' : gl.isContextLost(); } catch (e) { return 'err:' + e.message; } })(),
  };
})())`))

console.log('\n--- 模型与引擎')
console.log(await evaluate(`JSON.stringify({
  hasHook: typeof window.__dshLive2dPet,
  maskInfo: (() => { try { const m = window.__dshLive2dPet?.maskInfo?.(); return m === undefined ? null : { present: m.present, cells: m.cells ?? null }; } catch (e) { return 'err:' + e.message; } })(),
  params: (() => { try { const p = window.__dshLive2dPet?.params?.(); if (p === undefined) return null; const out = {}; let n = 0; for (const k of Object.keys(p)) { if (n >= 8) break; out[k] = typeof p[k] === 'number' ? Number(p[k].toFixed(3)) : p[k]; n += 1; } return out; } catch (e) { return 'err:' + e.message; } })(),
  manifest: (() => { try { return window.__dshLive2dPet?.manifest?.()?.id ?? null; } catch (e) { return 'err:' + e.message; } })(),
})`))

console.log('\n--- 页面里的未捕获异常')
const errors = await evaluate('JSON.stringify(window.__errors ?? [])')
console.log('  ' + errors)

console.log('\n--- 页面刚加载时的控制台（最近 10 条 error/warning）')
for (const event of events.slice(-40)) {
  if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params.type)) {
    const args = event.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    console.log('  [' + event.params.type + '] ' + String(args).slice(0, 200))
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const details = event.params.exceptionDetails
    console.log('  [EXC] ' + String(details.exception?.description ?? details.text).split('\n').slice(0, 4).join(' | '))
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot.result?.data === 'string') {
  mkdirSync(dirname(SHOT), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log('\n截图 : ' + SHOT)
}

socket.close()
