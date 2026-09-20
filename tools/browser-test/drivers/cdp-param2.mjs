import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9427
const PROFILE = join(PROFILES, '_cdp-param2')
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
const IDS = ["chuipaopao","chuipaopao2","pengshui","phone","phone2","phone3"]
const readExpr = 'JSON.stringify((() => { const raw = window.__PET_DBG.model.internalModel.coreModel._model.parameters; const out = {}; for (const id of ' + JSON.stringify(IDS) + ') { const i = Array.from(raw.ids).indexOf(id); out[id] = i < 0 ? "NOID" : +raw.values[i].toFixed(3) } return out })())'
const read = () => ev(readExpr)
// Drive the engine directly, bypassing our controller, so we see the raw curve.
const play = (group, idx, loop) => ev('window.__PET_DBG.model.motion(' + JSON.stringify(group) + ',' + idx + ',3,{loop:' + loop + '}).then(()=>1)')
const sample = async (group, idx, loop, ms) => {
  const series = []
  await play(group, idx, loop)
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { series.push({ t: Date.now() - t0, v: JSON.parse(await read()) }); await sleep(120) }
  return series
}
const out = {}
out.openCaseLoopTrue = await sample('OpenCase', 0, true, 2200)
await sleep(1500)
out.openCaseLoopFalse = await sample('OpenCase', 0, false, 2200)
await sleep(1500)
out.sprayLoopFalse = await sample('SprayWater', 0, false, 1500)
await sleep(1500)
out.bubbleLoopFalse = await sample('BubbleGum', 0, false, 6000)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)