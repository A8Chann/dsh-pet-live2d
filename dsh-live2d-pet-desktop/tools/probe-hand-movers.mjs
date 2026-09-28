// **哪个 drawable 是"右手"** —— 用位移找，不依赖部件名。
//
// `Part125/126`（cdi3 里的"手L/手R"）在这只模型里**不含任何 drawable**，所以按名字找拿不到。
// 换个办法：逐个 drawable 比较"待机"与"某个动作"的几何盒，**往上抬得最多的那批**就是手臂/手
// （手抬起来 = 盒子的 y 变大）。
//
//   node tools/probe-hand-movers.mjs [--cdp 9401]
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面')
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
    const failure = message.result?.exceptionDetails
    if (failure !== undefined) {
      resolve({ __error: String(failure.exception?.description ?? failure.text ?? 'threw') })
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

async function inPageAsync(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = '(function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })()'
  return await evaluate(expression)
}

/**
 * 在 `ms` 毫秒里**逐帧**记录每个 drawable 盒子的极值，最后返回"每个 drawable 见过的
 * 最高 maxY / 最低 minY"。帧内采样：抬手是瞬时的，外面抽样会漏（见 skill）。
 *
 * ⚠️ 必须走 `inPageAsync`（返回 promise 让 CDP 等）：套 `JSON.stringify` 会立刻返回 `{}`，
 * 表现就是"采样 undefined 帧"。
 */
const trackBoxes = (ms) => inPageAsync([
  'const api = window.__dshLive2dPet;',
  'const peak = {}, low = {};',
  'const groups = [];',
  'let samples = 0;',
  'return new Promise(function (resolve) {',
  '  const started = performance.now();',
  '  function tick() {',
  '    samples += 1;',
  '    const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  '    const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  '    for (const row of rows) {',
  '      if (row.box === null || row.box === undefined) continue;',
  '      const id = String(row.id);',
  '      const top = row.box.maxY, bottom = row.box.minY;',
  '      if (peak[id] === undefined || top > peak[id]) peak[id] = top;',
  '      if (low[id] === undefined || bottom < low[id]) low[id] = bottom;',
  '    }',
  '    const g = api.currentGroup ? api.currentGroup() : null;',
  '    if (g !== null && groups.indexOf(g) < 0) groups.push(g);',
  '    if (performance.now() - started < args.ms) requestAnimationFrame(tick);',
  '    else resolve({ peak: peak, low: low, groups: groups, samples: samples });',
  '  }',
  '  requestAnimationFrame(tick);',
  '});',
], { ms })

// 每个 drawable 的部件名（报告用）。
const nameOf = await inPage([
  'const api = window.__dshLive2dPet;',
  'const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  'const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  'const out = {};',
  'for (const row of rows) out[String(row.id)] = String(row.partName ?? "");',
  'return out;',
])

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
  'if (hit === undefined) return { ok: false, options: buttons.map((b) => b.textContent.trim()) };',
  'hit.click();',
  'return { ok: true };',
], { slot, label })

/** 两个姿势之间，每个 drawable 的"最低点抬升量"（>0 = 往上抬了）。 */
function lifters(before, after) {
  const rows = []
  for (const id of Object.keys(after.low)) {
    const was = before.low[id]
    const now = after.low[id]
    if (was === undefined || now === undefined) continue
    rows.push({ id, lift: now - was, topWas: before.peak[id], topNow: after.peak[id] })
  }
  rows.sort((a, b) => b.lift - a.lift)
  return rows
}

await openPanel()
const idle = await trackBoxes(2500)
console.log('待机采样 ' + idle.samples + ' 帧，组=' + JSON.stringify(idle.groups))

// **决定性对照**：直接命令引擎演 OpenCase（绕开槽位、前提、我的 prepend 逻辑）。
// 手抬起来 → 引擎和动作文件都没问题，问题在我的编排；还是抬不起来 → 问题在别处。
console.log('')
console.log('--- 直接命令引擎演 OpenCase（playGroup，绕开一切编排）')
const direct = await inPage([
  'const api = window.__dshLive2dPet;',
  'let played = null;',
  'try { played = api.playGroup("OpenCase", 0, { kind: "test" }); } catch (e) { played = "threw:" + String(e && e.message); }',
  'return { played: played, group: api.currentGroup ? api.currentGroup() : null };',
])
console.log('  playGroup 返回：' + JSON.stringify(direct))
const directBoxes = await trackBoxes(2500)
const directLift = lifters(idle, directBoxes).filter((row) => row.lift > 40).slice(0, 10)
console.log('  **往上抬的 drawable**（直接演 OpenCase vs 待机）：')
for (const row of directLift) {
  console.log('    ' + row.id.padEnd(14) + '抬起 ' + row.lift.toFixed(0).padStart(6)
    + '   最低点 ' + String(row.topWas) + ' → ' + String(row.topNow) + '   ' + (nameOf[row.id] ?? ''))
}

console.log('')
console.log('--- 点「掏出手机」（走槽位那条路）')
console.log('  点选：' + JSON.stringify(await clickSlot('rhand', '掏出手机')))
const phone = await trackBoxes(3000)
const groupSeen = await inPage([
  'const api = window.__dshLive2dPet;',
  'const el = document.querySelector("[data-dsh-live2d-pet]");',
  'return { intent: api.currentGroup ? api.currentGroup() : null, dataMotion: el === null ? null : el.getAttribute("data-motion"), dataPhase: el === null ? null : el.getAttribute("data-phase") };',
])
console.log('  读口：' + JSON.stringify(groupSeen))
const liftedByPhone = lifters(idle, phone).filter((row) => row.lift > 40).slice(0, 10)
console.log('  **往上抬最多的 drawable**（掏出手机 vs 待机）：')
for (const row of liftedByPhone) {
  console.log('    ' + row.id.padEnd(14) + '抬起 ' + row.lift.toFixed(0).padStart(6)
    + '   最低点 ' + String(row.topWas) + ' → ' + String(row.topNow) + '   ' + (nameOf[row.id] ?? ''))
}

console.log('')
console.log('--- 再点「自拍」')
console.log('  点选：' + JSON.stringify(await clickSlot('selfie', '自拍')))
const selfie = await trackBoxes(4000)
console.log('  组=' + JSON.stringify(selfie.groups))
const liftedBySelfie = lifters(idle, selfie).filter((row) => row.lift > 20).slice(0, 14)
console.log('  **往上抬最多的 drawable**（自拍 vs 待机）：')
for (const row of liftedBySelfie) {
  console.log('    ' + row.id.padEnd(14) + '抬起 ' + row.lift.toFixed(0).padStart(6)
    + '   最高点 ' + String(row.topWas).padStart(6) + ' → ' + String(row.topNow).padStart(6)
    + '   ' + (nameOf[row.id] ?? ''))
}

socket.close()
