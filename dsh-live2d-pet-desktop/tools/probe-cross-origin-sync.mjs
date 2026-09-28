// **跨 origin 同步的端到端验证**（用户报的"桌面的设置与 DSH 里的设置没有同步"）。
//
// 两个界面确实是两个 origin：
//   DSH 页面：  http://127.0.0.1:3080
//   桌面端页面：http://127.0.0.1:<壳的随机端口>
// localStorage 按 origin 隔离 ⇒ 共享状态必须走宿主（`%DSH_HOME%\pet-settings.json`）。
//
// 这里验的正是那条链：**在 DSH 侧写一项 → 桌面端页面在轮询周期内跟着变**。
// 判据读的是桌面端页面里的真实状态（`__dshLive2dPet.settingsOverrides()` / `tuning()`），
// 不是"文件里有没有"—— 文件里有但页面没读，对用户来说仍然叫"没同步"。
//
//   node tools/probe-cross-origin-sync.mjs [--cdp 9401]
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const DSH = argOf('--dsh', 'http://127.0.0.1:3080')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

// ---- 桌面端页面（CDP）------------------------------------------------------
let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面（桌宠要先带 PET_DESKTOP_CDP=' + CDP + ' 起）')
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
const desktop = async (expression) => {
  const result = await new Promise((resolve) => {
    const id = ++seq
    pending.set(id, (message) => resolve(message.result))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  if (result?.exceptionDetails !== undefined) {
    return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
  }
  const value = result?.result?.value
  return typeof value === 'string' ? value : value
}
const desktopJson = async (expression) => {
  const raw = await desktop(expression)
  if (raw !== null && typeof raw === 'object' && typeof raw.__error === 'string') throw new Error(raw.__error)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

const origin = await desktop('location.origin')
console.log('桌面端页面 origin：' + origin)
check('桌面端确实是与 DSH 不同的 origin', origin !== DSH, origin + ' vs ' + DSH)

// ---- DSH 侧读写 -------------------------------------------------------------
const dshGet = async () => (await fetch(DSH + '/api/live2d-pet/settings', { cache: 'no-store' })).json()
const dshPost = async (payload) => {
  const response = await fetch(DSH + '/api/live2d-pet/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return response.json()
}

const before = await dshGet()
console.log('宿主存档（改之前）：' + JSON.stringify(before).slice(0, 120))

// 用一个"一眼能认出来"的值，跑完还原（别把用户真设置改坏）。
const probeValue = 187
const original = before.tuning?.gazeRangePx ?? null
const write = await dshPost({ tuning: Object.assign({}, before.tuning ?? {}, { gazeRangePx: probeValue }) })
check('在 DSH 侧写一项设置成功', write.ok === true && write.tuning?.gazeRangePx === probeValue, 'rev=' + write.rev)

// ---- 等桌面端轮询到（3 秒一次，给 8 秒余量）--------------------------------
let seen = null
for (let i = 0; i < 16; i += 1) {
  await sleep(500)
  const state = await desktopJson('JSON.stringify({ tuning: window.__dshLive2dPet.tuning ? window.__dshLive2dPet.tuning() : null })')
  if (state.tuning?.gazeRangePx === probeValue) { seen = state; break }
}
check('**桌面端跟着变了**（读到 DSH 侧刚写的那一项）',
  seen !== null, seen === null ? '8 秒内没同步过来' : 'gazeRangePx=' + seen.tuning.gazeRangePx)

// ---- 顺带验另一半：桌面端改、DSH 侧看得见 -----------------------------------
// 桌面端是一个真正的"另一个窗口"，它的写入也走宿主。
const writeBack = await dshPost({ tuning: Object.assign({}, write.tuning ?? {}, { gazeRangePx: original ?? 220 }) })
check('还原成原值（不留下探针值）',
  writeBack.ok === true && (writeBack.tuning?.gazeRangePx ?? 220) === (original ?? 220),
  'gazeRangePx=' + writeBack.tuning?.gazeRangePx)

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('CROSS-ORIGIN-SYNC ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
