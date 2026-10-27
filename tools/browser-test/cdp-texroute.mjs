// 贴图取法：blob Worker 能用就用 Worker，被协议门禁拦住就退回主线程（issue #10）。
//
// 夹具复刻 DSH NEXT 2.0.20-next 的那道门禁（server.mjs 的 `PET_GATE_TOKEN`）：
// `/api/*` 不带 `x-pet-gate` 一律 403、空 body；页面（主线程）的 fetch 由注入的垫片
// 补头，blob Worker 里的 fetch 补不上 —— 与 Electron 不给自定义协议上的 Worker 请求
// 补令牌是同一条差别。
//
// 两幕（同一个 server、同一个页面，改门禁开关后重载）：
//   ① 门禁关：贴图走 Worker —— 证明修复不是"一刀切成主线程"（桌面端/网页端不受影响）；
//   ② 门禁开：同一地址 Worker 403 / 主线程 200，宠物必须照样加载，且取图走主线程。
//
// 判据全部是确定性的：页面自己的探测结果、插件报的取法、server 侧记录的"贴图请求带没带
// 令牌"。截图与"看着画出来了"都不算 —— 后者在 Worker 恰好能用时同样成立。
//
// 退出码即结论：任一断言失败退出 1。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { browserPath, PROFILES } from './paths.mjs'
import { waitReady, killBrowser } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

const EDGE = browserPath()
const CDP_PORT = 9388
const SERVER_PORT = 8897
const GATE_TOKEN = 'harness-gate'
const BASE = 'http://127.0.0.1:' + SERVER_PORT
const PROFILE = join(PROFILES, '_cdp-texroute')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

const children = []
const cleanup = () => {
  for (const child of children) {
    try { child.kill() } catch { /* 已经退了 */ }
  }
}

// ---- 夹具 server：带令牌配置，门禁默认关 ------------------------------------
rmSync(PROFILE, { recursive: true, force: true })
const server = spawn(
  process.execPath,
  [fileURLToPath(new URL('./server.mjs', import.meta.url)), String(SERVER_PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PET_GATE_TOKEN: GATE_TOKEN } },
)
children.push(server)
let serverUp = false
for (let i = 0; i < 80 && !serverUp; i++) {
  try {
    serverUp = (await fetch(BASE + '/api/live2d-pet/catalog')).ok
  } catch { /* 还没起来 */ }
  if (!serverUp) await sleep(100)
}
if (!serverUp) {
  console.error('测试服没起来（' + BASE + '）')
  cleanup()
  process.exit(1)
}

const gateInfo = async (query = '') => (await fetch(BASE + '/__gate' + query)).json()

// 模型地址：门禁按路径前缀拦，模型 JSON 与贴图同属 `/api/live2d-pet/asset/*`，
// 拿它当"Worker 能不能取到插件资产"的探针。
const catalog = await (await fetch(BASE + '/api/live2d-pet/catalog')).json()
const modelPath = catalog.pets?.[0]?.modelUrl
if (typeof modelPath !== 'string') {
  console.error('catalog 里没有 modelUrl，夹具不对：' + JSON.stringify(catalog).slice(0, 300))
  cleanup()
  process.exit(1)
}
const modelUrl = BASE + modelPath

// ---- 无头 Edge + CDP --------------------------------------------------------
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
children.push(edge)

let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()).find((t) => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
if (page === undefined) {
  console.error('无头 Edge 没起来（CDP ' + CDP_PORT + '）')
  cleanup()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
/** 页面发出的请求与失败：只在断言红了时打印，用来回答"到底是谁没发出去 / 谁被拦了"。 */
const netLog = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Network.requestWillBeSent') {
    const url = String(m.params.request.url)
    if (url.includes('/api/live2d-pet/asset/')) netLog.push('→ ' + m.params.request.method + ' ' + url.replace(BASE, ''))
  }
  if (m.method === 'Network.loadingFailed') netLog.push('✗ ' + String(m.params.errorText) + ' (' + m.params.type + ')')
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    netLog.push('!! ' + String(d.exception?.description ?? d.text).slice(0, 400))
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    netLog.push('.. ' + m.params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 300))
  }
}
const send = (a, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.result?.exceptionDetails !== undefined) {
    throw new Error('页面里抛了：' + JSON.stringify(result.result.exceptionDetails).slice(0, 300))
  }
  return result.result?.result?.value
}
await send('Runtime.enable')
await send('Page.enable')
// 缓存必须关掉：上一幕成功取过的贴图会命中浏览器缓存，第二幕就不会再发请求，
// 门禁等于没开、断言也就变成"读了缓存里的旧字节"。真机上撞 403 的资源从来进不了缓存。
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

