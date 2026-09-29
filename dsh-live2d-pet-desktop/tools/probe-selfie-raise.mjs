// **锁住"自拍抬手"这个修复**：动作声明 `holdParams` → 每帧写在 `update()` 之后 → 画面要变。
//
// 为什么要有这个 driver：这个 bug 我修坏过三次，每次都是"看起来改对了、实际没生效"；
// 而三次的判据都只是**读参数值**。参数在跑 ≠ 画面在动（曲线每帧写、回放层每帧写），
// 所以这里必须有**画面层面**的断言。
//
// 判据：
//   ① 走真实点击路径（`playGroup()` 会绕过选项系统，`motionOptions` 不参与 —— 测不到）；
//   ② 自拍期间内部表必须装上（`holdDebug().holds`）；
//   ③ 每帧写入必须真的执行（`probe.wrote === 10`，而不是被静默 catch 吞掉）；
//   ④ **画面**必须与"掏手机定格"有实质差异（像素级）；
//   ⑤ 动作结束必须松开（`holds === null`），不能留下永久钉住的状态。
//
//   node tools/probe-selfie-raise.mjs [--cdp 9401]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync, deflateSync } from 'node:zlib'
import { DESKTOP } from './paths.mjs'

const port = Number(process.argv[2] ?? 9401)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

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
const json = async (expression) => JSON.parse(await ev('JSON.stringify(' + expression + ')'))
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}
const centerOf = (slotId, label) => json(`(() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const slot = root.querySelector('[data-panel] [data-slot="${slotId}"]');
  if (slot === null) return { ok: false, why: 'no-slot' };
  const b = Array.from(slot.querySelectorAll('[data-chips] button')).find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
  if (b === undefined) return { ok: false, why: 'no-option' };
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`)

/** 抓她的盒子（2 倍放大）→ 解码后的像素 + 校验和。 */
async function grab() {
  const box = await json(`(() => { const el = document.querySelector('[data-dsh-live2d-pet]'); const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height } })()`)
  const captured = await send('Page.captureScreenshot', { format: 'png' })
  const png = Buffer.from(captured.data, 'base64')
  let at = 8, width = 0, height = 0, colorType = 0
  const idat = []
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9] }
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1
    const line = raw.subarray(pos, pos + stride); pos += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev === null ? 0 : prev[x]
      const c = prev === null || x < channels ? 0 : prev[x - channels]
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      out[x] = v & 0xff
    }
  }
  return { box, width, height, channels, pixels }
}

/** 把抓到的画面存成 PNG（放大 2 倍，便于人眼核对）。 */
function save(name, frame) {
  const zoom = 2
  const cw = Math.round(frame.box.w * zoom), chh = Math.round(frame.box.h * zoom)
  const outStride = cw * 3
  const outPixels = Buffer.alloc(chh * outStride)
  for (let y = 0; y < chh; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const sx = Math.round(frame.box.left + x / zoom), sy = Math.round(frame.box.top + y / zoom)
      const si = sy * frame.width * frame.channels + sx * frame.channels
      const di = y * outStride + x * 3
      outPixels[di] = frame.pixels[si]; outPixels[di + 1] = frame.pixels[si + 1]; outPixels[di + 2] = frame.pixels[si + 2]
    }
  }
  const rawOut = Buffer.alloc(chh * (outStride + 1))
  for (let y = 0; y < chh; y += 1) { rawOut[y * (outStride + 1)] = 0; outPixels.copy(rawOut, y * (outStride + 1) + 1, y * outStride, (y + 1) * outStride) }
  const crcTable = []
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crcTable[n] = c >>> 0 }
  const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0); return Buffer.concat([head, body, tail]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(cw, 0); ihdr.writeUInt32BE(chh, 4); ihdr[8] = 8; ihdr[9] = 2
  mkdirSync(join(DESKTOP, '.run'), { recursive: true })
  const file = join(DESKTOP, '.run', 'raise-' + name + '.png')
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rawOut)), chunk('IEND', Buffer.alloc(0))]))
  return file
}

// --- 0. 前置：动作必须声明 holdParams（宠物没声明就测不了）
const declared = await json(`(() => { const p = window.__dshLive2dPet; return { has: typeof p.holdDebug }; })()`)
check('客户端有 holdDebug 读口（否则无法验证内部表）', declared.has === 'function', String(declared.has))

// --- 1. 走真实点击：待机基准 → 掏出手机 → 自拍
await ev('window.__dshLive2dPet.playIdle ? window.__dshLive2dPet.playIdle() : null')
await sleep(1400)
const idleFrame = await grab()
save('idle', idleFrame)

