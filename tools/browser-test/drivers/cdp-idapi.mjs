import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9431
const PROFILE = join(PROFILES, '_cdp-idapi')
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
console.log('getParameterId(39):', await ev('JSON.stringify((()=>{const c=window.__PET_DBG.model.internalModel.coreModel; const id=c.getParameterId(39); return { type: typeof id, keys: Object.keys(id||{}), s: id && id.s, getString: typeof (id&&id.getString), str: id&&id.getString ? id.getString() : null }})())'))
console.log('getParameterDefaultValue(39):', await ev('String(window.__PET_DBG.model.internalModel.coreModel.getParameterDefaultValue(39))'))
console.log('roundtrip via id object:', await ev('JSON.stringify((()=>{const c=window.__PET_DBG.model.internalModel.coreModel; const id=c.getParameterId(39); const i=c.getParameterIndex(id); return { i, v: c.getParameterValueById(id) }})())'))
// Identify the params whose names match our targets, via the public API only.
console.log('name map sample:', await ev('JSON.stringify((()=>{const c=window.__PET_DBG.model.internalModel.coreModel; const n=c.getParameterCount(); const want=new Set(["phone","phone2","chuipaopao","pengshui","pointZ2"]); const out={}; for(let i=0;i<n;i++){ const id=c.getParameterId(i); const s=String(id&&id.getString?id.getString():id); if(want.has(s)) out[s]={ i, def: c.getParameterDefaultValue(i), v: c.getParameterValueByIndex(i) } } return out})())'))
ws.close(); edge.kill(); process.exit(0)