import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { browserPath, PROFILES, SHOTS, BASE } from './paths.mjs'
import { waitReady } from './ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9341
const URL_TO_OPEN = process.argv[2] ?? BASE + '/'
const PROFILE = join(PROFILES, '_cdp-sm2')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page
for (let i = 0; i < 100 && page === undefined; i++) {
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
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300))
}
const send = (method, params = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, 'sm-') + n + '.png', Buffer.from(s.result.data, 'base64')) }
const state = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
const hash = async () => createHash('sha1').update(await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL()')).digest('hex').slice(0,10)

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const out = {}
out.idleAtRest = await state()
const c = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})())'))
const tap = async () => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', buttons: 0, clickCount: 1 })
}
// A. tap -> reaction, then self-release to idle (the reported bug)
await tap(); await sleep(600)
out.afterTap = await state()
await shot('tap')
const frameEarly = await hash()
await sleep(5500)
out.tapSettled = await state()
out.tapReleased = out.tapSettled === 'idle'
out.stillAnimating = (await hash()) !== frameEarly

// B. same motion twice in a row (needs stopAllMotions to replay)
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
await sleep(500)
const clickChip = (i) => ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button"));bs[' + i + '].click();return true})()')
await clickChip(1); await sleep(400); out.replay1 = await state()
await clickChip(1); await sleep(400); out.replay2 = await state()
await sleep(5500); out.replaySettled = await state()

// C. rapid taps must not wedge the machine
for (let i = 0; i < 6; i++) { await tap(); await sleep(200) }
out.rightAfterRapid = await state()
await sleep(6500)
out.afterRapid = await state()
out.rapidReleased = out.afterRapid === 'idle'

// D. panel idle button returns to rest
await clickChip(3); await sleep(500); out.panelPlay = await state()
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-bar] button"));bs[1].click();return true})()')
await sleep(500); out.afterReset = await state()
await shot('final')

out.logs = logs.slice(0, 6)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
