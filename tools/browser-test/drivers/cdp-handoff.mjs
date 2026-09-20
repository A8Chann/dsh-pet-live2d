import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9449
const PROFILE = join(PROFILES, '_cdp-handoff')
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
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await sleep(4000)
const snap = () => ev('JSON.stringify({ phase: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-phase"), motion: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion"), kind: window.__dshLive2dPet.kind(), playing: window.__dshLive2dPet.isPlaying(), held: window.__dshLive2dPet.isHeld() })')
const out = { steps: [] }
out.steps.push({ at: 'boot', s: JSON.parse(await snap()) })
// hold the phone
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(2200)
out.steps.push({ at: 'held', s: JSON.parse(await snap()) })
// now a session phase must take the body back
await fetch(BASE + '/__nudge?phase=failed')
await sleep(400); out.steps.push({ at: 'phase+0.4s', s: JSON.parse(await snap()) })
await sleep(1600); out.steps.push({ at: 'phase+2s', s: JSON.parse(await snap()) })
// and settle back to idle
await fetch(BASE + '/__nudge?phase=idle')
await sleep(1500); out.steps.push({ at: 'idle', s: JSON.parse(await snap()) })
// idle fidget must also still be able to fire after a hold
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(2200)
out.steps.push({ at: 'held-again', s: JSON.parse(await snap()) })
await ev('window.__dshLive2dPet.playIdle()')
await sleep(1200); out.steps.push({ at: 'after-playIdle', s: JSON.parse(await snap()) })
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)