await ev('(() => { const s = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]"); s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true })()')
await sleep(700)
const tab = await json(`(() => { const b = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button")).find((x) => (x.textContent || "").includes("装扮")); if (!b) return { ok: false }; const r = b.getBoundingClientRect(); return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
if (tab.ok) await realClick(tab.x, tab.y)
const phone = await centerOf('rhand', '掏出手机')
check('点得到「掏出手机」', phone.ok === true, JSON.stringify(phone))
if (phone.ok) await realClick(phone.x, phone.y)
await sleep(2400)
const phoneFrame = await grab()
save('0-phone', phoneFrame)

const selfie = await centerOf('selfie', '自拍')
check('点得到「自拍」', selfie.ok === true, JSON.stringify(selfie))
if (selfie.ok) await realClick(selfie.x, selfie.y)

// --- 2. 自拍期间：内部表 + 每帧写入 + 画面
let sawHolds = null
let sawWrite = null
let selfieFrame = null
let peakNote = ''
for (let i = 0; i < 26; i += 1) {
  await sleep(130)
  const state = await json(`(() => { const h = window.__dshLive2dPet.holdDebug(); const d = (() => { try { const v = window.__dshLive2dPet.drawn('phone5'); return typeof v === 'number' ? Number(v.toFixed(2)) : null } catch (e) { return null } })(); return { holds: h.holds, probe: h.probe, group: h.group, phone5: d } })()`)
  if (state.holds !== null) sawHolds = state.holds
  if (state.probe !== null && typeof state.probe.wrote === 'number') sawWrite = state.probe
  // **峰值附近**才抓：动作前半段手还在往下放，抓早了比的是"刚开始"而不是"抬手"。
  // 判据用 `phone5` 的读数（曲线的形状）取最大处，而不是按固定秒数猜。
  if (state.group === 'Selfie' && state.phone5 !== null && state.phone5 >= 8.5 && selfieFrame === null) {
    selfieFrame = await grab()
    peakNote = 'phone5=' + state.phone5
  }
}
check('抓到了自拍峰值那一帧', selfieFrame !== null, peakNote === '' ? '整个自拍期间 phone5 都没到 8.5' : peakNote)
if (selfieFrame === null) selfieFrame = await grab()
check('自拍期间内部表装上了 holdParams', sawHolds !== null && sawHolds.phone5 !== undefined,
  JSON.stringify(sawHolds))
check('每帧写入真的执行了（不是被静默 catch 吞掉）',
  sawWrite !== null && Math.abs(Number(sawWrite.wrote) - Number(sawHolds?.phone5 ?? 0)) < 0.01,
  JSON.stringify(sawWrite))
if (selfieFrame === null) selfieFrame = await grab()
save('1-selfie', selfieFrame)

// --- 3. 画面判据：自拍峰值那一帧必须与「掏出手机定格」有实质差异
//
// **基准是"掏出手机定格"而不是待机**：待机时手机根本不在画面里（还在手机壳里），
// 比出来的差异是"有没有手机 + 表情 + 道具"，跟"手抬没抬"不是一回事（实测只有 0.5%，
// 因为手机/手在整幅画面里本来就只占一小块）。掏出手机定格与自拍峰值**都有手机**，
// 唯一差别就是手机/手的位置 —— 这才是"抬手"该量的东西。
if (phoneFrame.width === selfieFrame.width && phoneFrame.height === selfieFrame.height) {
  let changed = 0
  for (let y = 0; y < phoneFrame.height; y += 1) {
    for (let x = 0; x < phoneFrame.width; x += 1) {
      const i = y * phoneFrame.width * phoneFrame.channels + x * phoneFrame.channels
      const d = Math.abs(phoneFrame.pixels[i] - selfieFrame.pixels[i])
        + Math.abs(phoneFrame.pixels[i + 1] - selfieFrame.pixels[i + 1])
        + Math.abs(phoneFrame.pixels[i + 2] - selfieFrame.pixels[i + 2])
      if (d > 30) changed += 1
    }
  }
  const total = phoneFrame.width * phoneFrame.height
  const ratio = changed / total
  // 阈值 0.8%：手机 + 手这一块只占画面很小一部分，"手机平放"→"举到脸边"实测 ≈1.1%。
  // 用绝对百分比而不是"某个更大的数"，是因为这块几何本来就小；要紧的是它**远高于**
  // 同状态重复抓帧的噪声（实测 0.1% 量级）。
  check('自拍峰值与掏出手机定格有实质差异（手机/手移动了）', ratio > 0.008,
    (ratio * 100).toFixed(2) + '% 像素变化')
} else {
  check('两张抓帧尺寸一致', false, phoneFrame.width + 'x' + phoneFrame.height + ' vs ' + selfieFrame.width + 'x' + selfieFrame.height)
}

// --- 4. 动作结束必须松开
let released = false
for (let i = 0; i < 30; i += 1) {
  await sleep(400)
  const state = await json(`(() => { const h = window.__dshLive2dPet.holdDebug(); return { holds: h.holds, group: h.group } })()`)
  if (state.holds === null) { released = true; break }
}
check('动作结束松开了每帧按住（没有永久钉住）', released === true,
  released ? '回待机后 holds=null' : '仍然钉着')

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SELFIE-RAISE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
