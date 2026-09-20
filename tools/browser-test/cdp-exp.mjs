// The merged 装扮 menu: every slot option must actually reach the model.
//
// This driver used to hash the canvas before and after a click and print
// whether it changed, then exit 0 unconditionally — so it asserted nothing, and
// its one signal was worthless anyway: the pet breathes and blinks, so no two
// frames are ever byte-identical and the hash always "changed". Between them,
// these two facts hid the state of the expression pipeline for several rounds.
//
// It now reads the parameter values the engine writes inside a frame, which is
// deterministic, and fails on a real mismatch.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9361
const PROFILE = join(PROFILES, '_cdp-exp')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map(); const reqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url
    if (u.includes('/api/live2d-pet/')) reqs.push(m.params.response.status + ' ' + u.replace(/^https?:\/\/[^/]+/, ''))
  }
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }

const WATCH = ["ParamCheek71","ParamCheek16","jingyu","ParamCheek70","ParamCheek83"]
const PROBE = "(() => {\n  const c = window.__PET_DBG.core\n  const names = [\"ParamCheek71\",\"ParamCheek16\",\"jingyu\",\"ParamCheek70\",\"ParamCheek83\"]\n  const ids = Array.from(c._model.parameters.ids)\n  window.__at = names.map((n) => ids.indexOf(n))\n  window.__last = null\n  const base = c.update.bind(c)\n  c.update = () => {\n    base()\n    window.__last = window.__at.map((i) => (i < 0 ? null : Number(c._model.parameters.values[i].toFixed(2))))\n  }\n  return true\n})()"
check('parameter probe installed', (await ev(PROBE)) === true)
const frame = async () => JSON.parse(await ev('JSON.stringify(window.__last)') ?? 'null')
const at = (values, name) => (values === null ? null : values[WATCH.indexOf(name)])

await openPanel(ev)
await sleep(700)
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(!b) return false; b.click(); return true})()')
await sleep(700)
// 表情 and 装扮 are one menu now: 14 slots, each with its options plus a
// "none" button.
const slots = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-slot]").length')
check('the merged menu renders every slot', slots === 14, 'slots=' + slots)

// Each chip must move the parameter its own .exp3.json declares.
for (const [label, param] of [["墨镜","ParamCheek71"],["星星眼","ParamCheek16"],["头顶鲸","jingyu"]]) {
  await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button"));'
    + ' const b=bs.find((x)=>x.textContent===' + JSON.stringify(label) + '); if(!b) return false; b.click(); return true})()')
  let seen = null
  for (let i = 0; i < 24; i += 1) {
    await sleep(250)
    const now = await frame()
    if (now !== null && at(now, param) === 1) { seen = now; break }
    seen = now
  }
  const pin = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())') ?? 'null')
  const layers = await ev('window.__dshLive2dPet.expressionLayerCount()')
  check('clicking ' + label + ' sets ' + param, at(seen, param) === 1,
    JSON.stringify(seen) + '  pinned=' + JSON.stringify(pin) + ' layers=' + layers)
  await ev('window.__dshLive2dPet.setExpressions([])')
  await sleep(600)
}

check('no failed plugin request', !reqs.some((r) => !r.startsWith('200')),
  JSON.stringify(reqs.filter((r) => !r.startsWith('200')).slice(0, 5)))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close(); edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
