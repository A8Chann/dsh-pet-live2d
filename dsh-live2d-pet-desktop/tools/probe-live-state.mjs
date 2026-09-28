// 一页看清："现在跑的这一份"到底用的什么参数、跟到多远。
//
// 排查"我改了但它还是老样子"这类问题：先确认**在跑的那一份**是哪个二进制、参数是多少，
// 再谈行为。这里把三件事一次问出来：
//
//   1. 进程的启动时间与 exe 路径（对比 dist / %DSH_HOME%\bin 的构建时间）；
//   2. 页面里**实际生效**的 tuning（`gazeRangePx` 等）与依次的距离曲线；
//   3. 窗口矩形（顺便看她在哪块屏、有没有被搬走）。
//
//   node tools/probe-live-state.mjs [--cdp 9401]
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('--- 二进制')
for (const label of ['dist/DSH桌宠.exe']) {
  const path = join(DESKTOP, label)
  try {
    const stat = statSync(path)
    console.log('  ' + label + '  构建于 ' + stat.mtime.toLocaleString() + '  ' + (stat.size / 1048576).toFixed(2) + ' MB')
  } catch { console.log('  ' + label + '  不存在') }
}
const home = process.env.USERPROFILE ?? ''
try {
  const path = join(home, '.dsh', 'bin', 'dsh-pet-live2d-desktop.exe')
  const stat = statSync(path)
  console.log('  %DSH_HOME%/bin  ' + stat.mtime.toLocaleString() + '  ' + (stat.size / 1048576).toFixed(2) + ' MB')
} catch { console.log('  %DSH_HOME%/bin  不存在') }

const ps = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | "
  + "ForEach-Object { $_.Id.ToString() + '  started=' + $_.StartTime.ToString('HH:mm:ss') + '  path=' + $_.Path }; exit 0",
], { encoding: 'utf8' })
console.log('  在跑的进程：\n' + String(ps).split('\n').filter((l) => l.trim() !== '').map((l) => '    ' + l.trim()).join('\n'))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('\nCDP ' + CDP + ' 上没有页面。想查的话带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳；')
  console.error('但**注意**：如果这台机器上已经有一份在跑，新起的那份会立刻退出（WebView2 独占），')
  console.error('所以要查"在跑的那一份"必须先把它关掉、再用参数重启。')
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

console.log('\n--- 页面里实际生效的跟随参数')
console.log('  ' + await evaluate(`JSON.stringify((() => {
  const view = window.__dshLive2dPet?.tuning?.() ?? null;
  return view === null ? '(没有 tuning 读口)' : {
    gazeRangePx: view.gazeRangePx,
    gazeDeadzone: view.gazeDeadzone,
    renderer: document.querySelector('[data-dsh-live2d-pet]')?.getAttribute('data-renderer') ?? null,
    viewport: [window.innerWidth, window.innerHeight],
  };
})())`))

console.log('\n--- 坐标系（把看起来"距离差一大截"的原因定住）')
console.log('  ' + await evaluate(`JSON.stringify({
  viewport: [window.innerWidth, window.innerHeight],
  outer: [window.outerWidth, window.outerHeight],
  screenX: window.screenX,
  screenY: window.screenY,
  dpr: window.devicePixelRatio,
  innerOffset: [window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight],
})`))
const rect = JSON.parse(await evaluate(`JSON.stringify((() => {
  const b = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect();
  return { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
           cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2) };
})())`))
console.log('  她的盒子 ' + JSON.stringify(rect))

/** 把真实光标放到"离她中心 dx 屏幕像素"处（往左），读注视。用真实光标：合成事件验不了这条。 */
const info = JSON.parse(await evaluate(`JSON.stringify((() => {
  const b = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect();
  return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
})())`))
const originRaw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Add-Type -Namespace P -Name N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }' -ErrorAction SilentlyContinue;"
  + "$p = Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Select-Object -First 1;"
  + "if ($p) { $r = New-Object P.N+RECT; [void][P.N]::GetWindowRect($p.MainWindowHandle, [ref]$r); \"$($r.Left),$($r.Top)\" } else { 'none' }; exit 0",
], { encoding: 'utf8' })
const [originX, originY] = String(originRaw).trim().split(',').map((v) => Number(v))
// 往**左下斜着**采（沿一条从她出发的射线）。
//
// 为什么不固定 y：她贴在屏幕底边、页面正中本身就比她高 ~520px，固定 y 采样量到的是
// "竖直方向那一大截"而不是横向距离 —— 这一轮我为此算错过两次（先把判据写成欧氏距离、
// 又把椭圆竖直半径取小了，两次的症状都是"曲线全是 0 或全是很小"）。
const cos = Math.cos((150 * Math.PI) / 180)
const sin = Math.sin((150 * Math.PI) / 180)
console.log('\n--- 距离曲线（真实光标，沿左下 150° 射线）')
console.log('  窗口原点 ' + originX + ',' + originY + '，她的中心（屏幕）= '
  + Math.round(originX + info.cx) + ',' + Math.round(originY + info.cy))
