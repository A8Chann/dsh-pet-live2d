// 挂载模式（`--attach <dsh-url>`）的验证。
//
// 要证明的不是"页面能渲染"，而是**数据真的来自 DSH**：
//
//   1. 壳的 `/api/live2d-pet/catalog` 与 DSH 自己的那一份**逐字节相同**（同一个上游）；
//   2. 上游**故意停掉**时，catalog 必须失败 —— 证明它不是在本机自己扫宠物目录
//      （这条是"挂载真的生效"的判据，只比"两边都有内容"是抓不到假挂载的）；
//   3. 资产、运行时文件、SSE 相位也走同一条路；
//   4. 页面仍然渲染得出来（canvas + 判定函数可用）。
//
//   node tools/probe-attach.mjs [--upstream http://127.0.0.1:3080]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const UPSTREAM = argOf('--upstream', 'http://127.0.0.1:3080')
const EXE = join(DESKTOP, 'dist', 'DSH桌宠.exe')
const CDP_PORT = Number(argOf('--cdp-port', '8823'))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 上游探活
const upstreamCatalog = async () => {
  try {
    const response = await fetch(UPSTREAM + '/api/live2d-pet/catalog')
    if (!response.ok) return undefined
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return undefined
  }
}
const upstreamBytes = await upstreamCatalog()
check('DSH 在跑且插件已装（能取到 catalog）', upstreamBytes !== undefined,
  upstreamBytes === undefined ? UPSTREAM + ' 上没有 /api/live2d-pet/catalog' : upstreamBytes.length + ' 字节')
if (upstreamBytes === undefined) {
  console.error('先起 DSH：dsh web（或确认插件装在 web profile 上）')
  process.exit(2)
}

// ---------------------------------------------------------------- 找壳的端口
//
// **从页面 URL 推**：页面就是壳的宿主发的，URL 里的端口一定是它。这比问进程表稳得多
// （`Get-NetTCPConnection` 在中文进程名/受限环境下会返回空，踩过）。
//
// 每个实例给一个独立的 CDP 端口，于是"哪个 CDP 端口 → 哪个实例"是确定的。
async function portFromCdp(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && typeof t.url === 'string')
      if (page !== undefined) {
        const match = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(page.url)
        if (match !== null) return { port: Number(match[1]), target: page }
      }
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  return { port: 0, target: undefined }
}

// ---------------------------------------------------------------- 起壳（挂载模式）
console.log('--- 以挂载模式起壳：' + EXE + ' --attach ' + UPSTREAM)
const child = spawn(EXE, ['--attach', UPSTREAM], {
  env: { ...process.env, PET_DESKTOP_CDP: String(CDP_PORT) },
  stdio: 'ignore',
  detached: false,
})
await sleep(6000)

const mounted = await portFromCdp(CDP_PORT)
const port = mounted.port
check('壳起来了（页面 URL 里能读出宿主端口）', port > 0, 'port=' + port)
// ---------------------------------------------------------------- 1. 与上游逐字节相同
const shellGet = async (path) => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + path)
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') }
  } catch (error) {
    return { status: 0, bytes: Buffer.alloc(0), type: '', error: String(error && error.message) }
  }
}

const shellCatalog = await shellGet('/api/live2d-pet/catalog')
check('挂载模式下能取到 catalog', shellCatalog.status === 200, 'status=' + shellCatalog.status)
check('catalog 与 DSH 那一份**逐字节相同**',
  shellCatalog.bytes.equals(upstreamBytes),
  shellCatalog.bytes.length + ' vs ' + upstreamBytes.length + ' 字节')

// 资产：拿 DSH 给的 modelUrl 去壳上取，必须同一份字节。
let pet = undefined
try {
  pet = JSON.parse(shellCatalog.bytes.toString('utf8')).pets?.[0]
} catch { /* 下面会报 */ }
check('catalog 里有宠物', pet !== undefined, pet?.id ?? '(无)')
if (pet !== undefined) {
  const upstreamAsset = await fetch(UPSTREAM + pet.modelUrl).then((r) => r.arrayBuffer()).then(Buffer.from)
  const shellAsset = await shellGet(pet.modelUrl)
  check('模型描述走转发，逐字节相同',
    shellAsset.status === 200 && shellAsset.bytes.equals(upstreamAsset),
    'status=' + shellAsset.status + '，' + shellAsset.bytes.length + ' vs ' + upstreamAsset.length + ' 字节')
  check('资产带的是上游给的 content-type', (shellAsset.type ?? '').includes('json'), shellAsset.type)
}

// 运行时文件（Cubism Core / vendor）也要转发得到。
for (const [label, path] of [
  ['Cubism Core', '/api/live2d-pet/runtime/live2dcubismcore.min.js'],
  ['vendor 分包', '/api/live2d-pet/runtime/live2d-vendor.js'],
]) {
  const upstream = await fetch(UPSTREAM + path).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b)).catch(() => Buffer.alloc(0))
  const shell = await shellGet(path)
  check(label + ' 转发一致', shell.status === 200 && shell.bytes.equals(upstream),
    shell.status + '，' + shell.bytes.length + ' vs ' + upstream.length + ' 字节')
}

