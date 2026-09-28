// **摸鱼连打 160 次，看真实的抽签分布**（`cdp-head` 那条"分布"断言在套件里红过）。
//
// 判据取的是**客户端自己数的抽取记录**（`fidgetTally()`），不是抽样状态 ——
// 状态跨轮次会残留，拿它算比例会失真（测试文件里有这条教训）。
//
//   node tools/probe-fidget-distribution.mjs [--cdp 9401]
const port = Number(process.argv[2] ?? 9401)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) { console.error('CDP 上没有页面'); process.exit(2) }
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const ev = async (expression) => {
  const result = await new Promise((resolve) => {
    const id = ++seq
    pending.set(id, (message) => resolve(message.result))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  if (result?.exceptionDetails !== undefined) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return result?.result?.value
}

// 先清干净：相位 idle、清空当前选择（模拟"干净起点"）
await ev('window.__dshLive2dPet.phaseNow ? window.__dshLive2dPet.phaseNow("idle") : null')
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(600)

await ev('window.__dshLive2dPet.resetFidgetTally()')
for (let i = 0; i < 160; i += 1) {
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(45)
}
const tally = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.fidgetTally())'))
const drawn = tally.drawn ?? {}

console.log('fired = ' + tally.fired)
console.log('')
console.log('抽取分布（槽位:选项 → 次数）：')
const bySlot = new Map()
for (const [key, count] of Object.entries(drawn)) {
  const slot = key.split(':')[0]
  if (!bySlot.has(slot)) bySlot.set(slot, [])
  bySlot.get(slot).push([key, count])
}
for (const [slot, list] of bySlot) {
  const total = list.reduce((sum, [, count]) => sum + count, 0)
  list.sort((a, b) => b[1] - a[1])
  console.log('  ' + slot + '（共 ' + total + ' 次）：')
  for (const [key, count] of list) {
    console.log('      ' + key.padEnd(24) + String(count).padStart(4)
      + '  ' + (count / total * 100).toFixed(1) + '%')
  }
}

// rhand 的支配检查（和 cdp-head 同一条判据）
const rhand = (bySlot.get('rhand') ?? []).slice()
const rhandTotal = rhand.reduce((sum, [, count]) => sum + count, 0)
if (rhandTotal > 0) {
  const top = Math.max(...rhand.map(([, count]) => count))
  console.log('')
  console.log('rhand：最大占比 ' + (top / rhandTotal * 100).toFixed(1) + '%（阈值 60%）→ '
    + (top <= rhandTotal * 0.6 ? 'PASS' : 'FAIL'))
}
socket.close()
