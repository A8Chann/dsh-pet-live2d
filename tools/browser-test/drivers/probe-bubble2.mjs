// 探针二：停掉自动刷新，手动逐帧推进。
//
// 探针一已经证明：还原写在 saveParameters 钩子内确实落地了
// （probe: {id:"chuipaopao", pre:1, post:0}），但从帧外读到的仍是 1。
// 于是只剩两种可能：要么帧内还有第二个写入者在我们之后把它写回 1，
// 要么「帧外读到的数组」和「钩子写的数组」不是同一个。
// 关掉 ticker 之后帧只在我们的指令下推进，这两种可能可以分开。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
import { waitReady, openPanel } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9478
const PROFILE = join(PROFILES, '_probe-bubble2')
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

const snap = async (tag) => {
  const v = await ev('(() => { const raw = window.__PET_DBG.model.internalModel.coreModel._model.parameters;'
    + ' const i = Array.from(raw.ids).indexOf("chuipaopao"); return +raw.values[i].toFixed(3) })()')
  const dbg = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.releaseDebug())'))
  const num = (x) => (typeof x === 'number' ? x.toFixed(3) : String(x))
  console.log(tag.padEnd(30) + ' 读=' + String(v).padEnd(6)
    + ' calls(save/load/update)=' + dbg.hookCalls + '/' + dbg.loadCalls + '/' + dbg.updateCalls
    + ' rel=' + String(dbg.release).padEnd(5) + ' relSample=' + String(dbg.releaseSample).padEnd(5)
    + '\n' + ' '.repeat(32)
    + ' seam[' + dbg.seamAt + '] pre=' + num(dbg.probe && dbg.probe.pre)
    + ' post=' + num(dbg.probe && dbg.probe.post)
    + ' afterLoad=' + num(dbg.loadSample)
    + ' afterUpdate=' + num(dbg.updateSample)
    + ' 顺序=' + dbg.seamOrder)
  return { v, dbg }
}

// 身份检查：钩子里的 core 和 __PET_DBG.core 是不是同一个对象，values 是不是同一个数组。
const sameCore = await ev('JSON.stringify((() => {'
  + ' const a = window.__dshLive2dPet.coreIdentity();'
  + ' const b = window.__PET_DBG.model.internalModel.coreModel;'
  + ' return { same: a === b,'
  + '   sameValues: a && b ? a._model.parameters.values === b._model.parameters.values : null,'
  + '   aAt155: a ? a._model.parameters.values[155] : null,'
  + '   bAt155: b ? b._model.parameters.values[155] : null } })())')
console.log('identity: ' + sameCore)
console.log('stage children with internalModel: ' + await ev('window.__PET_DBG.app.stage.children.filter((c) => c.internalModel !== undefined).length'))

// 关掉自动刷新，之后的帧只由 step() 产生。
await ev('window.__PET_DBG.model.automator.autoUpdate = false')
await sleep(600)
const step = (n) => ev('(() => { const im = window.__PET_DBG.model.internalModel;'
  + ' for (let i = 0; i < ' + n + '; i++) { im.elapsedTime = (im.elapsedTime || 0) + 16; im.update(16, im.elapsedTime) }'
  + ' return im.elapsedTime })()')

await snap('A 关 ticker 后（未推帧）')
await step(3); await sleep(150)
await snap('B 推 3 帧')

// 面板选 吹泡泡糖
await openPanel(ev); await sleep(700)
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
  + '; if (!b) return "NOBTN"; b.click(); return "OK" })()')

console.log('click 吹泡泡糖 -> ' + (await clickMouth('吹泡泡糖')))
await step(3); await sleep(150)
await snap('C 选泡泡糖 + 3 帧')
await step(40); await sleep(150)
await snap('D 选泡泡糖 + 40 帧')

console.log('click 无 -> ' + (await clickMouth(null)))
// 推帧和读数放进同一次 eval：两者之间不可能再插进任何东西。
const stepAndRead = (n) => ev('(() => { const im = window.__PET_DBG.model.internalModel;'
  + ' for (let i = 0; i < ' + n + '; i++) { im.elapsedTime = (im.elapsedTime || 0) + 16; im.update(16, im.elapsedTime) }'
  + ' const raw = im.coreModel._model.parameters;'
  + ' const j = Array.from(raw.ids).indexOf("chuipaopao");'
  + ' return +raw.values[j].toFixed(3) })()')
console.log('  同一次 eval 内推 1 帧后立刻读 = ' + (await stepAndRead(1)))
await snap('E 切无 + 1 帧')
console.log('  同一次 eval 内再推 1 帧后立刻读 = ' + (await stepAndRead(1)))
await snap('E2 切无 + 2 帧')
await step(5); await sleep(150)
await snap('F 切无 + 6 帧')
await step(50); await sleep(150)
await snap('G 切无 + 56 帧')

// 恢复自动刷新，看值会不会被写回去
await ev('window.__PET_DBG.model.automator.autoUpdate = true')
await sleep(2000)
await snap('H 恢复 ticker + 2s')

ws.close(); edge.kill(); await sleep(300); process.exit(0)
