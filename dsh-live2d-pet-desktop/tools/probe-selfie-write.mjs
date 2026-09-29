// **自拍播放中**，强行写 `phone5` 看它能不能留下（区分"曲线在写"与"回放层在压"）。
//
// 上一版探针把它和 `playIdle()` 一起做，于是 `currentEntry` 是 Idle ——
// `ignoreKeptParams` 是 Selfie 的选项，压回去是必然的，测出来 0 毫无意义。
// 这里严格在自拍播放期间测。
//
//   node tools/probe-selfie-write.mjs [--cdp 9401]
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
  if (result?.exceptionDetails !== undefined) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).split('\n')[0])
  return result?.result?.value
}
const drawn = async (id) => ev('(() => { try { const v = window.__dshLive2dPet.drawn(' + JSON.stringify(id) + '); return typeof v === "number" ? Number(v.toFixed(3)) : null } catch (e) { return null } })()')

console.log('当前动作组（开始前）：' + await ev('(() => { const s = window.__dshLive2dPet.slotSelections ? window.__dshLive2dPet.slotSelections() : {}; return JSON.stringify(s) })()'))

// 用真实路径：先选「掏出手机」，再播自拍
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(400)
const picked = await ev(`(() => {
  const api = window.__dshLive2dPet;
  if (typeof api.chooseSlotOption !== 'function') return 'no-chooseSlotOption';
  api.chooseSlotOption('rhand', '掏出手机');
  return 'ok';
})()`)
console.log('选「掏出手机」：' + picked)
await sleep(2600)
console.log('掏手机后 phone5 = ' + await drawn('phone5') + '   phone = ' + await drawn('phone'))

await ev('window.__dshLive2dPet.playGroup("Selfie", 0, { kind: "panel" })')
await sleep(1500)
console.log('')
console.log('自拍播放中：phone5 = ' + await drawn('phone5'))

// 播放期间强写 phone5，看能不能留住
await ev('window.__dshLive2dPet.forceParams({ phone5: 10 })')
await sleep(400)
const during = await drawn('phone5')
console.log('强写 10 之后 400ms：phone5 = ' + during + (Number(during) > 9.5 ? '  ⇒ **留住了**（没人压它）' : '  ⇒ 被压回去了（有别的层在写它）'))

// 同样测 phone4 / phone6，看是不是它们被压
for (const id of ['phone4', 'phone6', 'phone2', 'phone3', 'phone']) {
  const before = await drawn(id)
  await ev('window.__dshLive2dPet.forceParams({' + JSON.stringify(id) + ': 7 })')
  await sleep(350)
  const after = await drawn(id)
  console.log('  ' + id.padEnd(8) + ' 原值 ' + String(before).padStart(8) + ' → 强写 7 后 ' + String(after).padStart(8)
    + (after !== null && Math.abs(Number(after) - 7) < 0.6 ? '   留住了' : '   被覆盖'))
}
await ev('window.__dshLive2dPet.forceParams(null)')
socket.close()
