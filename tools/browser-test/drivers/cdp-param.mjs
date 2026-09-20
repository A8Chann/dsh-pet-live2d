import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9425
const PROFILE = join(PROFILES, '_cdp-param')
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
const IDS = ["chuipaopao","chuipaopao2","chuipaopao3","chuipaopao4","chuipaopao7","pengshui","phone","phone2","phone3","phone4","phone6","pointZ2","ParamMouthForm","ParamMouthOpenY","ParamAngleX"]
const readExpr = 'JSON.stringify((() => { const core = window.__PET_DBG.core; const raw = core._model.parameters; const out = {}; for (const id of ' + JSON.stringify(IDS) + ') { const i = Array.from(raw.ids).indexOf(id); out[id] = i < 0 ? "NOID" : +raw.values[i].toFixed(3) } return out })())'
const read = () => ev(readExpr)
const motion = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
const out = {}
out.atRest = JSON.parse(await read())
const plan = [["BubbleGum","bubble"],["SprayWater","spray"],["OpenCase","opencase"],["Selfie","selfie"]]
for (const pair of plan) {
  const group = pair[0], label = pair[1]
  await ev('window.__dshLive2dPet.playOnce(' + JSON.stringify(group) + ', 0, { kind: "panel" })')
  await sleep(1200)
  out[label + '_during'] = JSON.parse(await read())
  for (let i = 0; i < 40; i++) { await sleep(500); if (await motion() === 'idle') break }
  await sleep(2500)
  out[label + '_after'] = JSON.parse(await read())
}
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)