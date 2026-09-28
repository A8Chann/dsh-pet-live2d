// 一次性质询：哪些 drawable 属于"手/手臂"部件（用来把测量范围收窄）。
//
// 前面几轮失败的原因：我拿**全部 269 块 drawable** 排序，而爱心粒子一直在飘，
// 位移永远最大，真正的手臂被埋在下面。必须先把范围收到"手/臂"那几块。
import { join } from 'node:path'

const CDP = Number(process.argv[2] ?? 9401)
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

const out = await inPage([
  'const api = window.__dshLive2dPet;',
  'const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  'const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  'const byName = {};',
  'for (const row of rows) {',
  '  const name = String(row.partName ?? "");',
  '  if (!/手|臂/.test(name)) continue;',
  '  if (byName[name] === undefined) byName[name] = [];',
  '  byName[name].push({ id: String(row.id), box: row.box });',
  '}',
  'return byName;',
])
console.log('名字含"手/臂"的部件，以及各自的 drawable：')
for (const [name, list] of Object.entries(out)) {
  console.log('  ' + name + '（' + list.length + ' 块）')
  for (const item of list.slice(0, 8)) {
    const box = item.box === null || item.box === undefined
      ? '(无盒)'
      : ('x ' + item.box.minX + '…' + item.box.maxX + '  y ' + item.box.minY + '…' + item.box.maxY)
    console.log('      ' + item.id.padEnd(14) + box)
  }
}
socket.close()
