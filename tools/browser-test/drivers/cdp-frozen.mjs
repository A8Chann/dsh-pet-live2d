import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9439
const PROFILE = join(PROFILES, '_cdp-frozen')
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
// Freeze: stop the automator so nothing writes parameters any more.
await ev('(()=>{ window.__PET_DBG.model.automator.autoUpdate = false; const mm=window.__PET_DBG.model.internalModel.motionManager; mm.stopAllMotions(); return 1 })()')
await sleep(800)
const shotCanvas = async (name) => {
  const url = await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL("image/png")')
  writeFileSync(join(SHOTS, 'fr-') + name + '.png', Buffer.from(url.split(',')[1], 'base64'))
}
const setParams = (obj) => ev('(()=>{ const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; for (const [id,v] of Object.entries(' + JSON.stringify(obj) + ')) { const i=Array.from(raw.ids).indexOf(id); if(i>=0) raw.values[i]=v } return 1 })()')
// static render helper: force the internal model to redraw with current params
const redraw = async () => { await ev('(()=>{ const m=window.__PET_DBG.model; m.internalModel.update(16, m.internalModel.elapsedTime||0); return 1 })()'); await sleep(400) }
const reset = async () => { await setParams(Object.fromEntries(Array.from(await ev('Array.from(window.__PET_DBG.model.internalModel.coreModel._model.parameters.ids)')).map(id => [id, null]))); return 1 }
const defaults = async () => ev('(()=>{ const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; for(let i=0;i<raw.values.length;i++) raw.values[i]=raw.defaultValues[i]; return 1 })()')
await defaults(); await redraw(); await shotCanvas('0-baseline')
await defaults(); await setParams({ pengshui: 1 }); await redraw(); await shotCanvas('1-pengshui')
await defaults(); await setParams({ jingyu: 1 }); await redraw(); await shotCanvas('2-jingyu')
await defaults(); await setParams({ fangzhuoshang: 1 }); await redraw(); await shotCanvas('3-desk')
await defaults(); await setParams({ jingyu: 1, pengshui: 1 }); await redraw(); await shotCanvas('4-jingyu-pengshui')
await defaults(); await setParams({ jingyu: 1, fangzhuoshang: 1, pengshui: 1 }); await redraw(); await shotCanvas('5-all')
await defaults(); await setParams({ phone: 1 }); await redraw(); await shotCanvas('6-phone')
await defaults(); await setParams({ phone: 1, phone2: 1 }); await redraw(); await shotCanvas('7-phone-open')
console.log('done')
ws.close(); edge.kill(); process.exit(0)