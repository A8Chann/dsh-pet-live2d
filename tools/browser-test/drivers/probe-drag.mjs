// 探针：拖动的 press 到底有没有进 handler。
// 判据是 stage 上的 data-dragging（onPointerDown 里 setDragging(true) 才会出现），
// 以及每一步之后的 style.bottom。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9491
const PROFILE = join(PROFILES, '_probe-drag')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)
const info = JSON.parse(await ev(`(() => { const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) })()`))
const inside = JSON.parse(await ev(`(() => { const c = window.__dshLive2dPet; const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect();
  for (let iy = 0; iy < 64; iy++) for (let ix = 0; ix < 64; ix++) { const lx = r.width * (ix + 0.5) / 64, ly = r.height * (iy + 0.5) / 64;
    if (c.hitsMask(lx, ly, r.width, r.height)) return JSON.stringify({ lx, ly }) } return 'null' })()`))
const gx = Math.round(info.x + inside.lx)
const gy = Math.round(info.y + inside.ly)
const state = async (tag) => {
  const dragging = await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-stage][data-dragging]")')
  const bottom = await ev('document.querySelector("[data-dsh-live2d-pet]").style.bottom')
  const target = await ev('(() => { const e = document.elementFromPoint(' + gx + ',' + gy + '); return e === null ? "null" : (e.hasAttribute("data-hit") ? "hit-proxy" : e.tagName) })()')
  const errs = await ev('JSON.stringify({ errors: (window.__errors ?? []).slice(-3), boot: window.__bootError ?? null })')
  console.log(' '.repeat(22) + ' errors: ' + errs)
  const dbg2 = await ev('JSON.stringify({ afterSetPos: window.__afterSetPos ?? null, renders: window.__posRender ?? null })')
  console.log(' '.repeat(22) + ' render/afterSetPos: ' + dbg2)
  const dbg = await ev('JSON.stringify({ trees: Array.from(document.querySelectorAll("[data-dsh-live2d-pet]")).map((el) => ({ bottom: el.style.bottom, dragging: !!el.querySelector("[data-stage][data-dragging]") })), containers: document.querySelectorAll("[data-dsh-live2d-pet-root]").length, sampled: (window.__dragSamples ?? []).length })')
  console.log(tag.padEnd(22) + ' dragging=' + dragging + '  bottom=' + bottom + '  elementAtPoint=' + target + '  dragDebug=' + dbg)
}
console.log('press point = (' + gx + ',' + gy + ')  stage=' + JSON.stringify(info))
await state('初始')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx, y: gy })
await sleep(150)
await state('移到点上')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gx, y: gy, button: 'left', buttons: 1, clickCount: 1 })
await sleep(250)
await state('press 之后')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx, y: gy + 80, button: 'left', buttons: 1 })
await sleep(300)
await state('move +80 之后')
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gx, y: gy + 80, button: 'left', buttons: 0, clickCount: 1 })
await sleep(300)
await state('release 之后')
ws.close(); edge.kill(); await sleep(300); process.exit(0)
