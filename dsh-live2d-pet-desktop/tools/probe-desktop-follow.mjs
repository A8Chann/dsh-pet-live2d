// 桌面端的**全局跟随**：用**真实光标**（不是 CDP 合成事件）在她周围移动，读注视目标。
//
// 为什么必须用真实光标 + 真实移动：这条修的是"指针不在本窗口上时的跟随"，而那正是
// `pointermove` **不会**发生的情形 —— 合成事件恰恰是"假装指针在这个窗口上"，用它验等于
// 没验（这一轮就是这么把问题漏掉的：之前所有 driver 都用合成事件，全部测的是 DOM 路径）。
//
// 判据：
//   * 注视方向跟着光标的**真实方位**变（左/右/上/下各自对应负/正/正/负）；
//   * `gazeTrace().source === 'shell'` —— 说明这次更新来自壳喂的全局光标，不是 DOM 事件。
//
//   node tools/probe-desktop-follow.mjs [--cdp 9401]
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把**真实**光标移到屏幕坐标 (x, y)。 */
const setCursor = (x, y) => {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -Namespace CF -Name N -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);\' -ErrorAction SilentlyContinue;'
    + ' [void][CF.N]::SetCursorPos(' + x + ',' + y + '); exit 0'], { stdio: 'ignore' })
}

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
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result?.result?.value))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

// 她的中心在**屏幕坐标**里的位置：页面报视口内的 CSS 像素，加上窗口原点（壳的读口里有）。
const shell = await (async () => {
  const ports = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | ForEach-Object { Get-NetTCPConnection -OwningProcess $_.Id -State Listen -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty LocalPort; exit 0",
  ], { encoding: 'utf8' })
  for (const port of String(ports).split(/\s+/).filter((p) => p !== '')) {
    try {
      const state = await (await fetch('http://127.0.0.1:' + port + '/__desktop/shell')).json()
      if (state?.windowOrigin !== null && state?.windowOrigin !== undefined) return { port, state }
    } catch { /* 不是这个 */ }
  }
  return undefined
})()
check('拿得到壳的读口（窗口原点与缩放）', shell !== undefined, JSON.stringify(shell?.state?.windowOrigin))
if (shell === undefined) process.exit(1)

const origin = shell.state.windowOrigin
const scale = shell.state.scale ?? 1
const box = JSON.parse(await evaluate(`JSON.stringify((() => {
  const el = document.querySelector('[data-dsh-live2d-pet]');
  const b = el.getBoundingClientRect();
  return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
})())`))
const centreScreenX = Math.round(origin[0] + box.cx * scale)
const centreScreenY = Math.round(origin[1] + box.cy * scale)
console.log('  她的中心（屏幕坐标）' + centreScreenX + ',' + centreScreenY
  + '  窗口原点 ' + origin.join(',') + '  缩放 ' + scale + '  盒子 ' + box.w + '×' + box.h)

const readGaze = async () => {
  const raw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTarget?.() ?? null)')
  const traceRaw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTrace?.() ?? null)')
  return {
    gaze: raw === 'null' ? null : JSON.parse(raw),
    trace: traceRaw === 'null' ? null : JSON.parse(traceRaw),
  }
}

/** 把真实光标放到"离她中心 (dx, dy) 屏幕像素"处，读注视。 */
const atOffset = async (dx, dy) => {
  setCursor(centreScreenX + dx, centreScreenY + dy)
  await sleep(500)
  return readGaze()
}

// 探针半径要**夹进她的屏幕**：她在右下角，右侧余量通常只有百来像素（本机 174px），
// 用 300 会直接跨到隔壁屏幕，量到的方向就白了 —— 那是探针越界，不是功能问题。
const R = Math.min(300, Math.max(80, (() => {
  const work = shell.state
  void work
  return 150
})()))
/** 屏幕 y 向下为正；注视的 y 是"上为正"（引擎的约定），所以上下要**反着断**。 */
const RY = 300
const left = await atOffset(-R, 0)
const right = await atOffset(R, 0)
const up = await atOffset(0, -RY)
const down = await atOffset(0, RY)
const back = await atOffset(0, 0)

const show = (sample) => JSON.stringify(sample.gaze) + ' src=' + (sample.trace?.source ?? '?')
console.log('  左 ' + show(left) + '   右 ' + show(right) + '   上 ' + show(up) + '   下 ' + show(down))

check('往左 ⇒ 视线偏左（x < 0）', (left.gaze?.x ?? 0) < -0.2, show(left))
check('往右 ⇒ 视线偏右（x > 0）', (right.gaze?.x ?? 0) > 0.2, show(right))
// 屏幕 y 向下为正，而 `gazeTarget.y` 的约定是"上为负"（`updatePointer` 里以 `focus(nx, -ny)`
// 交给引擎）。所以光标**往上**移（屏幕 y 更小）应当得到 **负** 的 `gaze.y`。
// 这里不要按"上为正"去断言 —— 那是引擎内部那一步的约定，不是这个读口的（踩过一次）。
check('往上 ⇒ gaze.y 为负（该读口的约定：上为负）', (up.gaze?.y ?? 0) < -0.2, show(up))
check('往下 ⇒ gaze.y 为正', (down.gaze?.y ?? 0) > 0.2, show(down))
check('回到她中心 ⇒ 视线回中', Math.abs(back.gaze?.x ?? 9) < 0.05 && Math.abs(back.gaze?.y ?? 9) < 0.05, show(back))
// **最关键的一条**：更新必须来自壳喂的全局光标，而不是 DOM 事件 ——
// 真实光标在别处（本探针没有向窗口发任何合成事件），所以 DOM 路径根本不会触发。
check('跟随来自壳喂的全局光标（source=shell）',
  [left, right, up, down].every((s) => s.trace?.source === 'shell'),
  [left, right, up, down].map((s) => s.trace?.source).join(','))

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('DESKTOP-FOLLOW ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
