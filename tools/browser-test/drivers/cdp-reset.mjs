import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9429
const PROFILE = join(PROFILES, '_cdp-reset')
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
const IDS = '["chuipaopao","phone","phone2","pengshui"]'
const readExpr = 'JSON.stringify((() => { const c = window.__PET_DBG.model.internalModel.coreModel; const raw = c._model.parameters; const out = {}; for (const id of ' + IDS + ') { const i = Array.from(raw.ids).indexOf(id); out[id] = { i, v: +raw.values[i].toFixed(3), def: raw.defaultValues[i], idType: c._parameterIds && c._parameterIds.at ? String(typeof c._parameterIds.at(i)) : "n/a" } } return out })())'
console.log('index mapping + defaults:', await ev(readExpr))
// Play BubbleGum non-looping, then force the params back to default while the
// model keeps rendering, and see whether the value sticks.
await ev('window.__PET_DBG.model.motion("BubbleGum",0,3,{loop:false}).then(()=>1)')
await sleep(5600)
console.log('after bubble (loop:false):', await ev(readExpr))
const applied = await ev('(() => { const c = window.__PET_DBG.model.internalModel.coreModel; const raw = c._model.parameters; const out = {}; for (const id of ' + IDS + ') { const i = Array.from(raw.ids).indexOf(id); if (i < 0) { out[id] = "NOID"; continue } const idObj = c._parameterIds.at(i); c.setParameterValueById(idObj, raw.defaultValues[i]); out[id] = "set->" + raw.defaultValues[i] } return JSON.stringify(out) })()')
console.log('write result:', applied)
await sleep(1500)
console.log('after write +1.5s:', await ev(readExpr))
await sleep(2500)
console.log('after write +4s:', await ev(readExpr))
ws.close(); edge.kill(); process.exit(0)