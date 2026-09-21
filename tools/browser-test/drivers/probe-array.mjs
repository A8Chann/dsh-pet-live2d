// 微探针：到底能不能从帧外写进 / 读回 core._model.parameters.values。
//
// 上一个探针给出了自相矛盾的结果：钩子里 afterUpdate 明明是 0，
// 同一帧结束后从帧外读同一个下标却是 1。这个探针只做最小往返测试。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9479
const PROFILE = join(PROFILES, '_probe-array')
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
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'THREW: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  return r.result?.result?.value
}
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)
await ev('window.__PET_DBG.model.automator.autoUpdate = false')
await sleep(600)

const P = 'window.__PET_DBG.model.internalModel.coreModel'
console.log('表结构:', await ev('JSON.stringify((() => { const raw = ' + P + '._model.parameters;'
  + ' return { ids: raw.ids.length, values: raw.values.length,'
  + '   kind: Object.prototype.toString.call(raw.values), ctor: raw.values.constructor && raw.values.constructor.name,'
  + '   keys: Object.keys(raw).slice(0, 12),'
  + '   idSample: Array.from(raw.ids).slice(0, 3), idType: typeof Array.from(raw.ids)[0] } })())'))

console.log('存下数组引用:', await ev('(() => { window.__A1 = ' + P + '._model.parameters; window.__A2 = window.__A1.values; return Array.from(window.__A1.ids).indexOf("chuipaopao") })()'))
console.log('跨 eval 同一性:', await ev('JSON.stringify({ params: ' + P + '._model.parameters === window.__A1,'
  + ' values: ' + P + '._model.parameters.values === window.__A2 })'))
console.log('往返写读(同一次 eval):', await ev('JSON.stringify((() => { const raw = ' + P + '._model.parameters;'
  + ' const i = Array.from(raw.ids).indexOf("chuipaopao"); const before = raw.values[i];'
  + ' raw.values[i] = 0.5; const after = raw.values[i];'
  + ' return { i, before, after, viaSaved: window.__A2[i] } })())'))
await sleep(200)
console.log('下一次 eval 读同一格:', await ev('JSON.stringify((() => { const raw = ' + P + '._model.parameters;'
  + ' const i = Array.from(raw.ids).indexOf("chuipaopao");'
  + ' return { i, v: raw.values[i], viaSaved: window.__A2[i], sameArr: raw.values === window.__A2 } })())'))
await sleep(1200)
console.log('等 1.2s 后再读:', await ev('JSON.stringify((() => { const raw = ' + P + '._model.parameters;'
  + ' const i = Array.from(raw.ids).indexOf("chuipaopao"); return { i, v: raw.values[i] } })())'))

ws.close(); edge.kill(); await sleep(300); process.exit(0)
