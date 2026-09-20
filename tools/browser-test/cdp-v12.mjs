// Verifies the v1.2 optimisation set:
// 5) panel no longer scales the pet   1) canvas is DPR-correct   2) transparent
// areas are not clickable   3) gaze returns to default   4) session phases drive
// motions   6) idle fidgets fire and release.
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { waitReady } from './ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9360
const PROFILE = join(PROFILES, '_cdp-v12')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails.exception?.description ?? '').slice(0, 220))
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, 'v12-') + n + '.png', Buffer.from(s.result.data, 'base64')) }

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)
const sleep2 = sleep
const out = {}
const state = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
const rect = () => ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})())')
const canvasInfo = () => ev('JSON.stringify((()=>{const c=document.querySelector("[data-dsh-live2d-pet] canvas");const r=c.getBoundingClientRect();return {css:[Math.round(r.width),Math.round(r.height)],backing:[c.width,c.height]}})())')

// #1 DPR correctness
out.dpr = await ev('window.devicePixelRatio')
out.canvas = JSON.parse(await canvasInfo())

// #5 panel must not resize/zoom the pet
const before = JSON.parse(await rect())
const snaps = []
for (let i = 0; i < 4; i++) {
  await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
  await sleep(450)
  const c = JSON.parse(await canvasInfo())
  snaps.push(c.backing.join('x') + '|' + c.css.join('x'))
}
const after = JSON.parse(await rect())
out.panelStable = JSON.stringify(before) === JSON.stringify(after)
out.panelRectBefore = before
out.panelRectAfter = after
out.canvasThroughToggles = snaps
await shot('panel')

// make sure the panel is closed for later steps
if ((await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel]").length')) > 0) {
  await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
  await sleep(400)
}

// #2 clicking a transparent corner must NOT react
const geo = JSON.parse(await rect())
const corner = [geo[0] + 6, geo[1] + 6]
const centre = [geo[0] + geo[2] / 2, geo[1] + geo[3] / 2]
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
const bubbleText = () => ev('(document.querySelector("[data-dsh-live2d-pet] [data-bubble]")||{}).textContent || null')
// A fidget never speaks, so the bubble is a clean signal for "did this click
// actually hit the character?" even if a random 摸鱼 animation is running.
await sleep(600)
const bubbleBefore = await bubbleText()
await click(corner[0], corner[1])
await sleep(700)
out.cornerIgnored = (await bubbleText()) === bubbleBefore

// find an actual opaque pixel: walk a vertical line and hit-test
const opaque = JSON.parse(await ev(`JSON.stringify((()=>{
  const model = document.querySelector('[data-dsh-live2d-pet] canvas')
  const r = model.getBoundingClientRect()
  return { x: Math.round(r.left + r.width/2), top: Math.round(r.top), h: Math.round(r.height) }
})())`))
// Make sure no session phase is holding the body before the hit probes.
await fetch(BASE + '/__nudge?phase=idle')
await sleep(900)
const bubbleNow = () => ev('(document.querySelector("[data-dsh-live2d-pet] [data-bubble]")||{}).textContent || null')
// Scan a grid over the pet box: transparent margins must stay inert while the
// character's own body reacts. This is the direct check for requirement #2.
const gridRows = []
let hits = 0
let total = 0
for (const fy of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
  const row = []
  for (const fx of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
    const x = Math.round(geo[0] + geo[2] * fx)
    const y = Math.round(geo[1] + geo[3] * fy)
    const before = await bubbleNow()
    await click(x, y)
    await sleep(420)
    const hit = (await bubbleNow()) !== before
    total += 1
    if (hit) { hits += 1; await sleep(5200) }
    row.push(hit ? '#' : '.')
  }
  gridRows.push(row.join(''))
}
out.clickMap = gridRows
out.clickHits = hits
out.clickTotal = total
// The four extreme corners must all be inert (transparent).
const corners = [gridRows[0][0], gridRows[0][6], gridRows[6][0], gridRows[6][6]]
out.cornersInert = corners.every((c) => c === '.')
// The body (centre band) must be live.
out.centreBandLive = gridRows[3].slice(2, 5).includes('#') || gridRows[2].slice(2, 5).includes('#')
await sleep(5500)
out.afterCentreClick = await state()
await shot('hit')

