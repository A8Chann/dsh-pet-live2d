// Item #5 — only the character is draggable; the transparent margin of the
// square canvas must let events through to whatever is behind it.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9383
const PROFILE = join(PROFILES, '_cdp-passthrough')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }

const info = JSON.parse(await ev(`(() => {
  const stage = document.querySelector('[data-dsh-live2d-pet] [data-stage]')
  const r = stage.getBoundingClientRect()
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height })
})()`))

// A point inside the character, and the top-left corner of its square box,
// which the silhouette never reaches.
const inside = JSON.parse(await ev(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  for (let iy = 0; iy < 64; iy++) {
    for (let ix = 0; ix < 64; ix++) {
      const lx = r.width * (ix + 0.5) / 64, ly = r.height * (iy + 0.5) / 64
      if (c.hitsMask(lx, ly, r.width, r.height)) return JSON.stringify({ lx, ly })
    }
  }
  return 'null'
})()`))
check('found a point on the character', inside !== null)

const at = async (lx, ly) => ev('(() => { const e = document.elementFromPoint(' + (info.x + lx) + ',' + (info.y + ly) + '); return e === null ? "null" : (e.hasAttribute("data-hit") ? "pet" : (e.tagName + (e.id ? "#" + e.id : ""))) })()')

check('the character is hit-testable', (await at(inside.lx, inside.ly)) === 'pet', 'at character = ' + await at(inside.lx, inside.ly))
// All four corners of the square box are transparent for this model.
for (const [name, lx, ly] of [['top-left', 4, 4], ['top-right', info.w - 4, 4], ['bottom-left', 4, info.h - 4], ['bottom-right', info.w - 4, info.h - 4]]) {
  const target = await at(lx, ly)
  check('the ' + name + ' corner falls through to the page', target !== 'pet', 'target = ' + target)
}

// A real click in the transparent margin must not reach the pet at all.
await ev('window.__ev = []; for (const t of ["pointerdown", "mousedown", "click"]) document.addEventListener(t, e => window.__ev.push(t + ":" + (e.target.hasAttribute && e.target.hasAttribute("data-hit") ? "pet" : "page")), true)')
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}
await ev('window.__dshLive2dPet.resetToRest()')
await sleep(1200)
await clickAt(info.x + 4, info.y + 4)
const cornerEvents = JSON.parse(await ev('JSON.stringify(window.__ev)'))
check('a corner click reaches the page, not the pet', cornerEvents.length > 0 && !cornerEvents.some(e => e.endsWith(':pet')), JSON.stringify(cornerEvents))
check('a corner click triggers no reaction', (await ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.("data-motion")')) === 'idle',
  'data-motion=' + await ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.("data-motion")'))

// ...while a click on the character still works.
await ev('window.__ev = []')
await clickAt(info.x + inside.lx, info.y + inside.ly)
const bodyEvents = JSON.parse(await ev('JSON.stringify(window.__ev)'))
check('a character click is delivered to the pet', bodyEvents.some(e => e.endsWith(':pet')), JSON.stringify(bodyEvents))

// Dragging must only start on the character: a corner drag must not move it.
const before = await ev('JSON.stringify([window.__dshLive2dPet ? 1 : 1]) && document.querySelector("[data-dsh-live2d-pet]").style.right')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x + 4, y: info.y + 4, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x - 120, y: info.y - 120, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x - 120, y: info.y - 120, button: 'left', buttons: 0, clickCount: 1 })
await sleep(400)
const afterCornerDrag = await ev('document.querySelector("[data-dsh-live2d-pet]").style.right')
check('dragging from the transparent margin does not move the pet', before === afterCornerDrag, before + ' -> ' + afterCornerDrag)

// 从角色身上往下拖：必须能拖到屏幕下边（原来下界是 0，脚一贴底就动不了了）。
// 模型的画布有透明边距，角色看着悬空，用户要把它再往下压一点。
//
// 每一轮都**重新量**角色位置：宠物被拖走之后，上一轮的坐标就按不到它了
// （原来 6 轮共用一个起始点，首按一偏就整条假红）。
const bottomBefore = await ev('document.querySelector("[data-dsh-live2d-pet]").style.bottom')
// 量的必须是 **stage**：根节点还含头顶气泡，比舞台高一截，
// 拿根节点的盒子去套舞台内的偏移，落点会整体偏上，按不到角色（踩过）。
const boxOf = async () => JSON.parse(await ev('JSON.stringify((() => {'
  + ' const r = document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();'
  + ' return [r.x, r.y, r.width, r.height] })())'))
// 角色身上的那个点，相对盒子左上角的偏移 —— 盒子怎么动都跟着。
const grabDx = inside.lx
const grabDy = inside.ly
for (let i = 1; i <= 6; i += 1) {
  const box = await boxOf()
  const gx = Math.round(box[0] + grabDx)
  const gy = Math.round(box[1] + grabDy)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gx, y: gy, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx, y: gy + 60, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gx, y: gy + 60, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
}
const bottomAfter = await ev('document.querySelector("[data-dsh-live2d-pet]").style.bottom')
check('可以把宠物往下拖到屏幕底边之外', Number.parseFloat(bottomAfter) < -20,
  'bottom ' + bottomBefore + ' -> ' + bottomAfter)

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
