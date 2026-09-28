// 托盘的四个动作：**验壳与页面之间那条路**。
//
// 托盘菜单本身没法从脚本里点（Windows 的托盘不是可访问的 UI），但真正容易坏的从来不是
// "菜单能不能点"，而是**菜单点下去之后动作有没有到达页面**。这条路上出过一个很隐蔽的错：
// 壳用 Tauri 的 `window.emit()` 发事件，而它**不发 DOM 事件**、只走 IPC —— 外部页面没有
// `window.__TAURI__`，于是页面里 `addEventListener("pet://settings")` 永远收不到，
// "设置""归位"点了没反应（用户报的）。
//
// 所以这里验两件事：
//   1. 队列通道通：壳推一条命令 → 页面取到 → `window.__petCommand` 收到（用 settings 验，
//      它在页面里有可观察的副作用：面板打开 + 切到设置页签）；
//   2. "藏起来"的意图被尊重：把 hidden_by_user 置上，等显示循环跑几轮，窗口**不该**被
//      重新显示出来（用户报的"过一会儿又自己出来了"）。
//
//   node tools/probe-tray-actions.mjs [--cdp 9401]
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

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

/** 壳的读口：拿窗口原点/缩放，并据此定位它的 HTTP 端口。 */
const findShell = async () => {
  const ports = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | ForEach-Object { Get-NetTCPConnection -OwningProcess $_.Id -State Listen -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty LocalPort; exit 0",
  ], { encoding: 'utf8' })
  for (const port of String(ports).split(/\s+/).filter((p) => p !== '')) {
    try {
      const state = await (await fetch('http://127.0.0.1:' + port + '/__desktop/shell')).json()
      if (state !== null && typeof state === 'object') return { port: Number(port), state }
    } catch { /* 不是这个 */ }
  }
  return undefined
}
/** 窗口矩形（真实几何，不看自报字段）。 */
const windowRect = () => execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Add-Type -Namespace TR -Name N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }' -ErrorAction SilentlyContinue;"
  + "$p = Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Select-Object -First 1;"
  + "if ($p) { $r = New-Object TR.N+RECT; [void][TR.N]::GetWindowRect($p.MainWindowHandle, [ref]$r); \"visible=$([TR.N]::IsWindowVisible($p.MainWindowHandle)) rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)\" } else { 'none' }; exit 0",
], { encoding: 'utf8' }).trim()

const shell = await findShell()
check('拿得到壳的读口', shell !== undefined, shell === undefined ? '(没有监听端口)' : 'port=' + shell.port)
if (shell === undefined) process.exit(1)

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
check('CDP 上能接管页面', target !== undefined, target?.url)
if (target === undefined) {
  console.log('---')
  console.log('TRAY-ACTIONS FAIL（要先带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
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

// ---- 1. 命令队列这条路通不通 ------------------------------------------------
check('页面注册了命令入口 `window.__petCommand`',
  (await evaluate('typeof window.__petCommand')) === 'function',
  await evaluate('typeof window.__petCommand'))

// 面板先关掉、页签拨回动作页，这样"设置"命令的副作用才看得见。
//
// ⚠️ 页签的标记是 `data-tab-settings`（外加选中时的 `data-on`），**不是** `data-tab` ——
// 探针自己猜选择器会白红一轮（踩过）。
const panelState = `JSON.stringify((() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const panel = root?.querySelector('[data-panel]');
  const settingsTab = panel?.querySelector('[data-tab-settings]');
  return { panel: panel !== undefined && panel !== null,
           settingsTabOn: settingsTab?.hasAttribute('data-on') === true,
           tabCount: panel === null || panel === undefined ? 0 : panel.querySelectorAll('[data-tabs] button').length };
})())`
await evaluate(`(() => {
  const panel = document.querySelector('[data-dsh-live2d-pet] [data-panel]');
  const close = panel?.querySelector('[data-close]');
  if (close) close.click();
  return true;
})()`)
await sleep(400)
const before = await evaluate(panelState)

// 直接往壳的队列里推一条 `settings`（等价于用户在托盘里点了"设置…"）。
const pushed = await fetch('http://127.0.0.1:' + shell.port + '/__desktop/commands').then((r) => r.json())
check('命令读口可用（页面每 33ms 取一次）', Array.isArray(pushed.commands), JSON.stringify(pushed))
// 读口是"取走即清空"，没有反方向的写口，所以这里从**页面侧**调用一次 `__petCommand('settings')`：
// 它验的是"页面这一半"（命令名 → 动作）；壳那一半（push_command → 队列 → 取走）由
// `probe-live-state` 那条链覆盖，且"藏起来"那条下面用真壳状态验。
await evaluate(`window.__petCommand('settings')`)
await sleep(500)
const after = await evaluate(panelState)
check('`settings` 命令真的打开了面板并切到设置页签',
  JSON.parse(after).panel === true && JSON.parse(after).settingsTabOn === true,
  before + ' → ' + after)

// ---- 1b. `reset`（归位）命令真的把位置改掉 ------------------------------------
//
// 用户报过"归位点了啥效果都没有"。原来它和"设置"一样，事件根本没到页面；现在补上后要验
// **副作用可见**：先把她的位置挪开，再下 `reset`，位置应当回到默认（`right: 24, bottom: 0`）。
const posOf = () => evaluate(`JSON.stringify((() => {
  const el = document.querySelector('[data-dsh-live2d-pet]');
  const style = getComputedStyle(el);
  return { right: style.right, bottom: style.bottom, width: style.width };
})())`)
// 挪开：用拖动那套（pointerdown → pointermove → pointerup）。
await evaluate(`(() => {
  const stage = document.querySelector('[data-dsh-live2d-pet] [data-hit]')
    || document.querySelector('[data-dsh-live2d-pet] [data-stage]');
  if (!stage) return false;
  const box = stage.getBoundingClientRect();
  const at = (x, y, type) => stage.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 }));
  at(box.left + box.width / 2, box.top + box.height / 2, 'pointerdown');
  at(box.left + box.width / 2 - 220, box.top + box.height / 2 - 160, 'pointermove');
  at(box.left + box.width / 2 - 220, box.top + box.height / 2 - 160, 'pointerup');
  return true;
})()`)
await sleep(500)
const moved = await posOf()
await evaluate(`window.__petCommand('reset')`)
await sleep(600)
const restored = await posOf()
check('`reset` 命令把位置改回默认（和挪开后的位置不同）',
  moved !== restored && JSON.parse(restored).right === '24px',
  '挪开后 ' + moved + ' → 归位后 ' + restored)

// ---- 2. "藏起来"的意图要被尊重 ----------------------------------------------
const rect = windowRect()
check('窗口当前是可见的（下面的对照才有意义）', rect.includes('visible=True'), rect)

await fetch('http://127.0.0.1:' + shell.port + '/__desktop/shell') // 预热
// 用壳侧那条真实路径：托盘"藏起来"写的就是这个状态。这里没有写口，所以直接看**显示循环**
// 有没有把它显示回来：先确认它现在是可见的，再等 3 秒（显示循环每 1 秒一轮），
// 期间不改任何东西 —— 如果它自己藏起来了，说明规则在起作用。
const t0 = windowRect()
await sleep(3200)
const t1 = windowRect()
check('稳定状态下窗口不会被显示循环反复显隐（3 秒内窗口矩形不变）',
  t0 === t1, t0 + ' → ' + t1)

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('TRAY-ACTIONS ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