// #3 gaze returns to default when the pointer leaves
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
await sleep(700)
// Gaze contract: 'pointer' while the cursor steers, 'center' once it leaves.
const viewport = JSON.parse(await ev('JSON.stringify([window.innerWidth, window.innerHeight])'))
const gazeAt = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-gaze")')

// Pointer right on the pet -> tracking.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0], y: centre[1] })
await sleep(500)
out.gazeHover = await gazeAt()
// Off to a far corner, well outside the gaze range -> back to the default.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: viewport[1] - 2 })
await sleep(700)
out.gazeAwayA = await gazeAt()
// A different far corner must give the SAME default target (proving the gaze
// returns to the model's centre rather than latching onto the last position).
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: viewport[0] - 2, y: 2 })
await sleep(700)
out.gazeAwayB = await gazeAt()
out.gazeTracks = out.gazeHover === 'pointer'
out.gazeReturnsToDefault = out.gazeAwayA === 'center' && out.gazeAwayB === 'center'
// Confirm the gaze truly moved: sample the rendered box while tracking vs resting.
const clip = {
  x: Math.max(0, geo[0]), y: Math.max(0, geo[1]),
  width: Math.min(geo[2], viewport[0] - Math.max(0, geo[0])),
  height: Math.min(geo[3], viewport[1] - Math.max(0, geo[1])),
  scale: 1,
}
const boxHash = async () => {
  const reply = await send('Page.captureScreenshot', { format: 'png', clip })
  const data = reply?.result?.data
  if (typeof data !== 'string') { out.shotError = JSON.stringify(reply).slice(0, 300); return null }
  return createHash('sha1').update(Buffer.from(data, 'base64')).digest('hex').slice(0, 8)
}
await sleep(400)
out.hashResting = await boxHash()

// #4 session phase -> motion, driven through the harness nudge endpoint.
// Short motions (spray-water is 0.47s) finish before a single sample, so poll
// rapidly right after each nudge and record every group the pet entered.
const nudge = async (phase) => { await fetch(BASE + '/__nudge?phase=' + phase) }
const watch = async (ms) => {
  const seen = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    const s = await state()
    if (s !== 'idle' && seen[seen.length - 1] !== s) seen.push(s)
    await sleep(80)
  }
  return seen
}
const expected = JSON.parse(await ev('JSON.stringify(Object.assign({}, ' +
  '{"tool":"Ketchup","done":"BubbleGum","failed":"SprayWater"}, ' +
  'window.__dshPetPhaseMotion || {}))'))
out.phaseExpected = expected
const phases = {}
for (const phase of ['thinking', 'tool', 'failed', 'done']) {
  await nudge('idle'); await sleep(700)
  await nudge(phase)
  const seen = await watch(2600)
  phases[phase] = seen
}
out.phaseSeen = phases
out.phaseToolOk = phases.tool.includes('Hammer')
out.phaseFailedOk = phases.failed.includes('SprayWater')
out.phaseDoneOk = phases.done.includes('BubbleGum')
await nudge('idle'); await sleep(900)
out.phaseIdle = await state()
await shot('phase')

// #6 idle fidget eventually fires on its own and releases
out.fidgetObserved = false
const deadline = Date.now() + 32000
let sawMotion = null
while (Date.now() < deadline) {
  const s = await state()
  if (s !== 'idle') { sawMotion = s; break }
  await sleep(400)
}
out.fidgetObserved = sawMotion !== null
out.fidgetMotion = sawMotion
await sleep(6500)
out.afterFidget = await state()
out.fidgetReleased = out.afterFidget === 'idle'

out.logs = logs.slice(0, 5)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
