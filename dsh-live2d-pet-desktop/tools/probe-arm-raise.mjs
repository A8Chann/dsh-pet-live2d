// **在帧内逐帧采样**，量"举手"参数到底有没有抬起来。
//
// 为什么必须帧内：`drawn(id)` 给的是**上一帧 update() 那一刻**的值，而我们是**从外面**
// 每 60ms 读一次 —— 一只手的抬起/放下是瞬时的（实测 `phone2` 4ms 冲到 0.538 就回 0），
// 外面读必然采样到一堆 0。skill 里那条"帧外读到的是基线、不是画面"说的就是这个：
// 要描述画面，必须在帧内取样。
//
// 所以这里把采样器**装进页面**（`requestAnimationFrame`），跑 3 秒收每帧的值，
// 回来再看"每个参数到过的最大值"。
//
//   node tools/probe-arm-raise.mjs [--cdp 9401]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, ROOT } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 动作声明的参数：判据由**声明**决定，不靠猜。 */
function curvesFor(group) {
  const dir = join(ROOT, 'dsh-live2d-pet', 'pets', 'ds-whale-girl')
  const model3 = JSON.parse(readFileSync(join(dir, 'c_0120.model3.json'), 'utf8'))
  const entries = (model3.FileReferences?.Motions ?? {})[group]
  const file = (Array.isArray(entries) ? entries[0] : entries)?.File
  if (typeof file !== 'string') return []
  const motion = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  return (motion.Curves ?? []).map((curve) => String(curve.Id))
}
const openCaseParams = curvesFor('OpenCase')
const selfieParams = curvesFor('Selfie')
const armParams = Array.from(new Set(openCaseParams.concat(selfieParams)))
  .filter((id) => !/^Param(Angle|BodyAngle|Eye|Brow|Mouth)/.test(id))
console.log('OpenCase 声明：' + JSON.stringify(openCaseParams))
console.log('Selfie   声明（去掉头/脸那批）：' + JSON.stringify(selfieParams.filter((id) => !/^Param(Angle|BodyAngle|Eye|Brow|Mouth)/.test(id))))
console.log('要盯的参数：' + JSON.stringify(armParams))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面（带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
  process.exit(2)
}
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => {
    // 把异常也带出来：只取 `result.result.value` 时，页面里抛异常会静默变成 undefined
    // （这一轮在"帧内采样没拿到字符串：undefined"上白转了两圈）。
    const failure = message.result?.exceptionDetails
    if (failure !== undefined) {
      resolve({ __error: String(failure.exception?.description ?? failure.text ?? 'evaluate threw') })
      return
    }
    resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
async function inPage(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = 'JSON.stringify((function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })())'
  const raw = await evaluate(expression)
  return raw === undefined ? undefined : JSON.parse(raw)
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

async function openPanel() {
  await inPage(['if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");', 'return true;'])
  await sleep(700)
  await inPage([
    'const stage = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
    'stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
    'return true;',
  ])
  await sleep(500)
  await inPage([
    'const buttons = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));',
    'const tab = buttons.find((b) => (b.textContent || "").includes("装扮"));',
    'if (tab) tab.click();',
    'return true;',
  ])
  await sleep(500)
}
const clickSlot = (slot, label) => inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const group = root.querySelector("[data-panel] [data-slot=\\"" + args.slot + "\\"]");',
  'if (group === null) return { ok: false, reason: "no-slot" };',
  'const buttons = Array.from(group.querySelectorAll("[data-chips] button"));',
  'const hit = buttons.find((b) => (b.textContent || "").trim() === args.label);',
  'if (hit === undefined) return { ok: false, reason: "no-option", options: buttons.map((b) => (b.textContent || "").trim()) };',
  'hit.click();',
  'return { ok: true };',
], { slot, label })

/**
 * 页面里跑一段**会返回 promise** 的函数体。
 *
 * 和 `inPage` 的区别只有一个：**不套 `JSON.stringify`**。CDP 的 `awaitPromise: true`
 * 等的是"表达式求值出来的那个 promise"，外面套一层同步的 stringify 就变成
 * `'{}'`（第一版两次都是这么拿到 undefined/空对象的）。
 */
async function inPageAsync(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = '(function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })()'
  const raw = await evaluate(expression)
  if (raw !== null && typeof raw === 'object' && typeof raw.__error === 'string') {
    console.error('页面里抛了：' + raw.__error)
    process.exit(2)
  }
  return raw
}

