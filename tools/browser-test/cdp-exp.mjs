import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createHash as ch } from 'node:crypto'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9447
const PROFILE = join(PROFILES, '_cdp-exp')
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
const reqs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return } if (m.method === 'Network.responseReceived') { const u = m.params.response.url; if (u.includes('expressions/')) reqs.push(m.params.response.status + ' ' + decodeURIComponent(u.split('/').pop())) } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await sleep(4000)
const out = {}
// 1. expression requests observed during boot (idle phase pins 脸红)
out.expressionRequestsAtBoot = reqs.slice(0, 12)
out.bootFailures = reqs.filter(r => !r.startsWith('2')).length
// 2. open the panel, switch to the expressions tab
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button"); if(b) b.click(); return 1})()')
await sleep(600)
await ev('(()=>{const t=document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button")[1]; if(t) t.click(); return 1})()')
await sleep(600)
out.expChipCount = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button").length')
const hash = async () => ch('sha1').update(String(await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL()'))).digest('hex').slice(0,10)
// 3. click three specific chips and confirm the canvas changes AND the request succeeded
const labels = ['墨镜','星星眼','头顶鲸']
out.chipResults = []
for (const label of labels) {
  const before = await hash()
  const clicked = await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button")); const b=bs.find(x=>x.textContent===' + JSON.stringify(label) + '); if(!b) return false; b.click(); return true})()')
  await sleep(1400)
  const after = await hash()
  out.chipResults.push({ label, clicked, changed: before !== after })
}
out.expressionRequestsAfterClicks = reqs.filter(r => /expressions/.test(r)).slice(-6)
out.anyFailedRequests = reqs.filter(r => !r.startsWith('2'))
// 4. a held pose must still yield to an idle fidget / phase
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(2200)
out.heldState = await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
out.heldIsPlaying = await ev('window.__dshLive2dPet.isPlaying()')
out.heldIsHeld = await ev('window.__dshLive2dPet.isHeld()')
// a session phase must be able to take the body back
await fetch(BASE + '/__nudge?phase=failed')
await sleep(1500)
out.afterPhaseState = await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
out.phaseTookOver = out.afterPhaseState === 'SprayWater'
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)