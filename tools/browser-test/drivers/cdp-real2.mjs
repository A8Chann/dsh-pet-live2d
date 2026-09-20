import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { browserPath, PROFILES, SHOTS } from './paths.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9344
const URL_TO_OPEN = process.argv[2]
const PROFILE = join(PROFILES, '_cdp-real2')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
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
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 250))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR: ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200))
}
const send = (method, params = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, 'real2-') + n + '.png', Buffer.from(s.result.data, 'base64')) }

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
// Wait for the pet root to exist at all.
let ready = false
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (await ev('document.querySelectorAll("[data-dsh-live2d-pet] canvas").length') > 0) { ready = true; break }
}
const out = { mounted: ready }
if (ready) {
  const st = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
  await sleep(1500)
  out.idle = await st()
  // Tap the pet in the REAL gui.
  const c = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})())'))
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(600)
  out.afterTap = await st()
  await shot('tapped')
  await sleep(6000)
  out.afterTapSettled = await st()
  // Panel motion in the real GUI.
  await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
  await sleep(600)
  await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button"));bs[6].click();return true})()')
  await sleep(600)
  out.panelMotion = await st()
  await shot('panel')
  await sleep(3000)
  out.panelSettled = await st()
  out.motionCount = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button").length')
}
out.logs = logs.slice(0, 5)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