/** **帧内采样**：装一个 `requestAnimationFrame` 采样器，收 `ms` 毫秒里每一帧的这些参数。 */
const sampleInFrames = (ids, ms) => inPageAsync([
  'const api = window.__dshLive2dPet;',
  'const list = args.ids;',
  'const peak = {}, low = {}, groups = [], changes = [];',
  'let frames = 0;',
  'let lastKey = null;',
  'for (const id of list) { peak[id] = null; low[id] = null; }',
  'return new Promise(function (resolve) {',
  '  const started = performance.now();',
  '  function tick() {',
  '    frames += 1;',
  '    const snapshot = {};',
  '    for (const id of list) {',
  '      let v = null;',
  '      try { v = api.drawn(id); } catch (e) { v = null; }',
  '      snapshot[id] = v;',
  '      if (typeof v !== "number") continue;',
  '      if (peak[id] === null || v > peak[id]) peak[id] = v;',
  '      if (low[id] === null || v < low[id]) low[id] = v;',
  '    }',
  '    let g = null;',
  '    try { g = api.currentGroup ? api.currentGroup() : null; } catch (e) { g = null; }',
  '    if (g !== null && groups.indexOf(g) < 0) groups.push(g);',
  // 每次变化记一行（含时刻）：这样才能看出"前置动作演了多久、什么时候塌的"。
  '    const key = g + "|" + list.map((id) => (snapshot[id] ?? "?").toFixed ? snapshot[id].toFixed(2) : "?").join(",");',
  '    if (key !== lastKey) {',
  '      lastKey = key;',
  '      changes.push({ t: Math.round(performance.now() - started), g: g, v: snapshot });',
  '    }',
  '    if (performance.now() - started < args.ms) requestAnimationFrame(tick);',
  '    else resolve({ peak: peak, low: low, frames: frames, groups: groups, changes: changes.slice(0, 30) });',
  '  }',
  '  requestAnimationFrame(tick);',
  '});',
], { ids, ms })

await openPanel()

// ---- A：单独点「掏出手机」 --------------------------------------------------
console.log('')
console.log('--- A：单独点「掏出手机」，帧内采样 3 秒')
const pickA = await clickSlot('rhand', '掏出手机')
check('点得到「掏出手机」', pickA.ok === true, JSON.stringify(pickA))
const a = await sampleInFrames(openCaseParams, 3000)
console.log('  采样 ' + a.frames + ' 帧，期间动作组：' + JSON.stringify(a.groups))
console.log('  峰值：' + JSON.stringify(a.peak))
console.log('  谷值：' + JSON.stringify(a.low))
check('「掏出手机」能把手抬起来（`phone2` 峰值 > 0.5）', (a.peak.phone2 ?? 0) > 0.5, 'phone2 峰值=' + a.peak.phone2)

// ---- B：点「自拍」（前提 = 掏出手机）----------------------------------------
console.log('')
console.log('--- B：点「自拍」，帧内采样 4 秒（含前置动作）')
const pickB = await clickSlot('selfie', '自拍')
check('点得到「自拍」', pickB.ok === true, JSON.stringify(pickB))
const b = await sampleInFrames(armParams, 4000)
console.log('  采样 ' + b.frames + ' 帧，期间动作组：' + JSON.stringify(b.groups))
console.log('  峰值：' + JSON.stringify(b.peak))
// **交接诊断**：分清"没交接"和"交接了错的值"（这一轮就靠它定位）。
const trace = await inPage([
  'const api = window.__dshLive2dPet;',
  'const carry = typeof api.carryTrace === "function" ? api.carryTrace() : null;',
  'const live = typeof api.liveFrames === "function" ? api.liveFrames() : null;',
  'const pick = (frame) => {',
  '  if (frame === null || frame === undefined) return null;',
  '  const out = {};',
  '  for (const id of ["phone", "phone2", "phone3", "phone4", "phone5", "phone6"]) if (id in frame) out[id] = Number(frame[id].toFixed(3));',
  '  return out;',
  '};',
  'return { carry: carry, openCaseLive: live === null ? null : pick(live.OpenCase), selfieLive: live === null ? null : pick(live.Selfie) };',
])
console.log('  交接记录：' + JSON.stringify(trace.carry))
console.log('  OpenCase 最新一帧：' + JSON.stringify(trace.openCaseLive))
console.log('  Selfie   最新一帧：' + JSON.stringify(trace.selfieLive))
console.log('  变化轨迹（时刻 / 组 / 值）：')
for (const step of b.changes.slice(0, 8)) {
  console.log('    ' + String(step.t).padStart(5) + 'ms  ' + String(step.g).padEnd(10) + '  ' + JSON.stringify(step.v))
}
check('自拍这段里 `phone2`（抬手臂）也抬起来了',
  (b.peak.phone2 ?? 0) > 0.5, 'phone2 峰值=' + b.peak.phone2)
check('自拍这段里动作组出现过 Selfie', b.groups.includes('Selfie'), JSON.stringify(b.groups))

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('ARM-RAISE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
