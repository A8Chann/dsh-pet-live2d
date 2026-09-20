import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9380
const URL_TO_OPEN = process.argv[2]
const PROFILE = join(PROFILES, '_cdp-real3')
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
let nextId = 0; const pending = new Map(); const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails.exception?.description ?? '').slice(0, 200))
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, 'real3-') + n + '.png', Buffer.from(s.result.data, 'base64')) }
const attr = (a) => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute && document.querySelector("[data-dsh-live2d-pet]").getAttribute("' + a + '")')

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
let mounted = false
for (let i = 0; i < 140; i++) {
  await sleep(500)
  if (await ev('document.querySelectorAll("[data-dsh-live2d-pet] canvas").length') > 0) { mounted = true; break }
}
const out = { mounted }
if (mounted) {
  await sleep(4000)
  out.motion0 = await attr('data-motion')
  out.gaze0 = await attr('data-gaze')
  out.phase0 = await attr('data-phase')
  out.mask = await ev('JSON.stringify(window.__dshLive2dPet.maskInfo())')
  // #5: toggling the panel must not resize the pet
  const before = await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})())')
  for (let i = 0; i < 3; i++) {
    await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
    await sleep(450)
  }
  const after = await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})())')
  out.sizeStable = before === after
  out.sizeBefore = before; out.sizeAfter = after
  if ((await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel]").length')) > 0) {
    await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
    await sleep(400)
  }
  // #2: a transparent corner must be inert
  const geo = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})())'))
  const bubble = () => ev('(document.querySelector("[data-dsh-live2d-pet] [data-bubble]")||{}).textContent || null')
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const b0 = await bubble()
  await click(geo[0] + 5, geo[1] + 5)
  await sleep(600)
  out.cornerInert = (await bubble()) === b0
  // #3: gaze resets when the pointer leaves
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo[0] + geo[2] / 2, y: geo[1] + geo[3] / 2 })
  await sleep(500)
  out.gazeTracking = await attr('data-gaze')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 890 })
  await sleep(800)
  out.gazeReset = await attr('data-gaze')
  // #6: a fidget appears if we wait
  let fidget = null
  const deadline = Date.now() + 32000
  while (Date.now() < deadline) {
    const s = await attr('data-motion')
    if (s !== 'idle') { fidget = s; break }
    await sleep(400)
  }
  out.fidget = fidget
  await sleep(6000)
  out.afterFidget = await attr('data-motion')
  await shot('final')
}
out.logs = logs.slice(0, 4)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
