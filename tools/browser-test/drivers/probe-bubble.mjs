// 探针：吹泡泡糖「选 -> 无」两轮循环，逐步骤打印还原表与参数。
//
// 现象：第一轮能回到闭嘴（chuipaopao 1 -> 0），第二轮回不去（1 -> 1）。
// 本驱动把每一步之后的 releaseDebug() 与模型参数一起打出来，用来判断
// releasedOverrides 到底是「没装」「装了 0 但被覆盖」还是「装了 1」。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
import { waitReady, openPanel } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9477
const PROFILE = join(PROFILES, '_probe-bubble')
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
await waitReady(ev)

const IDS = ['chuipaopao', 'chuipaopao2', 'chuipaopao7', 'ParamMouthOpenY', 'ParamMouthForm']
const readExpr = 'JSON.stringify((() => {'
  + ' const raw = window.__PET_DBG.model.internalModel.coreModel._model.parameters;'
  + ' const out = {};'
  + ' for (const id of ' + JSON.stringify(IDS) + ') {'
  + '   const i = Array.from(raw.ids).indexOf(id); out[id] = i < 0 ? "NOID" : +raw.values[i].toFixed(3) }'
  + ' return out })())'
const snap = async (tag) => {
  const params = JSON.parse(await ev(readExpr))
  // 画面里的值（图层之后、帧尾 loadParameters 之前），和帧外读到的基线对照。
  params.drawn = await ev('window.__dshLive2dPet.drawn("chuipaopao")')
  params.drawn2 = await ev('window.__dshLive2dPet.drawn("chuipaopao2")')
  const dbg = await ev('JSON.stringify(window.__dshLive2dPet.releaseDebug())')
  const motion = await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
  const sel = await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())')
  const layers = await ev('window.__dshLive2dPet.expressionLayerCount()')
  const n = (x) => (typeof x === 'number' ? x.toFixed(2) : String(x))
  console.log(tag.padEnd(26)
    + ' 画面 chuipaopao=' + n(params.drawn).padEnd(5) + ' cp2=' + n(params.drawn2).padEnd(5)
    + ' | 帧外基线=' + n(params.chuipaopao).padEnd(5) + '/' + n(params.chuipaopao2).padEnd(5)
    + ' motion=' + String(motion).padEnd(11)
    + ' rel=' + String(dbg.release).padEnd(4) + ' relSample=' + n(dbg.releaseSample).padEnd(5)
    + ' heldSample=' + n(dbg.heldSample).padEnd(5) + ' slots=' + sel)
  return { params, dbg: JSON.parse(dbg), motion, layers }
}

// 打开面板 -> 装扮页
await openPanel(ev)
await sleep(700)
await ev('(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b = bs.find((x) => x.textContent.indexOf("装扮") === 0); if (b) b.click(); return !!b })()')
await sleep(700)

const clickMouth = (label) => ev('(() => {'
  + ' const g = document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="mouth"]\');'
  + ' if (!g) return "NOSLOT";'
  + ' const bs = Array.from(g.querySelectorAll("[data-chips] button"));'
  + ' const b = ' + (label === null
    ? 'bs.find((x) => !x.hasAttribute("data-slot-option"))'
    : 'bs.find((x) => x.textContent === ' + JSON.stringify(label) + ')')
  + '; if (!b) return "NOBTN:" + bs.map((x) => x.textContent).join("/");'
  + ' b.click(); return "OK" })()')

console.log('--- 面板已开，装扮页 ---')
await snap('0 初始')

for (const round of [1, 2, 3]) {
  console.log('--- 第 ' + round + ' 轮 ---')
  console.log('  click 吹泡泡糖 -> ' + (await clickMouth('吹泡泡糖')))
  await sleep(400); await snap('  R' + round + ' 选后 0.4s')
  await sleep(3000); await snap('  R' + round + ' 选后 3.4s')
  console.log('  click 无 -> ' + (await clickMouth(null)))
  await sleep(400); await snap('  R' + round + ' 无后 0.4s')
  await sleep(2000); await snap('  R' + round + ' 无后 2.4s')
}

ws.close(); edge.kill(); await sleep(300); process.exit(0)
