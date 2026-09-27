// 待机动画是否真的在跑：**页内连续采样**引擎帧内写进模型的参数，再看它们变不变。
//
// 沿用仓库的验证纪律（见 .dsh/skills/verification-signals）：断言读参数值，不做截图
// 逐像素/哈希比对。桌面上"看着像在动"和"引擎每帧真的在写"是两件事。
//
// 为什么在页面里采样而不是从外面每 1.5 秒问一次：**单点采样会踩到同相位**。缓动是
// 周期性的，两次读数完全可能落在同一个呼吸的同一侧；第一版就这么假红过一次
// （`ParamBreath` 三次都读到 0，而眨眼计数其实一直在涨）。连续采样拿到的是分布，
// 不是运气。
//
//   node tools/probe-anim.mjs [--cdp-port 8823] [--ms 3000]
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp-port', '8823'))
const MS = Number(argOf('--ms', '3000'))

const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (message) => {
    if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 400)))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

const PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamBodyAngleX', 'ParamBreath',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm',
  'ParamHairFront', 'ParamPhysics1',
]

const probe = `(async () => {
  const api = window.__dshLive2dPet;
  if (!api) return { error: 'no-api' };
  const names = ${JSON.stringify(PARAMS)};
  const series = {}; for (const n of names) series[n] = [];
  const frames = [];
  const blinks0 = api.blinkCount ? api.blinkCount() : null;
  const t0 = performance.now();
  while (performance.now() - t0 < ${MS}) {
    for (const n of names) series[n].push(api.drawn(n));
    frames.push(performance.now());
    await new Promise(r => requestAnimationFrame(() => r()));
  }
  const distinct = {};
  for (const n of names) distinct[n] = new Set(series[n].map(v => Math.round(v * 1000))).size;
  const blinks1 = api.blinkCount ? api.blinkCount() : null;
  const span = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
  return {
    frames: frames.length,
    fps: span > 0 ? Math.round((frames.length - 1) / (span / 1000)) : null,
    distinct,
    min: Object.fromEntries(names.map(n => [n, Math.min(...series[n])])),
    max: Object.fromEntries(names.map(n => [n, Math.max(...series[n])])),
    blinks: blinks0 === null ? null : blinks1 - blinks0,
    layers: api.expressionLayerCount ? api.expressionLayerCount() : null,
    slots: api.slotSelections ? api.slotSelections() : null,
  };
})()`

// 页内返回的就是对象；`returnByValue` 会把它还原成对象（不是字符串），别 JSON.parse。
const raw = await evaluate(probe)
const result = typeof raw === 'string' ? JSON.parse(raw) : raw
if (result === null || result === undefined || result.error) {
  console.error('页面里没有插件读口：' + JSON.stringify(result))
  process.exit(2)
}

console.log('帧数 = ' + result.frames + '，实测帧率 = ' + result.fps + ' fps')
console.log('眨眼次数（本段内） = ' + result.blinks + '，表情层 = ' + result.layers)
console.log('各参数在本段内的不同取值个数：')
for (const [name, count] of Object.entries(result.distinct)) {
  console.log('  ' + name.padEnd(18) + ' distinct=' + String(count).padStart(4)
    + '  range=[' + Number(result.min[name]).toFixed(3) + ', ' + Number(result.max[name]).toFixed(3) + ']')
}

const animated = Object.entries(result.distinct).filter(([, count]) => count > 1).map(([name]) => name)
const ok = result.frames > 10 && (animated.length > 0 || (result.blinks ?? 0) > 0)
console.log('---')
console.log('在动的参数 = ' + JSON.stringify(animated))
console.log('ANIM ' + (ok ? 'PASS' : 'FAIL'))
socket.close()
process.exit(ok ? 0 : 1)
