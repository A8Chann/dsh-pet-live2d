// **`phone5` 到底让画面变了多少** —— 钉 0 与钉 10 两帧的整幅差异。
//
// 这个测法绕开了"手在哪一块"的所有猜测：不挑窗口、不算质心，只问
// "把这一条参数从 0 推到 10，屏幕上到底有没有东西在动、动了多少"。
//
//   node tools/probe-phone5-pixels.mjs [--cdp 9401]
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
  if (result?.exceptionDetails !== undefined) return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
  return result?.result?.value
}

// 抓整幅画布的像素（打包成 latin1 字符串回传）。
const grab = () => ev(`(function () {
  const canvas = document.querySelector('[data-dsh-live2d-pet] canvas');
  if (canvas === null) return 'ERR:no-canvas';
  const off = document.createElement('canvas');
  off.width = canvas.width; off.height = canvas.height;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return 'ERR:no-2d';
  ctx.clearRect(0, 0, off.width, off.height);
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, off.width, off.height).data;
  let s = '';
  const chunk = 8192;
  for (let i = 0; i < data.length; i += chunk) s += String.fromCharCode.apply(null, data.subarray(i, Math.min(i + chunk, data.length)));
  return off.width + 'x' + off.height + '|' + s;
})()`)

const hasForce = await ev('typeof window.__dshLive2dPet.forceParams')
console.log('forceParams 读口：' + hasForce)
if (hasForce !== 'function') {
  console.error('这份客户端里没有 `forceParams`（诊断专用读口）—— 需要它才能把参数钉住对照。')
  process.exit(2)
}

// 回待机，钉 phone5 = 0
await ev('window.__dshLive2dPet.phaseNow ? window.__dshLive2dPet.phaseNow("idle") : null')
await ev('window.__dshLive2dPet.forceParams({ phone5: 0 })')
await sleep(900)
const a = await grab()
await ev('window.__dshLive2dPet.forceParams({ phone5: 10 })')
await sleep(900)
const b = await grab()
await ev('window.__dshLive2dPet.forceParams(null)')

if (typeof a !== 'string' || typeof b !== 'string' || a.startsWith('ERR') || b.startsWith('ERR')) {
  console.error('抓帧失败：' + String(a).slice(0, 60) + ' / ' + String(b).slice(0, 60))
  process.exit(2)
}
const [size, pa] = a.split('|')
const [, pb] = b.split('|')
const bufA = Buffer.from(pa, 'latin1')
const bufB = Buffer.from(pb, 'latin1')
let changed = 0
let sumDelta = 0
const rows = new Map()
for (let i = 0; i + 3 < bufA.length; i += 4) {
  const d = Math.abs(bufA[i] - bufB[i]) + Math.abs(bufA[i + 1] - bufB[i + 1]) + Math.abs(bufA[i + 2] - bufB[i + 2])
  if (d > 40) {
    changed += 1
    sumDelta += d
    const pixel = i / 4
    const y = Math.floor(pixel / Number(size.split('x')[0]))
    rows.set(y, (rows.get(y) ?? 0) + 1)
  }
}
console.log('画布 ' + size)
console.log('`phone5` 0 → 10 时变化像素：' + changed + ' / ' + (bufA.length / 4)
  + '（' + (changed / (bufA.length / 4) * 100).toFixed(1) + '%），平均色差 ' + (changed === 0 ? 0 : Math.round(sumDelta / changed)))
if (changed > 0) {
  const sorted = Array.from(rows.entries()).sort((x, y) => y[1] - x[1]).slice(0, 6)
  console.log('变化最集中的行（canvas y → 舞台 y，除以 2）：')
  for (const [y, count] of sorted) console.log('    canvas ' + y + '（舞台 ' + Math.round(y / 2) + '）  ' + count + ' 像素')
}
socket.close()
process.exit(changed > 0 ? 0 : 1)
