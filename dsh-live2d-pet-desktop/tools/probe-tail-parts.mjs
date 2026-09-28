// 尾巴那一层**实际用到的名单**：部件、drawable、凸包点数。
//
// 尾巴名单由宿主按部件名挑（`尾|鳍|翅|翼`），而那只宠物有 15 个这样的部件 ——
// 狐狸尾 / 猫尾 / 狼尾 / 大翅膀…都是可换配件，同一时刻只有一个显形，其余几何留在原地。
// 这正是"包围盒/凸包框进一大片空白"的来源，所以先把名单看清再改。
//
//   node tools/probe-tail-parts.mjs [--cdp 9401]
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

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
  'if (typeof api.tailDebug !== "function") return { error: "no-tail-debug" };',
  // 原样带回来：先看它到底长什么样。别再按猜的字段名取 —— 连着两轮都是 undefined。
  'let raw = null;',
  'try { raw = api.tailDebug(); } catch (e) { return { error: "threw: " + String(e && e.message) }; }',
  'return { type: typeof raw, isArray: Array.isArray(raw), keys: raw === null ? null : Object.keys(raw), raw: raw };',
])
if (out === undefined || out.error !== undefined) {
  console.error('读不到：' + JSON.stringify(out))
  process.exit(2)
}
console.log('tailDebug() 返回：type=' + out.type + '  isArray=' + out.isArray + '  keys=' + JSON.stringify(out.keys))
console.log(JSON.stringify(out.raw, null, 1).slice(0, 2000))
socket.close()