const rows = []
for (const distance of [0, 60, 150, 220, 300, 600, 1200, 2400]) {
  const x = Math.round(originX + info.cx + cos * distance)
  const y = Math.round(originY + info.cy + sin * distance)
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Add-Type -Namespace P2 -Name N2 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);' -ErrorAction SilentlyContinue;"
    + ' [void][P2.N2]::SetCursorPos(' + x + ',' + y + '); exit 0'], { stdio: 'ignore' })
  await sleep(400)
  const gazeRaw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTarget?.() ?? null)')
  const traceRaw = await evaluate('JSON.stringify(window.__dshLive2dPet?.gazeTrace?.() ?? null)')
  const gaze = gazeRaw === 'null' ? null : JSON.parse(gazeRaw)
  const trace = traceRaw === 'null' ? null : JSON.parse(traceRaw)
  rows.push({ dx: distance, gazeX: gaze?.x ?? null, gazeY: gaze?.y ?? null,
    range: trace?.range ?? null, source: trace?.source ?? null, trace, sentX: x, sentY: y })
}
// 壳体喂进来的到底是哪一点：和"我们让它去哪"对一下，差多少一眼看得出。
const fed = rows[0]?.trace
if (fed !== undefined) {
  console.log('  喂进去的点 ' + JSON.stringify(fed.at) + '   发送的点 ' + rows[0].sentX + ',' + rows[0].sentY)
  console.log('  页面算出的中心 ' + JSON.stringify(fed.centre) + '   盒子里量到的中心 ' + rect.cx + ',' + rect.cy)
}
for (const row of rows) {
  console.log('  离她 ' + String(row.dx).padStart(5) + 'px  →  注视 ('
    + (row.gazeX === null ? '?' : row.gazeX.toFixed(3)) + ', '
    + (row.gazeY === null ? '?' : row.gazeY.toFixed(3)) + ')'
    + '   满偏 ' + (row.trace?.range ?? '?') + '/' + (row.trace?.rangeY ?? '?')
    + '   椭圆距离 ' + (row.trace?.ellipsis ?? '?')
    + '   强度 ' + (row.trace?.strength ?? 1)
    + '   来源 ' + (row.source ?? '?')
    + (row.trace?.skipped === undefined ? '' : '   **' + row.trace.skipped + '**'))
}
// 断言按**新契约**（一道连续的椭圆距离曲线，不是硬边界）：
//   近处成比例 → 到满偏那一圈接近满偏 → 再远**单调衰减** → 更远回正。
// 旧的"220px 必须恰好 1.0""600px 必须已经回正"是硬边界时代的写法，现在不该再要求它们。
const at = (distance) => rows.find((r) => r.dx === distance)
const gazeX = (distance) => at(distance)?.gazeX ?? null
const strength = (distance) => at(distance)?.trace?.strength ?? null
const near = gazeX(60)
const mid = gazeX(150)
const edge = gazeX(300)
const fading = gazeX(600)
const recovered = gazeX(1200)
const veryFar = gazeX(2400)
const check = (label, ok, detail) => {
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
  return ok === true
}
console.log('')
let allOk = true
allOk = check('近处成比例偏转（60px 有反应、150px 更大）',
  Math.abs(near ?? 0) > 0.05 && Math.abs(mid ?? 0) > Math.abs(near ?? 0), near + ' → ' + mid) && allOk
allOk = check('到满偏那一圈接近满偏（300px ≈ 1）', Math.abs(edge ?? 0) > 0.85, String(edge)) && allOk
allOk = check('再远是**衰减**而不是贴边（600px 介于两者之间）',
  Math.abs(fading ?? 9) < Math.abs(edge ?? 0) && Math.abs(fading ?? 0) > 0.02,
  String(fading) + '  强度 ' + strength(600)) && allOk
allOk = check('强度随距离单调下降',
  (strength(60) ?? 0) >= (strength(300) ?? 0) && (strength(300) ?? 0) > (strength(600) ?? 0),
  [strength(60), strength(300), strength(600)].join(' >= ') + ' > ' + strength(600)) && allOk
allOk = check('**足够远就回正**（1200px 视线回中，不再斜眼盯着）',
  Math.abs(recovered ?? 9) < 0.05, String(recovered)) && allOk
allOk = check('跨屏更远也回正（2400px）', Math.abs(veryFar ?? 9) < 0.05, String(veryFar)) && allOk
console.log('---')
console.log('LIVE-STATE ' + (allOk ? 'PASS' : 'FAIL'))
socket.close()
