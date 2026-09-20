import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9437
const PROFILE = join(PROFILES, '_cdp-spray')
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
const shotCanvas = async (name) => {
  const url = await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL("image/png")')
  writeFileSync(join(SHOTS, 'sp-') + name + '.png', Buffer.from(url.split(',')[1], 'base64'))
}
const freeze = async () => { await sleep(1100) }
const reset = async () => { await ev('(()=>{const mm=window.__PET_DBG.model.internalModel.motionManager; mm.stopAllMotions(); const c=mm.expressionManager; if(c) c.resetExpression(); return 1})()'); await sleep(700); await ev('(()=>{const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; for(let i=0;i<raw.values.length;i++) raw.values[i]=raw.defaultValues[i]; return 1})()'); await sleep(700) }
// Force pengshui to a fixed value with everything else at default, then shoot.
const setParam = (id, v) => ev('(()=>{const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; const i=Array.from(raw.ids).indexOf(' + JSON.stringify(id) + '); raw.values[i]=' + v + '; return i})()')
await reset(); await setParam('pengshui', 0); await freeze(); await shotCanvas('a-pengshui-0')
await reset(); await setParam('pengshui', 1); await freeze(); await shotCanvas('b-pengshui-1')
await reset(); await setParam('jingyu', 1); await freeze(); await shotCanvas('c-jingyu-1')
await reset(); await setParam('jingyu', 1); await setParam('pengshui', 1); await freeze(); await shotCanvas('d-both-1')
await reset(); await setParam('jingyu', 1); await setParam('fangzhuoshang', 1); await setParam('pengshui', 1); await freeze(); await shotCanvas('e-all-1')
console.log('done')
ws.close(); edge.kill(); process.exit(0)