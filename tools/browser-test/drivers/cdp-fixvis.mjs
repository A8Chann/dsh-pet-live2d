import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9445
const PROFILE = join(PROFILES, '_cdp-fixvis')
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
await sleep(4000)
const shot = async (name) => {
  const url = await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL("image/png")')
  writeFileSync(join(SHOTS, 'fix-') + name + '.png', Buffer.from(url.split(',')[1], 'base64'))
}
const st = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
await ev('window.__dshLive2dPet.playIdle()'); await sleep(1500); await shot('0-rest')
// spray: the whale must appear
await ev('window.__dshLive2dPet.playOnce("SprayWater",0,{kind:"panel"})'); await sleep(350); await shot('1-spray')
console.log('spray motion:', await st())
// bubble: mid-animation (bubble visible)
await ev('window.__dshLive2dPet.playOnce("BubbleGum",0,{kind:"panel"})'); await sleep(3400); await shot('2-bubble-mid')
for (let i=0;i<30;i++){ await sleep(500); if (await st() === 'idle') break }
await sleep(1500); await shot('3-bubble-restored')
// open case: held pose
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})'); await sleep(1600); await shot('4-open-case-hold')
console.log('open-case motion:', await st())
// selfie chain end state
await ev('window.__dshLive2dPet.playOnce("Selfie",0,{kind:"panel"})'); await sleep(5000); await shot('5-selfie')
console.log('selfie motion:', await st())
console.log('done')
ws.close(); edge.kill(); process.exit(0)