/** 页面里自己发一次 blob Worker 的 fetch，返回 HTTP 状态（失败回 'error'）。 */
const workerStatus = (url) => ev(`new Promise((resolve) => {
  const code = "self.onmessage = (event) => { fetch(event.data).then("
    + "(response) => self.postMessage(response.status),"
    + "(error) => self.postMessage('error:' + ((error && error.message) || error))) };"
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  worker.onmessage = (event) => { worker.terminate(); resolve(event.data) }
  worker.onerror = () => { worker.terminate(); resolve('error') }
  worker.postMessage(${JSON.stringify(url)})
})`)

const mainStatus = (url) => ev(`fetch(${JSON.stringify(url)}).then((response) => response.status)`)

const transport = () => ev('window.__dshLive2dPet && window.__dshLive2dPet.textureTransport ? window.__dshLive2dPet.textureTransport() : "missing"')
const pageErrors = () => ev('JSON.stringify(window.__errors || [])')

/** 失败时的现场：页面上写着什么、点击遮罩有没有做出来、模型有没有报错。 */
const pageState = async () => {
  try {
    return await ev(`JSON.stringify({
      title: document.title,
      errors: window.__errors || [],
      boot: window.__bootError || null,
      hint: (document.querySelector('[data-dsh-live2d-pet] [data-hint]') || {}).textContent || null,
      pet: document.querySelectorAll('[data-dsh-live2d-pet]').length,
      canvas: (() => { const c = document.querySelector('[data-dsh-live2d-pet] canvas'); return c ? [c.width, c.height] : null })(),
      mask: window.__dshLive2dPet && window.__dshLive2dPet.maskInfo ? window.__dshLive2dPet.maskInfo() : null,
    })`)
  } catch (error) {
    return 'pageState 读不到：' + String(error && error.message)
  }
}

const load = async (url) => {
  await send('Page.navigate', { url })
  const booted = await waitForBoot(ev)
  const ready = booted ? await waitReady(ev) : false
  return { booted, ready }
}

let failed = false
try {
  // ---- ① 门禁关：Worker 照常用于取图 ---------------------------------------
  await gateInfo('?on=0&reset=1')
  const first = await load(BASE + '/')
  const firstTransport = await transport()
  check('门禁关：页面就绪', first.booted)
  check('门禁关：宠物加载完成（Worker 取图可用）', first.ready)
  check('门禁关：贴图仍走 Worker', firstTransport === 'worker', 'textureTransport=' + firstTransport)
  check('门禁关：页面没有未捕获异常', (await pageErrors()) === '[]', await pageErrors())

  // ---- ② 门禁开：Worker 被拦，宠物必须退回主线程 ---------------------------
  await gateInfo('?on=1&reset=1')
  const second = await load(BASE + '/')
  const secondTransport = await transport()

  // 先证明夹具真的在拦：同一地址 Worker 403、主线程 200。
  const worker = await workerStatus(modelUrl)
  const main = await mainStatus(modelUrl)
  check('门禁开：blob Worker 取资产被拦（403）', worker === 403, 'worker=' + worker)
  check('门禁开：主线程取同一地址是 200', main === 200, 'main=' + main)

  check('门禁开：页面就绪', second.booted)
  check('门禁开：宠物照样加载完成（issue #10 的核心）', second.ready)
  check('门禁开：贴图取法退回主线程', secondTransport === 'main-thread', 'textureTransport=' + secondTransport)
  check('门禁开：页面没有未捕获异常', (await pageErrors()) === '[]', await pageErrors())
  if (!second.ready) console.log('  现场：' + await pageState())
  if (!second.ready) console.log('  网络：\n    ' + netLog.slice(-14).join('\n    '))

  // server 侧的证据：门禁打开后，贴图请求全部带令牌（= 全部由主线程发出）。
  const log = await gateInfo()
  const textures = (log.requests || []).filter((entry) => entry.path.endsWith('.png'))
  const untrusted = textures.filter((entry) => entry.carried !== true)
  check('门禁开：贴图确实被请求过（夹具没空转）', textures.length >= 2, 'textures=' + textures.length)
  if (textures.length === 0) console.log('  到达 server 的资产请求：' + JSON.stringify((log.requests || []).slice(0, 8)))
  check('门禁开：贴图请求全部由主线程发出（带令牌）', untrusted.length === 0,
    untrusted.length === 0 ? '' : JSON.stringify(untrusted.slice(0, 4)))
} catch (error) {
  failed = true
  console.error('驱动中断：' + String((error && error.stack) || error))
} finally {
  try { ws.close() } catch { /* 已关 */ }
  killBrowser(edge)
  cleanup()
}

failed = failed || results.some((entry) => !entry.ok)
console.log(failed ? 'TEXROUTE_FAIL' : 'TEXROUTE_OK')
process.exit(failed ? 1 : 0)
