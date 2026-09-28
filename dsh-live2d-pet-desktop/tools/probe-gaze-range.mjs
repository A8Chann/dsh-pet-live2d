// 桌面端的**注视跟随幅度**：把光标放在她附近不同距离，读模型真实的注视目标。
//
// 为什么要单独量：这个 bug 的表现是"在她旁边动鼠标几乎没反应"，而网页端完全正常 ——
// 因为原来把偏移按**舞台尺寸**归一化，桌面端舞台是整块屏（3440px），她只占右下角 300px，
// 于是附近的移动只有百分之几的偏转。判据必须是**偏转幅度随距离增长、并在满偏半径处到顶**，
// 光看"有没有反应"会漏掉"反应小得看不见"。
//
//   node tools/probe-gaze-range.mjs [--cdp 9401]
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
  console.error('CDP ' + CDP + ' 上没有页面（带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
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
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message))
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
})
const evaluate = async (expression) => {
  const message = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return message.result?.result?.value
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

// 视口尺寸与她的中心都在**页面坐标**里量（`Input.dispatchMouseEvent` 用的就是这个坐标系）。
//
// ⚠️ 她贴着屏幕右下角，所以"往右探"很快就会撞到视口边界，事件根本发不出去 ——
// 探针必须按**到边界的余量**选偏移，否则量到的是"探针发不出去"而不是"跟随有问题"。
const infoRaw = await evaluate(`JSON.stringify((() => {
  const el = document.querySelector('[data-dsh-live2d-pet]');
  if (el === null) return null;
  const box = el.getBoundingClientRect();
  return {
    centre: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    box: { w: box.width, h: box.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    visibility: getComputedStyle(el).visibility,
  };
})())`)
const info = JSON.parse(infoRaw)
check('页面里能拿到她的中心与视口尺寸', info !== null, infoRaw)
if (info === null) process.exit(1)
const centre = info.centre
console.log('  她的中心 ' + Math.round(centre.x) + ',' + Math.round(centre.y)
  + '  盒子 ' + Math.round(info.box.w) + '×' + Math.round(info.box.h)
  + '  视口 ' + info.viewport.w + '×' + info.viewport.h + '  visibility=' + info.visibility)

/** 把光标放到"离她中心 dx 像素"的位置，读注视目标。 */
async function gazeAtOffset(dx) {
  const x = Math.round(centre.x + dx)
  const y = Math.round(centre.y)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  // trace 在 **pointermove 处理器里**写：紧跟着读它，才能区分"事件没送到"和"送到了但算错"。
  const traceRaw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTrace?.() ?? null)')
  await sleep(320)
  const raw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTarget?.() ?? null)')
  return {
    gaze: raw === 'null' ? null : JSON.parse(raw),
    trace: traceRaw === 'null' ? null : JSON.parse(traceRaw),
  }
}

// 往左探（她在右下角，左边的余量最大），取到满偏半径为止。
const room = Math.floor(centre.x) - 8
const offsets = [0, 60, 160, 320].filter((dx) => dx <= room)
if (!offsets.includes(320)) offsets.push(Math.min(320, room))
const samples = []
for (const dx of [...new Set(offsets)]) {
  const { gaze, trace } = await gazeAtOffset(-dx)
  samples.push({ dx, x: gaze === null ? null : Number(gaze.x.toFixed(3)), trace })
}
console.log('  离她中心向左 ' + JSON.stringify(samples.map((s) => [s.dx, s.x])))
for (const sample of samples) {
  const t = sample.trace
  console.log('    dx=-' + String(sample.dx).padStart(4)
    + (t === null
      ? '  **指针事件没送到**（gazeTrace 还是 null）'
      : '  实参 ' + JSON.stringify(t.callIn ?? null) + '  满偏 ' + t.range + '（设置值 ' + t.tuningPx + '）'))
}

const at = (dx) => (samples.find((s) => s.dx === dx)?.x ?? null)
// 向左探 → 偏转应当是**负的**，幅度随距离增长。
check('中心处视线基本回中', Math.abs(at(0) ?? 9) < 0.05, String(at(0)))
check('60px 就有可见偏转（|x| > 0.05）', Math.abs(at(60) ?? 0) > 0.05, String(at(60)))
check('偏转随距离增大（160px 幅度 > 60px）',
  Math.abs(at(160) ?? 0) > Math.abs(at(60) ?? 0), at(60) + ' → ' + at(160))
const far = samples[samples.length - 1]
check('最远处接近满偏（|x| > 0.6）', Math.abs(far.x ?? 0) > 0.6, 'dx=-' + far.dx + ' → ' + far.x)
check('方向正确（往左 ⇒ 负）', (at(60) ?? 1) < 0 && (at(160) ?? 1) < 0, [at(60), at(160)].join(', '))

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('GAZE-RANGE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length
  + '（她的中心 ' + Math.round(centre.x) + ',' + Math.round(centre.y) + '）')
process.exit(failed.length === 0 ? 0 : 1)
