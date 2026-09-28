// 通用读口：在桌面端页面里跑一段表达式，把结果打回来（排查用）。
//
//   node tools/raw-query.mjs [cdpPort] "<表达式>"
const port = Number(process.argv[2] ?? 9401)
const expression = process.argv[3] ?? 'JSON.stringify({ url: location.href })'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) { console.error('CDP ' + port + ' 上没有页面'); process.exit(2) }
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const result = await new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
if (result?.exceptionDetails !== undefined) {
  console.error('页面里抛了：' + String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  process.exit(1)
}
const value = result?.result?.value
console.log(typeof value === 'string' ? value : JSON.stringify(value))
socket.close()
