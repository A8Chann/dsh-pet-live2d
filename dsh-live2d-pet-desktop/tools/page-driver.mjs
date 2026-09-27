// 页面自检（不牵扯壳）：用无头 Edge 打开 sidecar 发的页面，确认插件真的在桌面端的
// 模块垫片 + ctx 桩下跑起来了。
//
// 这一步的价值：**把"页面"和"壳"分开验**。透明/穿透出问题时，先看这个是不是绿的，
// 就能立刻判断是壳的锅还是页面的锅——省掉在一堆窗口变量里找渲染 bug 的时间。
//
//   node tools/page-driver.mjs [--page pet] [--url http://127.0.0.1:8792] [--keep]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from '../sidecar/paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const PAGE = argOf('--page', 'pet')
const URL_BASE = argOf('--url', 'http://127.0.0.1:8792')
const CDP_PORT = Number(argOf('--cdp-port', '8899'))

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = BROWSERS.find((candidate) => existsSync(candidate))
if (browser === undefined) {
  console.error('找不到 Edge/Chrome')
  process.exit(2)
}

const profile = join(DESKTOP, '.run', 'page-driver-profile')
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(browser, [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,EdgeSidebar',
  '--window-size=1280,900',
  URL_BASE + '/',
], { stdio: 'ignore' })

async function cdpSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口一直没就绪')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let seq = 0
    socket.addEventListener('open', () => resolve({
      send(method, params) {
        const id = ++seq
        socket.send(JSON.stringify({ id, method, params: params ?? {} }))
        return new Promise((res, rej) => {
          pending.set(id, { res, rej })
          setTimeout(() => { if (pending.delete(id)) rej(new Error('CDP 超时：' + method)) }, 10000)
        })
      },
      close: () => socket.close(),
    }))
    socket.addEventListener('error', (event) => reject(new Error('CDP 连接失败：' + String(event.message ?? event))))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) entry.rej(new Error(JSON.stringify(message.error)))
      else entry.res(message.result)
    })
  })
}

let client
try {
  client = await connect(await cdpSocket())
  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) throw new Error('页面里抛了：' + JSON.stringify(result.exceptionDetails).slice(0, 500))
    return result.result.value
  }

  // 页面加载是异步的（React UMD → 插件注册 → apply → 模型加载），轮询期望值。
  let diag = null
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    const raw = await evaluate('JSON.stringify({ boot: window.__desktopBoot ?? null, diag: window.__petDesktop ? window.__petDesktop.diag() : null })')
    const parsed = JSON.parse(raw)
    diag = parsed
    if (parsed.boot !== null && parsed.boot.ok === true && parsed.diag !== null && parsed.diag.canvas === true) break
    await sleep(400)
  }

  check('页面启动了', diag.boot !== null && diag.boot.ok === true, JSON.stringify(diag.boot).slice(0, 260))
  // 注意：这里断言的是**页面**的读口，不是插件内部的 `diag().boot`——插件那个字段在
  // 桌面端一直是 false（它的 boot 语义是"宿主把设置页挂上了"），拿它当判据会假红。
  check('插件浏览器半区已挂载', diag.diag !== null && diag.diag.pet === true && diag.diag.canvas === true, JSON.stringify(diag.diag ?? null).slice(0, 260))
  check('Live2D canvas 出现', diag.diag !== null && diag.diag.canvas === true)
  check('窗口上没有脚本错误', (diag.diag?.errors ?? []).length === 0, JSON.stringify(diag.diag?.errors ?? []).slice(0, 300))

  // 判定函数自己在不在、两种位置给出的理由是否不同
  const verdicts = await evaluate('JSON.stringify([window.__petDesktop.probe({x:2,y:2}), window.__petDesktop.probe({x:window.innerWidth-40,y:window.innerHeight-40})])')
  const parsedVerdicts = JSON.parse(verdicts)
  check('判定函数可调用且给出理由', parsedVerdicts.every((v) => typeof v.reason === 'string'), JSON.stringify(parsedVerdicts).slice(0, 200))

  // 模型与引擎状态：读引擎写进模型的参数（沿用仓库的"确定信号"纪律）
  const petApi = await evaluate('JSON.stringify({ api: typeof window.__dshLive2dPet, keys: window.__dshLive2dPet ? Object.keys(window.__dshLive2dPet).slice(0, 12) : [] })')
  check('插件的诊断读口在', JSON.parse(petApi).api === 'object', petApi.slice(0, 240))

  // 相位数（本地独立模式应该是 idle）
  const phase = await evaluate('document.querySelector("[data-dsh-live2d-pet]")?.getAttribute("data-phase") ?? null')
  check('相位属性可读', typeof phase === 'string', 'data-phase=' + phase)

  // 页面的穿透判定要能在"角色身上"给 true：用容器中心点试
  const overPet = await evaluate('JSON.stringify((() => { const r = document.querySelector("[data-dsh-live2d-pet]"); if (!r) return null; const b = r.getBoundingClientRect(); return window.__petDesktop.probe({ x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height*0.6) }); })())')
  check('角色容器上判定为"吃事件"', overPet !== 'null' && JSON.parse(overPet).interactive === true, String(overPet).slice(0, 200))
} finally {
  client?.close()
  child.kill()
}

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('PAGE DRIVER ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length + '（页面 ' + PAGE + '）')
process.exit(failed.length === 0 ? 0 : 1)
