// 摸头 vs 摸尾巴的**重叠**：现在还剩多少？
//
// 背景：路由曾经是"先判尾巴"，用户报"摸头出的是摸尾巴的效果"，于是改成"先判头"。
// 当时的实测是：尾鳍上 86.6% 的点**同时**算头（因为 11 个没显形的配件几何横跨全身）。
// 后来尾鳍按贴图收窄到 5 块，那个数字应该大幅下降 —— 到底降到多少，直接量。
//
// 判据（决定"先判谁"能不能安全地翻过来）：
//   * `只算尾巴` 的点越多、`两者都算` 的越少 → 翻成"先判尾巴"越安全；
//   * 反之则保持"先判头"。
//
//   node tools/probe-head-tail-overlap.mjs [--cdp 9401] [--grid 32]
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const GRID = Number(argOf('--grid', '32'))
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
  pending.set(id, (message) => resolve(message.result?.result?.value))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

async function inPage(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = 'JSON.stringify((function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })())'
  const raw = await evaluate(expression)
  return raw === undefined ? undefined : JSON.parse(raw)
}

// 多采几次取"每次都算"：尾鳍在摆，只在一瞬间重叠的点不算稳态重叠。
const SAMPLES = 5
const tally = new Map()
for (let pass = 0; pass < SAMPLES; pass += 1) {
  const one = await inPage([
    'const api = window.__dshLive2dPet;',
    'const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
    'const rect = stage.getBoundingClientRect();',
    'const N = args.grid;',
    'const head = [], tail = [];',
    'for (let gy = 0; gy < N; gy += 1) {',
    '  for (let gx = 0; gx < N; gx += 1) {',
    '    const x = rect.left + rect.width * (gx + 0.5) / N;',
    '    const y = rect.top + rect.height * (gy + 0.5) / N;',
    // ⚠️ API 上的 `hitsHead/hitsTail` 收的是**舞台局部**坐标（组件那层替我们减了 rect）。
    // 直接喂 client 坐标会一律返回 false —— 第一版就是这么量出"1024 格全都不算"的。
    '    const lx = x - rect.left, ly = y - rect.top;',
    '    let h = false, t = false;',
    '    try { h = api.hitsHead(lx, ly) === true; } catch (e) { h = false; }',
    '    try { t = api.hitsTail(lx, ly) === true; } catch (e) { t = false; }',
    '    head.push(h ? 1 : 0);',
    '    tail.push(t ? 1 : 0);',
    '  }',
    '}',
    'return { head: head, tail: tail };',
  ], { grid: GRID })
  if (one === undefined || !Array.isArray(one.head)) {
    console.error('页面没给出判定（返回：' + JSON.stringify(one) + '）')
    process.exit(2)
  }
  for (let i = 0; i < one.head.length; i += 1) {
    const previous = tally.get(i) ?? { head: 0, tail: 0 }
    previous.head += one.head[i]
    previous.tail += one.tail[i]
    tally.set(i, previous)
  }
  if (pass < SAMPLES - 1) await sleep(220)
}

let headOnly = 0
let tailOnly = 0
let both = 0
let neither = 0
for (const value of tally.values()) {
  const h = value.head === SAMPLES
  const t = value.tail === SAMPLES
  if (h && t) both += 1
  else if (h) headOnly += 1
  else if (t) tailOnly += 1
  else neither += 1
}
const model = headOnly + tailOnly + both
console.log('网格 ' + GRID + '×' + GRID + '，取 ' + SAMPLES + ' 次都成立的点：')
console.log('  只算头   ' + headOnly)
console.log('  只算尾巴 ' + tailOnly)
console.log('  **两者都算** ' + both)
console.log('  都不算   ' + neither)
console.log('')
console.log('  落在角色上、同时算头尾的点占' + (model === 0 ? '?' : Math.round((both / model) * 100) + '%')
  + '（作者换路由时那个数字是 86.6%）')
console.log('')
console.log(tailOnly >= both
  ? '  ⇒ 只算尾巴的点**不少于**重叠点：改成"先判尾巴"是安全的（可见尾鳍上的点大多只算尾巴）'
  : '  ⇒ 重叠点仍多于"只算尾巴"的点：翻成"先判尾巴"会把重叠区都判成摸尾巴，可能回退作者修过的问题')
socket.close()
process.exit(0)
