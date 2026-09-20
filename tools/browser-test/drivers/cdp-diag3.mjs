import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9433
const PROFILE = join(PROFILES, '_cdp-diag3')
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
// (a) what does the engine consider the idle group, and what is the runtime loop flag?
console.log('motionManager groups:', await ev('JSON.stringify((()=>{const mm=window.__PET_DBG.model.internalModel.motionManager; return { idle: String(mm.groups.idle), keys: Object.keys(mm.groups) }})())'))
console.log('runtime defs keys:', await ev('JSON.stringify(Object.keys(window.__PET_DBG.model.internalModel.motionManager.definitions))'))
// Reset everything to default, then run ONLY OpenCase non-looping and watch it repeat.
const IDS = '["phone","phone2","phone4"]'
const readExpr = 'JSON.stringify((()=>{const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; const o={}; for(const id of ' + IDS + '){const i=Array.from(raw.ids).indexOf(id); o[id]=+raw.values[i].toFixed(3)} return o})())'
await ev('(()=>{const c=window.__PET_DBG.model.internalModel.motionManager; c.stopAllMotions(); return 1})()')
await sleep(600)
console.log('before:', await ev(readExpr))
await ev('window.__PET_DBG.model.motion("OpenCase",0,3,{loop:false}).then(()=>1)')
const series = []
for (let i = 0; i < 24; i++) { series.push({ t: i * 250, v: await ev(readExpr) }); await sleep(250) }
console.log('open-case loop:false over 6s:')
for (const s of series.filter((_, i) => i % 2 === 0)) console.log('   t=' + String(s.t).padStart(5) + ' ' + s.v)
ws.close(); edge.kill(); process.exit(0)