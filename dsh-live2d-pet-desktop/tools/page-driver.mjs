// 页面自检：**只验页面**（插件浏览器半区在桌面端的模块垫片 + ctx 桩下跑得起来），
// 不碰透明、穿透、托盘那些壳的行为。
//
// 翻成 Rust 宿主之后它不再自己起无头 Edge：宿主现在是壳里的一个模块，没有"单跑"模式。
// 所以它直接接管**壳里那个 WebView**（要壳带 `PET_DESKTOP_CDP=8823` 起来），只读页面
// 侧的状态。壳那一半归 `desktop-driver.mjs`。
//
//   node tools/page-driver.mjs [--page pet] [--port 8823]
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const PAGE = argOf('--page', 'pet')
const CDP_PORT = Number(argOf('--port', process.env.PET_CDP_PORT ?? '8823'))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpSocket(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list')
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('CDP 端口 ' + port + ' 上没有页面 —— 壳起了吗？带 PET_DESKTOP_CDP 了吗？')
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
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error('CDP 超时：' + method))
          }, 10000)
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
  client = await connect(await cdpSocket(CDP_PORT))
} catch (error) {
  console.error(String(error && error.message))
  process.exit(2)
}

const evaluate = async (expression) => {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error('页面里抛了：' + JSON.stringify(result.exceptionDetails).slice(0, 500))
  }
  return result.result.value
}

// 页面加载是异步的（React UMD → 插件注册 → apply → 模型加载），轮询**期望值**。
let diag = null
const deadline = Date.now() + 40000
while (Date.now() < deadline) {
  const raw = await evaluate('JSON.stringify({ boot: window.__desktopBoot ?? null, diag: window.__petDesktop ? window.__petDesktop.diag() : null })')
  diag = JSON.parse(raw)
  if (diag.boot?.ok === true && diag.diag?.canvas === true) break
  await sleep(400)
}

const SPIKE = PAGE === 'spike'
check('页面启动了', diag.boot !== null && diag.boot.ok === true, JSON.stringify(diag.boot).slice(0, 260))
check('页面带桌面端标记', diag.diag !== null)
if (!SPIKE) {
  check('插件浏览器半区已挂载', diag.diag?.pet === true, JSON.stringify(diag.diag ?? null).slice(0, 200))
  check('Live2D canvas 出现', diag.diag?.canvas === true)
  check('窗口上没有脚本错误', (diag.diag?.errors ?? []).length === 0, JSON.stringify(diag.diag?.errors ?? []).slice(0, 300))
  const petApi = await evaluate('String(typeof window.__dshLive2dPet)')
  check('插件的诊断读口在', petApi === 'object', 'typeof=' + petApi)
  const phase = await evaluate('document.querySelector("[data-dsh-live2d-pet]")?.getAttribute("data-phase") ?? null')
  check('相位属性可读', typeof phase === 'string', 'data-phase=' + phase)
}

// 判定函数：两个位置必须给出理由（这是穿透链的入口，坏了壳那边全废）。
const verdicts = await evaluate('JSON.stringify([window.__petDesktop.probe({x:2,y:2}), window.__petDesktop.probe({x:window.innerWidth-40,y:window.innerHeight-40})])')
const parsed = JSON.parse(verdicts)
check('判定函数可调用且给出理由', parsed.every((v) => typeof v.reason === 'string'), JSON.stringify(parsed).slice(0, 200))

client.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('PAGE DRIVER ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length + '（页面 ' + PAGE + '）')
process.exit(failed.length === 0 ? 0 : 1)
