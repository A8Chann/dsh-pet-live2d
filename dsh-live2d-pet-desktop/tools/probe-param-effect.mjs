// **`phone2` 到底管画面上哪一块** —— 把它钉死在 0 / 1，看哪些 drawable 的几何跟着动。
//
// 为什么绕这么大圈：我按参数名猜过两轮（先 `phone`、后 `phone2`），都被用户纠正了
// （"我从来没说过手机的事儿……我的意思一直是右手没有抬起来"）。所以这次不猜：
// 用 `forceParams` 把候选参数逐帧写死，然后量**所有 drawable 的几何**，看谁跟着动。
//
//   node tools/probe-param-effect.mjs [--cdp 9401] [--param phone2]
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const PARAM = argOf('--param', 'phone2')
// 量程很重要：`phone5` 的原始曲线是 -4.43…9.99，拿 0→1 去试只走 7% 量程，
// 得到的位移小得看不出来（"量程搞错"是这个项目里反复出现的一类错）。
const FROM = Number(argOf('--from', '0'))
const TO = Number(argOf('--to', '1'))
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

/** 帧内量：钉住强制值之后，每个 drawable 盒子的极值（还带该 drawable 的部件名）。 */
const trackBoxes = (ms) => inPageAsync([
  'const api = window.__dshLive2dPet;',
  'const peak = {}, low = {}, names = {};',
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
  '      names[id] = String(row.partName ?? "");',
  '      const top = row.box.maxY, bottom = row.box.minY;',
  '      if (peak[id] === undefined || top > peak[id]) peak[id] = top;',
  '      if (low[id] === undefined || bottom < low[id]) low[id] = bottom;',
  '    }',
  '    if (performance.now() - started < args.ms) requestAnimationFrame(tick);',
  '    else resolve({ peak: peak, low: low, names: names, samples: samples });',
  '  }',
  '  requestAnimationFrame(tick);',
  '});',
], { ms })

const setForce = (value) => inPage([
  'const api = window.__dshLive2dPet;',
  'if (typeof api.forceParams !== "function") return { error: "no-force-params" };',
  'if (args.value === null) { api.forceParams(null); return { cleared: true }; }',
  'const map = {};',
  'map[args.param] = args.value;',
  'api.forceParams(map);',
  'return { forced: map };',
], { param: PARAM, value })

// 先切到待机、清掉槽位动作，免得动作每帧把我们钉的值覆盖…… 不会：强制值写在图层之后。
await inPage(['if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");', 'return true;'])
await sleep(800)

console.log('参数：' + PARAM + '，量程 ' + FROM + ' → ' + TO)
const zero = await setForce(FROM)
console.log('钉 ' + FROM + '：' + JSON.stringify(zero))
if (zero.error !== undefined) { console.error('这个版本没有 forceParams 读口'); process.exit(2) }
await sleep(400)
const low = await trackBoxes(2000)

const one = await setForce(TO)
console.log('钉 ' + TO + '：' + JSON.stringify(one))
await sleep(400)
const high = await trackBoxes(2000)

await setForce(null)
console.log('已清除强制值')

const rows = []
for (const id of Object.keys(high.low)) {
  const was = low.low[id]
  const now = high.low[id]
  if (was === undefined || now === undefined) continue
  rows.push({ id, lift: now - was, name: high.names[id] ?? '' })
}
rows.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift))
console.log('')
console.log('`' + PARAM + '` 0 → 1 时**位移最大**的 drawable：')
for (const row of rows.slice(0, 20)) {
  console.log('  ' + row.id.padEnd(14) + 'Δ最低点 ' + row.lift.toFixed(0).padStart(7) + '   ' + row.name)
}
console.log('')
console.log('位移 |Δ| > 20 的 drawable：' + rows.filter((row) => Math.abs(row.lift) > 20).length + ' / ' + rows.length)
socket.close()