// ---------------------------------------------------------------- 2. 相位流
// 上游的 SSE 是长连接、可能分块 —— 转发最容易在这里露馅。
const sseFirstFrames = async (base) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(base + '/api/live2d-pet/events', { signal: controller.signal })
    const reader = response.body.getReader()
    let text = ''
    const deadline = Date.now() + 2500
    while (Date.now() < deadline && !text.includes('"phase"')) {
      const { value, done } = await reader.read()
      if (done) break
      text += Buffer.from(value ?? []).toString('utf8')
    }
    reader.cancel().catch(() => {})
    return { type: response.headers.get('content-type') ?? '', text }
  } catch (error) {
    return { type: '', text: 'ERR ' + String(error && error.message) }
  } finally {
    clearTimeout(timer)
  }
}
const [upstreamSse, shellSse] = await Promise.all([
  sseFirstFrames(UPSTREAM),
  sseFirstFrames('http://127.0.0.1:' + port),
])
const phaseOf = (text) => {
  const match = /"phase"\s*:\s*"([^"]+)"/.exec(text)
  return match === null ? null : match[1]
}
check('相位流也转发得到（且是 SSE）',
  shellSse.type.includes('text/event-stream') && phaseOf(shellSse.text) !== null,
  'type=' + shellSse.type + ' 首帧phase=' + phaseOf(shellSse.text) + '（上游=' + phaseOf(upstreamSse.text) + '）')

// ---------------------------------------------------------------- 3. 页面渲染
// 页面能不能渲染 —— 用上面那条 CDP 拿到的 target 直接问（不再重复找一遍）。
const target = mounted.target
check('壳里的页面可接管（CDP）', target !== undefined, target?.url ?? '(无)')
if (target !== undefined) {
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
  let diag = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const raw = await evaluate('JSON.stringify({ boot: window.__desktopBoot ?? null, diag: window.__petDesktop ? window.__petDesktop.diag() : null, mode: (window.__petDesktop?.state ?? {}).mode ?? null })')
    diag = JSON.parse(raw)
    if (diag.boot?.ok === true && diag.diag?.canvas === true) break
    await sleep(400)
  }
  check('页面渲染出宠物（canvas + 无脚本错误）',
    diag.diag?.canvas === true && (diag.diag?.errors ?? []).length === 0,
    JSON.stringify({ canvas: diag.diag?.canvas, errors: diag.diag?.errors ?? [] }).slice(0, 200))
  socket.close()
}

// ---------------------------------------------------------------- 4. 假挂载的判据
//
// 只比"两边都有内容"是抓不到假挂载的 —— 本机也能扫到同一只宠物。所以要**把一个实例
// 直接指向死端口**，然后看它给不给 catalog：
//
//   * 给 200 + 一份完整 catalog → 它在偷偷用本机宿主（假挂载，判红）；
//   * 报错（502）→ 挂载是真的。
//
// 这条也正是我在实现里改掉的那个设计错误：**连不上上游时故意失败，不静默退回本机实现**。
//
// ⚠️ 必须**顺序**做，不能两个实例同时跑：WebView2 的 user-data-dir 是独占的，
// 同一个 exe 起第二份会直接退出（实测"实例数 = 1"）。所以先收掉上面那个，再起死端口那个。
console.log('--- 收掉挂载实例，改用一个指向死端口的实例证明"挂载是真的"（不是本机兜底）')
try { child.kill() } catch { /* 已经退了 */ }
try {
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
  ], { stdio: 'ignore' })
} catch { /* 收尸失败不影响结论 */ }
await sleep(3000)

const deadExe = spawn(EXE, ['--attach', 'http://127.0.0.1:59999'], {
  env: { ...process.env, PET_DESKTOP_CDP: '8824' },
  stdio: 'ignore',
})
const dead = await portFromCdp(8824)
check('第二个实例起来了（死端口）', dead.port > 0, 'port=' + dead.port)
if (dead.port > 0) {
  const response = await fetch('http://127.0.0.1:' + dead.port + '/api/live2d-pet/catalog').then(
    async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }),
    (error) => ({ status: 0, bytes: 0, error: String(error && error.message) }),
  )
  console.log('  （上游不可达的实例：' + JSON.stringify(response) + '）')
  check(
    '上游不可达时报错，而不是退回本机宿主（否则"挂载成功"是假的）',
    response.status >= 400 || response.status === 0 || response.bytes === 0,
    'status=' + response.status + '，' + response.bytes + ' 字节',
  )
  const state = await fetch('http://127.0.0.1:' + dead.port + '/__desktop/shell')
    .then((r) => r.json())
    .catch(() => null)
  check('状态读口如实报告挂载模式', state?.mode === 'attach' && typeof state?.attach === 'string',
    JSON.stringify({ mode: state?.mode, attach: state?.attach }))
} else {
  check('上游不可达时报错（没起来，无法断言）', false, '第二个实例没起来')
}
try { deadExe.kill() } catch { /* 已经退了 */ }
try {
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
  ], { stdio: 'ignore' })
} catch { /* 收尸失败不影响结论 */ }

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('ATTACH ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
