import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { browserPath, PROFILES } from './paths.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9343
const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:8792/'
const PROFILE = join(PROFILES, '_cdp-frames')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 100 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (method, params = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }

// Freeze the pet in place (small, bottom-right) and sample the rendered
// region every 350ms. PNG bytes come from the compositor, so unlike
// canvas.toDataURL they are a faithful signal for a WebGL surface.
const rect = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})())'))
const sample = async () => {
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
  const buf = Buffer.from(s.result.data, 'base64')
  return { hash: createHash('sha1').update(buf).digest('hex').slice(0, 8), bytes: buf.length }
}
const samples = async (n, gap) => {
  const out = []
  for (let i = 0; i < n; i++) { out.push(await sample()); await sleep(gap) }
  return out
}
const distinct = (list) => new Set(list.map(s => s.hash)).size

const out = {}
// Baseline: idle should already differ frame to frame (it is an animation).
const idle = await samples(5, 350)
out.idleDistinctFrames = distinct(idle)

// Play 重锤出击 (Hammer, 4.767s declared) and sample through and past it.
const c = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})())'))
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
await sleep(500)
const motionSamples = []
const stateTrace = []
const t0 = Date.now()
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button"));bs[1].click();return true})()')
while (Date.now() - t0 < 7000) {
  motionSamples.push(await sample())
  stateTrace.push(Math.round((Date.now() - t0) / 500) / 2 + 's=' + (await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')))
  await sleep(350)
}
out.motionDistinctFrames = distinct(motionSamples)
out.stateTrace = stateTrace.filter((v, i, a) => i === 0 || a[i-1].split('=')[1] !== v.split('=')[1])
out.endedOnIdle = stateTrace[stateTrace.length - 1].endsWith('idle')
// Held the reaction for roughly its declared duration rather than snapping back.
const heldFor = stateTrace.filter(s => s.includes('Hammer')).length * 0.35

console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
