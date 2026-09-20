import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9435
const PROFILE = join(PROFILES, '_cdp-vis')
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
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, 'vis-') + name + '.png', Buffer.from(s.result.data, 'base64'))
}
const shotCanvas = async (name) => {
  const url = await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL("image/png")')
  if (typeof url === 'string' && url.startsWith('data:image/png')) writeFileSync(join(SHOTS, 'vis-') + name + '.png', Buffer.from(url.split(',')[1], 'base64'))
}
const reset = async () => { await ev('(()=>{const mm=window.__PET_DBG.model.internalModel.motionManager; mm.stopAllMotions(); const em=mm.expressionManager; if(em) em.resetExpression(); return 1})()'); await sleep(700) }
// 1. baseline
await reset(); await sleep(900); await shotCanvas('0-baseline')
// 2. SprayWater alone (the reported no-op)
await reset(); await ev('window.__PET_DBG.model.motion("SprayWater",0,3,{loop:false}).then(()=>1)'); await sleep(200); await shotCanvas('1-spray-alone')
// 3. whale expression alone
await reset(); await ev('window.__PET_DBG.model.expression("头顶鲸").then(()=>1)'); await sleep(1200); await shotCanvas('2-whale-alone')
// 4. whale + spray
await ev('window.__PET_DBG.model.motion("SprayWater",0,3,{loop:false}).then(()=>1)'); await sleep(200); await shotCanvas('3-whale-spray')
// 5. plain expression check (the reported broken tab)
await reset(); await ev('window.__PET_DBG.model.expression("星星眼").then(()=>1)'); await sleep(1200); await shotCanvas('4-star-eyes')
await reset(); await ev('window.__PET_DBG.model.expression("墨镜").then(()=>1)'); await sleep(1200); await shotCanvas('5-sunglasses')
await reset(); await ev('window.__PET_DBG.model.expression("头顶鲸").then(()=>1)'); await sleep(1200); await shotCanvas('6-whale-only')
// 6. selfie with and without phone
await reset(); await ev('window.__PET_DBG.model.motion("SelfieQuick",0,3,{loop:false}).then(()=>1)'); await sleep(600); await shotCanvas('7-selfie-no-phone')
await reset(); await ev('window.__PET_DBG.model.motion("OpenCase",0,3,{loop:false}).then(()=>1)'); await sleep(1300); await shotCanvas('8-opencase-hold')
console.log('done')
ws.close(); edge.kill(); process.exit(0)