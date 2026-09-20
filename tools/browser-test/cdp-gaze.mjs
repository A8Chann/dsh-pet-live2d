import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady } from './ready.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9381
const URL_TO_OPEN = process.argv[2] ?? BASE + '/'
const PROFILE = join(PROFILES, '_cdp-gaze')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 140; i++) { await sleep(500); if (await ev('document.querySelectorAll("[data-dsh-live2d-pet] canvas").length') > 0) break }
await waitReady(ev)
const out = {}
const gaze = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-gaze")')
const geo = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})())'))
out.petRect = geo
out.windowSize = JSON.parse(await ev('JSON.stringify([window.innerWidth, window.innerHeight])'))
const move = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(500) }

await move(geo[0] + geo[2] / 2, geo[1] + geo[3] / 2)
out.onPet = await gaze()
// Just outside the pet box but inside GAZE_RANGE (240) -> still tracking.
await move(geo[0] - 120, geo[1] - 120)
out.justOutside = await gaze()
// Far away in the top-left corner -> beyond range -> default.
await move(5, 5)
out.farTopLeft = await gaze()
// Far away bottom-left too: must resolve to the same default.
await move(5, out.windowSize[1] - 5)
out.farBottomLeft = await gaze()
// Back on the pet -> tracking again.
await move(geo[0] + geo[2] / 2, geo[1] + geo[3] / 2)
out.backOnPet = await gaze()
out.resetsToDefault = out.farTopLeft === 'center' && out.farBottomLeft === 'center'
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
