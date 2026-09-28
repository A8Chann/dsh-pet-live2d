// **可摸区域 vs 判定区域**：把舞台铺成网格，逐点同时问两件事。
//
// 用户报"右下角有一大片奇怪的可触摸区域，那里明明什么都没有"。这种事读代码猜不出来
// （轮廓是一段几何、尾巴矩形是另一段，叠在同一个 `clip-path` 里），所以直接把**形状**采出来：
//
//   ① `document.elementFromPoint()` —— 它**跟着 `clip-path`** 走，回答"这里能不能摸到"
//      （这正是穿透判定问的那个问题）；
//   ② `window.__dshLive2dPet.hitsMask(x, y, w, h)` —— 判定认为这里算不算她；
//   ③ `hitsMaskStatic(...)` —— **去掉尾巴那一块**的判定。
//
// ②③ 一比就知道那片空白是谁带来的。三种格子：
//
//   `#` 能摸 + 轮廓算她            正常
//   `T` 能摸 + **只有尾巴盒**算她   ← 尾巴矩形带来的；它落在空白处就是用户报的那片
//   `?` 能摸、判定却不算她         摸到但没反应（遮罩比判定松）
//   `+` 判定算她、却摸不到         看得见摸不到
//
//   node tools/probe-hit-area.mjs [--cdp 9401] [--grid 26]
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const GRID = Number(argOf('--grid', '26'))
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
  console.error('CDP ' + CDP + ' 上没有页面（先带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
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

/**
 * 在页面里跑一段函数体。
 *
 * **不用模板字符串拼代码**：这一段要读好几处 `clip-path` / 读口，拼字符串时反引号会打架
 * （这一轮为此白折腾了好几轮）。改成把函数体写成普通参数的字符串数组，用 `new Function` 在
 * 页面里装起来 —— 参数走 JSON，代码里一个反引号都不需要。
 */
async function inPage(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = 'JSON.stringify((function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })())'
  const raw = await evaluate(expression)
  return raw === undefined ? undefined : JSON.parse(raw)
}

const geometry = await inPage([
  'const el = document.querySelector("[data-dsh-live2d-pet]");',
  'if (el === null) return { error: "no-pet-root" };',
  'const hit = el.querySelector("[data-hit]");',
  'const stage = el.querySelector("[data-stage]");',
  'const box = stage.getBoundingClientRect();',
  'const clip = hit === null ? "" : (getComputedStyle(hit).clipPath || "");',
  'const api = window.__dshLive2dPet;',
  'const path = (api && typeof api.maskPath === "function") ? String(api.maskPath() || "") : "";',
  'const numbers = [];',
  'const parts = path.split(/[^0-9.\\-]+/);',
  'for (const part of parts) { const n = Number(part); if (part !== "" && isFinite(n)) numbers.push(n); }',
  'let polyBox = null;',
  'if (numbers.length >= 4) {',
  '  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;',
  '  for (let i = 0; i + 1 < numbers.length; i += 2) {',
  '    x0 = Math.min(x0, numbers[i]); x1 = Math.max(x1, numbers[i]);',
  '    y0 = Math.min(y0, numbers[i + 1]); y1 = Math.max(y1, numbers[i + 1]);',
  '  }',
  '  polyBox = { x0: x0, x1: x1, y0: y0, y1: y1 };',
  '}',
  'return { stage: { w: Math.round(box.width), h: Math.round(box.height) },',
  '  clipLength: clip.length, polyPoints: Math.round(numbers.length / 2), polyBox: polyBox };',
])

console.log('舞台 ' + JSON.stringify(geometry.stage) + '   clip-path 长度 ' + geometry.clipLength)
console.log('轮廓多边形点数 ' + geometry.polyPoints + '  包围盒 ' + JSON.stringify(geometry.polyBox) + '（舞台百分比）')

// **多采几次取"总是可摸"**：这一层每 120ms 跟着尾鳍重算，只在某一瞬间可摸的格子不算
// "那片区域"（尾鳍摆过去而已）。稳定的那部分才是用户戳得到、且一直戳得到的地方。
const SAMPLES = 6
const SAMPLE_GAP_MS = 260
const passes = []
for (let pass = 0; pass < SAMPLES; pass += 1) {
  const grid = await inPage([
    'const el = document.querySelector("[data-dsh-live2d-pet]");',
    'const hit = el.querySelector("[data-hit]");',
    'const box = el.getBoundingClientRect();',
    'const api = window.__dshLive2dPet;',
    'const grid = args.grid;',
    'const cells = [];',
    'for (let gy = 0; gy < grid; gy += 1) {',
    '  const row = [];',
    '  for (let gx = 0; gx < grid; gx += 1) {',
    '    const px = box.left + (box.width * (gx + 0.5)) / grid;',
    '    const py = box.top + (box.height * (gy + 0.5)) / grid;',
    '    const top = document.elementFromPoint(px, py);',
    '    const touchable = hit !== null && top !== null && (top === hit || hit.contains(top));',
    '    const localX = px - box.left, localY = py - box.top;',
    '    let judged = null, statics = null;',
    '    try { judged = typeof api.hitsMask === "function" ? api.hitsMask(localX, localY, box.width, box.height) === true : null; } catch (e) { judged = null; }',
    '    try { statics = typeof api.hitsMaskStatic === "function" ? api.hitsMaskStatic(localX, localY, box.width, box.height) === true : null; } catch (e) { statics = null; }',
    '    row.push((touchable ? 1 : 0) | (judged === true ? 2 : 0) | (judged === true && statics === false ? 4 : 0));',
    '  }',
    '  cells.push(row);',
    '}',
    'return { cells: cells };',
  ], { grid: GRID })
  if (grid === undefined || !Array.isArray(grid.cells)) {
    console.error('页面没给出网格（返回：' + JSON.stringify(grid) + '）')
    process.exit(2)
  }
  passes.push(grid.cells)
  if (pass < SAMPLES - 1) await sleep(SAMPLE_GAP_MS)
}

// 逐格取"这几次里**每次都**可摸 / 每次都被算她 / 每次都是只有尾巴盒算她"。
const grid = { cells: passes[0].map((row, gy) => row.map((_, gx) => {
  let touchAll = true
  let judgedAll = true
  let tailOnlyAll = true
  for (const pass of passes) {
    const cell = pass[gy][gx]
    if ((cell & 1) === 0) touchAll = false
    if ((cell & 2) === 0) judgedAll = false
    if ((cell & 4) === 0) tailOnlyAll = false
  }
  return (touchAll ? 1 : 0) | (judgedAll ? 2 : 0) | (judgedAll && tailOnlyAll ? 4 : 0)
}))}
console.log('（取 ' + SAMPLES + ' 次采样中**每次都成立**的格子；间隔 ' + SAMPLE_GAP_MS + 'ms）')

const CHAR = (cell) => {
  const touchable = (cell & 1) !== 0
  const judged = (cell & 2) !== 0
  const tailOnly = (cell & 4) !== 0
  if (touchable && tailOnly) return 'T'
  if (touchable && judged) return '#'
  if (touchable) return '?'
  if (judged) return '+'
  return '.'
}
console.log('')
console.log('# = 能摸+轮廓算她 ／ T = 能摸+**只有尾巴盒**算她 ／ ? = 能摸但判定不算 ／ + = 算她却摸不到')
console.log('')
let touchableButNotJudged = 0
let tailOnlyCells = 0
let judgedButNotTouchable = 0
for (const row of grid.cells) {
  let line = '  '
  for (const cell of row) {
    line += CHAR(cell) + ' '
    if ((cell & 1) !== 0 && (cell & 2) === 0) touchableButNotJudged += 1
    if ((cell & 4) !== 0) tailOnlyCells += 1
    if ((cell & 2) !== 0 && (cell & 1) === 0) judgedButNotTouchable += 1
  }
  console.log(line)
}
const total = grid.cells.length * grid.cells[0].length
console.log('')
console.log('  网格 ' + GRID + '×' + GRID + '（' + total + ' 格）')
console.log('  能摸但**判定不算她**：' + touchableButNotJudged + ' 格（摸了没反应）')
console.log('  **只有尾巴盒**算她：' + tailOnlyCells + ' 格（看上面的 T 落在哪儿）')
console.log('  判定算她却摸不到：' + judgedButNotTouchable + ' 格')
// **截图**：网格图告诉我们形状，截一张才知道"那片区域里到底有没有她"。
//
// 这一条是这轮最重要的工具：前面几轮我都在用几何推算"应该有/不该有"，而用户看到的是像素。
const shot = await evaluate('1')
void shot
const { mkdirSync, writeFileSync } = await import('node:fs')
const { dirname } = await import('node:path')
const shotPath = join(DESKTOP, '.run', 'hit-area.png')
const captured = await new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result))
  socket.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
if (typeof captured?.data === 'string') {
  mkdirSync(dirname(shotPath), { recursive: true })
  writeFileSync(shotPath, Buffer.from(captured.data, 'base64'))
  console.log('  截图：' + shotPath)
} else {
  console.log('  截图失败：' + JSON.stringify(captured).slice(0, 120))
}
socket.close()
process.exit(touchableButNotJudged === 0 ? 0 : 1)
