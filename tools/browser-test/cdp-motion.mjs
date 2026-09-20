import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9441
const PROFILE = join(PROFILES, '_cdp-motion')
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
const IDS = ["chuipaopao","chuipaopao2","chuipaopao7","pengshui","jingyu","phone","phone2","phone4"]
const readExpr = 'JSON.stringify((()=>{const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; const o={}; for(const id of ' + JSON.stringify(IDS) + '){const i=Array.from(raw.ids).indexOf(id); o[id]=i<0?"NOID":+raw.values[i].toFixed(2)} return o})())'
const read = async () => JSON.parse(await ev(readExpr))
const motion = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
const opt = (g) => ev('JSON.stringify(window.__dshLive2dPet.optionsFor(' + JSON.stringify(g) + '))')
const out = {}
out.declaredOptions = { OpenCase: JSON.parse(await opt('OpenCase')), Selfie: JSON.parse(await opt('Selfie')), SprayWater: JSON.parse(await opt('SprayWater')), BubbleGum: JSON.parse(await opt('BubbleGum')) }
await ev('window.__dshLive2dPet.playIdle()'); await sleep(1200)
out.rest = await read()
// (1) bubble gum must NOT leave the mouth inflated
await ev('window.__dshLive2dPet.playOnce("BubbleGum",0,{kind:"panel"})')
await sleep(1500); out.bubbleDuring = await read()
for (let i=0;i<30;i++){ await sleep(500); if (await motion() === 'idle') break }
await sleep(1500); out.bubbleAfter = await read()
out.bubbleMouthRestored = out.bubbleAfter.chuipaopao === out.rest.chuipaopao && out.bubbleAfter.chuipaopao2 === out.rest.chuipaopao2
// (2) spray water must show the whale and then clean up
await ev('window.__dshLive2dPet.playOnce("SprayWater",0,{kind:"panel"})')
await sleep(300); out.sprayDuring = await read()
for (let i=0;i<30;i++){ await sleep(500); if (await motion() === 'idle') break }
await sleep(1500); out.sprayAfter = await read()
out.sprayPinsWhale = out.sprayDuring.jingyu === 1
out.sprayCleansUp = out.sprayAfter.jingyu === out.rest.jingyu && out.sprayAfter.pengshui === out.rest.pengshui
// (3) open case must HOLD the phone
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(1800); out.openDuring = await read()
await sleep(3000); out.openHeld = await read()
out.openCaseHolds = out.openHeld.phone > 0.5 && (await motion()) === 'OpenCase'
// (4) selfie must raise the phone first (prepend) then hold it in the pose
await ev('window.__dshLive2dPet.playOnce("SelfieQuick",0,{kind:"panel"})')
await sleep(700); out.selfieEarly = { state: await motion(), v: await read() }
await sleep(1400); out.selfieLate = { state: await motion(), v: await read() }
out.selfieRaisesPhone = out.selfieEarly.v.phone > 0.5 || out.selfieLate.v.phone > 0.5
await sleep(3500); out.selfieAfter = { state: await motion(), v: await read() }
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)