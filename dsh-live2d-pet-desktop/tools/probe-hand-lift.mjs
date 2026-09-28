// **`phone5` 是不是"把手抬起来"** —— 只盯"手/手机"那几块 drawable。
//
// 前面几轮失败的原因：拿**全部 269 块**排序，爱心粒子一直在飘、位移永远最大，
// 真正的手机/手被埋在下面（我为此白查了好几轮）。这一版只盯 `看手机` + `手机色替换`。
//
// 三组对照：
//   ① 强制 `phone5 = -1`（原始曲线的起点量级）→ 记手的 y
//   ② 强制 `phone5 = 10`（峰值量级）        → 记手的 y，看有没有升
//   ③ 正常演一遍「自拍」，逐帧记**画面上的 `phone5`** 与手的 y，看两者是否同步
//
//   node tools/probe-hand-lift.mjs [--cdp 9401]
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

/** 帧内：每帧记"手/手机那几块的 y"与几个参数画面值，最后给时间序列。 */
const watch = (ms) => inPageAsync([
  'const api = window.__dshLive2dPet;',
  'const handIds = args.handIds;',
  'const series = [];',
  'let samples = 0;',
  'return new Promise(function (resolve) {',
  '  const started = performance.now();',
  '  function tick() {',
  '    samples += 1;',
  '    const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  '    const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  '    let top = null, bottom = null;',
  '    for (const row of rows) {',
  '      if (handIds.indexOf(String(row.id)) < 0) continue;',
  '      if (row.box === null || row.box === undefined) continue;',
  '      if (top === null || row.box.maxY > top) top = row.box.maxY;',
  '      if (bottom === null || row.box.minY < bottom) bottom = row.box.minY;',
  '    }',
  '    const read = (id) => { try { const v = api.drawn(id); return typeof v === "number" ? Number(v.toFixed(2)) : null; } catch (e) { return null; } };',
  '    series.push({ t: Math.round(performance.now() - started), top: top, bottom: bottom,',
  '      phone5: read("phone5"), phone4: read("phone4"), phone2: read("phone2"), group: api.currentGroup ? api.currentGroup() : null });',
  '    if (performance.now() - started < args.ms) requestAnimationFrame(tick);',
  '    else resolve({ samples: samples, series: series });',
  '  }',
  '  requestAnimationFrame(tick);',
  '});',
], { ms, handIds: ['ArtMesh26', 'ArtMesh27', 'ArtMesh28', 'ArtMesh29', 'ArtMesh30', 'ArtMesh31', 'ArtMesh41', 'ArtMesh42', 'ArtMesh43', 'ArtMesh44'] })

const setForce = (map) => inPage([
  'const api = window.__dshLive2dPet;',
  'if (typeof api.forceParams !== "function") return { error: "no-force-params" };',
  'api.forceParams(args.map);',
  'return { forced: args.map };',
], { map })

await inPage(['if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");', 'return true;'])
await sleep(800)

const summarize = (name, result) => {
  const withBox = result.series.filter((row) => row.top !== null)
  const tops = withBox.map((row) => row.top)
  const bottoms = withBox.map((row) => row.bottom)
  console.log('  ' + name + '：手/手机盒 y 最高 ' + Math.max(...tops) + '  最低 ' + Math.min(...bottoms)
    + '  跨度 ' + (Math.max(...tops) - Math.min(...bottoms)) + '（' + withBox.length + ' 帧有盒）')
  return { top: Math.max(...tops), bottom: Math.min(...bottoms) }
}

console.log('')
console.log('--- ① 强制 phone5 = -1（原始曲线起点量级）')
console.log('  ' + JSON.stringify(await setForce({ phone5: -1, phone2: 0 })))
await sleep(500)
const low = summarize('phone5=-1', await watch(2000))

console.log('')
console.log('--- ② 强制 phone5 = 10（原始曲线峰值量级）')
console.log('  ' + JSON.stringify(await setForce({ phone5: 10, phone2: 0 })))
await sleep(500)
const high = summarize('phone5=10', await watch(2000))

console.log('')
console.log('  → `phone5` -1 → 10 时，手/手机那块**上升了 ' + (high.bottom - low.bottom) + '**（模型空间 y）')
await setForce(null)
console.log('  已清除强制值')

// ③ 正常演一遍自拍，看画面上的 phone5 与手的 y 是否同步。
console.log('')
console.log('--- ③ 正常点「自拍」，逐帧看 画面上的 phone5 与手的 y')
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
await sleep(400)
const clicked = await inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const slot = root.querySelector("[data-panel] [data-slot=\\"selfie\\"]");',
  'if (slot === null) return { ok: false, reason: "no-slot" };',
  'const buttons = Array.from(slot.querySelectorAll("[data-chips] button"));',
  'const hit = buttons.find((b) => (b.textContent || "").trim() === "自拍");',
  'if (hit === undefined) return { ok: false, options: buttons.map((b) => b.textContent.trim()) };',
  'hit.click();',
  'return { ok: true };',
])
console.log('  点选：' + JSON.stringify(clicked))
const run = await watch(5000)
const rows = run.series.filter((row) => row.top !== null)
let peak5 = null
let peakTop = null
for (const row of rows) {
  if (row.phone5 !== null && (peak5 === null || row.phone5 > peak5)) peak5 = row.phone5
  if (peakTop === null || row.top > peakTop) peakTop = row.top
}
console.log('  画面上的 phone5 峰值 = ' + peak5 + '（原始文件峰值 9.71）')
console.log('  手/手机盒最高点 = ' + peakTop)
const atPeak = rows.filter((row) => row.phone5 !== null && row.phone5 > (peak5 - 0.5)).slice(0, 3)
for (const row of atPeak) console.log('    ' + row.t + 'ms  phone5=' + row.phone5 + '  手盒 top=' + row.top + '  ' + row.group)
// 时间序列抽样
console.log('  走势（每 200ms）：')
for (const row of rows.filter((_, index) => index % 12 === 0).slice(0, 25)) {
  console.log('    ' + String(row.t).padStart(5) + 'ms  手 top=' + row.top + '  phone5=' + row.phone5
    + '  phone4=' + row.phone4 + '  ' + row.group)
}
socket.close()
