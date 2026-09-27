// 相位端到端：DSH 的真实事件 → 桌面端的宠物动作。
//
// 这条链是跨进程的（DSH → sidecar 的 SSE 桥 → hub → 插件的 /events → 页面 EventSource →
// 动作/表情状态机），所以"看着像换了"不算数——读的是 pet 根节点上的 `data-phase`
// 与**引擎帧内写进模型的参数**，与仓库既有的验证纪律一致。
//
//   node tools/probe-phase.mjs [--cdp-port 8823] [--seconds 18]
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp-port', '8823'))
const SECONDS = Number(argOf('--seconds', '18'))

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
    if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 300)))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

const sample = async () => {
  const raw = await evaluate(`(() => {
    const root = document.querySelector('[data-dsh-live2d-pet]');
    const api = window.__dshLive2dPet;
    return {
      phase: root ? root.getAttribute('data-phase') : null,
      motion: root ? root.getAttribute('data-motion') : null,
      slots: api && api.slotSelections ? api.slotSelections() : null,
    };
  })()`)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

const timeline = []
const deadline = Date.now() + SECONDS * 1000
let lastKey = ''
while (Date.now() < deadline) {
  const s = await sample()
  const key = s.phase + '|' + s.motion
  if (key !== lastKey) {
    lastKey = key
    timeline.push({ at: new Date().toISOString().slice(11, 19), ...s })
    console.log(timeline[timeline.length - 1].at + '  phase=' + s.phase + '  motion=' + s.motion
      + '  装扮=' + JSON.stringify(s.slots))
  }
  await new Promise((r) => setTimeout(r, 120))
}

const phases = [...new Set(timeline.map((t) => t.phase))]
console.log('---')
console.log('这段时间里出现过的相位 = ' + JSON.stringify(phases))
const ok = phases.some((p) => p !== null && p !== 'idle')
console.log('PHASE ' + (ok ? 'PASS' : 'FAIL'))
socket.close()
process.exit(ok ? 0 : 1)
