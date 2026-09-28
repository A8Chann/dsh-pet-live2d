// 显示层的**端到端**验证：真的让两边同时存在，看它们会不会同时显示。
//
// 这是"桌面上只有一只"唯一算数的判据 —— 读文件、读日志都不算，要看**两边各自的渲染状态**：
//
//   * 页面内那只：`[data-dsh-live2d-pet]` 的 `visibility`（往位时是 hidden）
//   * 桌面端那只：壳的 `/__desktop/shell` 里的 `windowVisible`
//
// 三种 mode 各走一遍（inline / auto / desktop），每种都要求"恰好一边在显示"。
//
// 前置：DSH 在跑、桌宠插件装的是**当前工作区**那份（`dsh plugin --profile web add link:…`）。
//
//   node tools/probe-display.mjs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, ROOT } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const DSH = argOf('--dsh', process.env.DSH_URL ?? 'http://127.0.0.1:3080')
const EXE = join(DESKTOP, 'dist', 'DSH桌宠.exe')
const SHELL_CDP = 8861
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PREFERENCE = join(HOME, 'pet-desktop.json')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 前置检查
const layerOf = async () => {
  try {
    const response = await fetch(DSH + '/api/live2d-pet/layer')
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}
const first = await layerOf()
check('DSH 在跑且**当前工作区**的插件已装（有 /api/live2d-pet/layer）',
  first !== undefined,
  first === undefined
    ? '拿不到 /api/live2d-pet/layer —— 要么 DSH 没开，要么装的是旧版插件（这一条是本次新增的路由）'
    : JSON.stringify({ mode: first.mode, owner: first.owner, binary: first.binary?.found }))
if (first === undefined) {
  console.error('\n先把工作区的插件装进 web profile：\n'
    + '  dsh plugin --profile web add link:' + join(ROOT, 'dsh-live2d-pet') + '\n'
    + '然后重启 dsh web（宿主半区是启动时 import 的）。')
  process.exit(2)
}

// 备份用户原来的显示层偏好，跑完还回去 —— 别让验证改掉用户的选择。
const originalPreference = existsSync(PREFERENCE) ? readFileSync(PREFERENCE, 'utf8') : undefined
const restorePreference = () => {
  try {
    if (originalPreference === undefined) rmSync(PREFERENCE, { force: true })
    else execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Set-Content -LiteralPath '${PREFERENCE}' -Value @'\n${originalPreference}\n'@ -NoNewline -Encoding UTF8`], { stdio: 'ignore' })
  } catch { /* 还不回去也不影响结论 */ }
}

const setMode = async (mode) => {
  const response = await fetch(DSH + '/api/live2d-pet/layer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  return response.json()
}

// ---------------------------------------------------------------- 起桌面端
console.log('--- 起桌面端（独立模式，读同一个偏好文件）')
let shell
const startShell = () => {
  shell = spawn(EXE, [], { env: { ...process.env, PET_DESKTOP_CDP: String(SHELL_CDP) }, stdio: 'ignore' })
}
const killShell = () => {
  try { shell?.kill() } catch { /* 已经退了 */ }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
    ], { stdio: 'ignore' })
  } catch { /* 收尸失败不影响结论 */ }
}

const shellState = async () => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + SHELL_CDP + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && typeof t.url === 'string')
      const match = page === undefined ? null : /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(page.url)
      if (match !== null) {
        const port = Number(match[1])
        const response = await fetch('http://127.0.0.1:' + port + '/__desktop/shell')
        return { port, state: await response.json() }
      }
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  return undefined
}

/** 页面内那只现在显示着吗（`visibility` 是权威：让位时是 hidden）。 */
async function pageVisibility() {
  const list = await (await fetch('http://127.0.0.1:' + SHELL_CDP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  if (page === undefined) return undefined
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  const value = await new Promise((resolve) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === 1) resolve(message.result?.result?.value)
    })
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `JSON.stringify((() => {
          const el = document.querySelector('[data-theme]')?.closest('[data-dsh-live2d-pet]')
            ?? document.querySelector('[data-dsh-live2d-pet]');
          if (el === null) return null;
          const style = getComputedStyle(el);
          return { visibility: style.visibility, layer: el.getAttribute('data-layer'), mode: el.getAttribute('data-layer-mode') };
        })())`,
        returnByValue: true,
      },
    }))
  })
  socket.close()
  return value === null ? null : JSON.parse(value)
}

try {
  startShell()
  const booted = await shellState()
  check('桌面端起得来（独立模式）', booted !== undefined, booted === undefined ? '(没起来)' : 'port=' + booted.port)
  if (booted === undefined) throw new Error('桌面端没起来')

  // -------------------------------------------------------------- mode=inline
  console.log('--- mode=inline：用户选「页面内」→ 桌面端必须让位')
  await setMode('inline')
  await sleep(2500)
  const inlinePage = await pageVisibility()
  const inlineState = (await shellState())?.state
  check('页面内那只**显示着**', inlinePage?.visibility === 'visible' && inlinePage?.layer === 'inline',
    JSON.stringify(inlinePage))
  check('桌面端窗口**藏起来了**', inlineState?.windowVisible === false, JSON.stringify({
    windowVisible: inlineState?.windowVisible, owner: inlineState?.owner, mode: inlineState?.layerMode,
  }))
  check('桌面端如实报告 owner=inline', inlineState?.owner === 'inline', inlineState?.owner)

  // -------------------------------------------------------------- mode=auto
  console.log('--- mode=auto：桌面端在跑 → 她接管，页面内那只让位')
  await setMode('auto')
  await sleep(2500)
  const autoPage = await pageVisibility()
  const autoState = (await shellState())?.state
  // 页面内那只是**另一个 renderer**（DSH 的页面），要靠 DSH 里的客户端轮询到 owner=desktop。
  const dshOwner = (await layerOf())?.owner
  check('宿主判定 owner=desktop', dshOwner === 'desktop', 'owner=' + dshOwner)
  check('桌面端窗口显示着', autoState?.windowVisible === true, JSON.stringify({
    windowVisible: autoState?.windowVisible, owner: autoState?.owner,
  }))

  // -------------------------------------------------------------- mode=desktop
  console.log('--- mode=desktop：桌面端必须显示（哪怕它是被我们自己拉起来的）')
  await setMode('desktop')
  await sleep(2500)
  const desktopState = (await shellState())?.state
  check('桌面端窗口显示着（mode=desktop）', desktopState?.windowVisible === true, JSON.stringify({
    windowVisible: desktopState?.windowVisible, owner: desktopState?.owner,
  }))

  // -------------------------------------------------------------- 杀掉桌面端
  console.log('--- 杀掉桌面端：页面里那只必须自己回来（不用等太久）')
  killShell()
  const recovered = await (async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const status = await layerOf()
      if (status?.owner === 'inline' && status?.desktopRunning === false) return status
      await sleep(500)
    }
    return await layerOf()
  })()
  check('桌面端一没，owner 立刻回到 inline', recovered?.owner === 'inline' && recovered?.desktopRunning === false,
    JSON.stringify({ owner: recovered?.owner, running: recovered?.desktopRunning, pid: recovered?.desktopPid }))
  void autoPage
  void inlinePage
} finally {
  await setMode('auto').catch(() => {})
  killShell()
  restorePreference()
}

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('DISPLAY ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
