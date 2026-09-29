// **走真实点击路径**驱动自拍，并读内部状态（`holdDebug` / `phone5`）。
//
// 为什么必须走点击：`playGroup()` 绕过选项系统 ⇒ `motionOptions` 根本不参与，
// 我先前用 playGroup 测 `holdParams` 是测错了对象。
//
//   node tools/probe-selfie-holdParams.mjs [--cdp 9401]
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

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
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result))
  socket.send(JSON.stringify({ id, method, params }))
})
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails !== undefined) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).split('\n')[0])
  return result?.result?.value
}
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}
const centerOf = (slotId, label) => ev(`(() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const slot = root.querySelector('[data-panel] [data-slot="${slotId}"]');
  if (slot === null) return JSON.stringify({ ok: false, why: 'no-slot' });
  const b = Array.from(slot.querySelectorAll('[data-chips] button')).find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
  if (b === undefined) return JSON.stringify({ ok: false, why: 'no-option' });
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`)

// 打开面板 → 装扮 → 掏出手机 → 自拍
await ev('(() => { const s = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]"); s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true })()')
await sleep(700)
const tab = JSON.parse(await ev('JSON.stringify((() => { const b = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button")).find((x) => (x.textContent || "").includes("装扮")); if (!b) return { ok: false }; const r = b.getBoundingClientRect(); return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })())'))
if (tab.ok) await realClick(tab.x, tab.y)

const phone = JSON.parse(await centerOf('rhand', '掏出手机'))
console.log('点「掏出手机」：' + JSON.stringify(phone))
if (phone.ok) await realClick(phone.x, phone.y)
await sleep(2600)
console.log('  掏手机后 holdDebug = ' + await ev('JSON.stringify(window.__dshLive2dPet.holdDebug())'))

const selfie = JSON.parse(await centerOf('selfie', '自拍'))
console.log('点「自拍」：' + JSON.stringify(selfie))
if (selfie.ok) await realClick(selfie.x, selfie.y)

// 自拍期间连续采样：内部表 + phone5 + drawn
console.log('')
console.log('自拍期间采样（每 300ms）：')
for (let i = 0; i < 14; i += 1) {
  await sleep(300)
  const state = JSON.parse(await ev(`JSON.stringify({
    hold: window.__dshLive2dPet.holdDebug(),
    phone5: (() => { try { const v = window.__dshLive2dPet.drawn('phone5'); return typeof v === 'number' ? Number(v.toFixed(2)) : null } catch (e) { return null } })(),
    group: window.__dshLive2dPet.currentGroup ? window.__dshLive2dPet.currentGroup() : null,
  })`))
  console.log('  ' + String((i + 1) * 300).padStart(5) + 'ms  group=' + String(state.group).padEnd(10)
    + ' holds=' + JSON.stringify(state.hold.holds)
    + '  probe=' + JSON.stringify(state.hold.probe ?? null)
    + '  phone5=' + state.phone5)
}
socket.close()
