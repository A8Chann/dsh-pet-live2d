// 壳的自检驱动：不开浏览器、不截图，全靠**读口**断言。
//
// 它做三件事：
//
//   1. 从 WebView2 的 CDP 端口接管页面，读 `window.__petDesktop.diag()`；
//   2. 用 SetCursorPos 真的把系统光标挪到两个位置（角色身上 / 空白角落），
//      中间穿插真实的鼠标移动——**"忽略光标事件"这件事只有真的动光标才验得出来**；
//   3. 每一步都读壳的 `shell_state`，把"判定 -> 忽略状态"这条链子对到底。
//
// 退出码就是结论：0 = 全通过。断言失败会打印每一行的实测值。
//
//   node desktop-driver.mjs [--page pet] [--port-pet 8823]
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const PAGE = argOf('--page', 'pet')
/**
 * WebView2 的调试端口。
 *
 * 壳带 `PET_DESKTOP_CDP=<port>` 时才开（默认关着——发布版不该在本机留一个谁都能接管的
 * 调试端口）。所以这里**直接用约定的端口**去 HTTP 探活，而不是去翻
 * `DevToolsActivePort` 文件：那个文件在 WebView2 里的落点随版本变，找它只是自找麻烦。
 */
const PORT = Number(argOf('--port', process.env.PET_CDP_PORT ?? '8823'))

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: ok === true, detail: detail ?? '' })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询"期望值"，不要轮询"稳定"——稳定在低帧率下会把半途的值当终值。 */
async function until(label, probe, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (predicate(last)) return last
    await sleep(120)
  }
  throw new Error('超时：' + label + '，最后一次读到 ' + JSON.stringify(last))
}

// ------------------------------------------------------------------ WebView2

/** 等 WebView2 的调试端口起来（壳启动到页面可接管大约 1–3 秒）。 */
async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = '未尝试'
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list')
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page.webSocketDebuggerUrl
      last = '端口在，但没有 page 目标：' + JSON.stringify(targets.map((t) => t.type))
    } catch (error) {
      last = String(error && error.message)
    }
    await sleep(300)
  }
  throw new Error('CDP 端口 ' + port + ' 一直没就绪（最后一次：' + last + '）——壳起了吗？带 PET_DESKTOP_CDP 了吗？')
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
          }, 8000)
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

async function makeEval(client) {
  return async function evaluate(expression) {
    const result = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error('页面里抛了：' + JSON.stringify(result.exceptionDetails).slice(0, 400))
    }
    return result.result.value
  }
}

// -------------------------------------------------------------------- 系统侧

/**
 * 真的把系统光标挪过去。这是本驱动的关键一步：**"忽略光标事件"这件事只有真的动光标
 * 才验得出来**——不设这个标志的话 Windows 会把命中测试交给下层窗口，页面收不到移动，
 * 整个判定链根本不会动。
 */
function setCursor(x, y) {
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -Namespace W -Name C -MemberDefinition \'[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);\';' +
    '[void][W.C]::SetCursorPos(' + Math.round(x) + ',' + Math.round(y) + ')',
  ], { stdio: 'ignore' })
}

// ----------------------------------------------------------------------- 主流程

let client
try {
  client = await connect(await waitForCdp(PORT))
} catch (error) {
  console.error(String(error && error.message))
  process.exit(2)
}
const evaluate = await makeEval(client)

// 壳的状态从 sidecar 读（壳每 33ms 把它写进 .run/shell-state.json）。
// POST 会等**下一份新鲜的**：刚挪完光标就立刻 GET，读到的可能还是挪之前那一份。
let shellState = null
async function refreshShell(waitMs = 600) {
  // sidecar 的地址直接从页面 URL 推：窗口加载的就是它。
  const origin = await evaluate('location.origin')
  const response = await fetch(origin + '/__desktop/shell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ waitMs }),
  })
  shellState = await response.json()
  return shellState
}
const shellStateNow = () => shellState

const SPIKE = PAGE === 'spike'
/** 要验的"实心东西"是谁：spike 是那只气球，桌宠页是 Live2D 画布。 */
const SOLID_SELECTOR = SPIKE ? '#balloon' : '[data-dsh-live2d-pet]'

console.log('--- 页面（' + PAGE + '），CDP 端口 ' + PORT)

// 1. 页面与启动
//
// 页面可能是**壳上一轮留下的旧文档**（改完 sidecar/page/*.js 之后没重载，跑的就是旧代码
// ——这类假红最费时间）。所以：文档已经加载完、但读口不在，就主动重载一次再等。
const boot = await until('页面启动', async () => {
  const raw = await evaluate('JSON.stringify({ boot: window.__desktopBoot ?? null, diag: (window.__petDesktop ?? {}).diag ? window.__petDesktop.diag() : null, ready: document.readyState, url: location.href })')
  const parsed = JSON.parse(raw)
  if (parsed.boot === null && parsed.ready === 'complete') {
    console.log('（页面读口不在，重载一次页面：' + parsed.url + '）')
    await evaluate('location.reload()').catch(() => {})
    await sleep(1500)
  }
  return raw
}, (raw) => JSON.parse(raw).boot !== null, 25000)
const booted = JSON.parse(boot)
check('页面已启动', booted.boot.ok === true, JSON.stringify(booted.boot).slice(0, 200))
if (SPIKE) {
  // spike 页没有插件：它验的是**壳**（透明 / 穿透 / 性能），不是渲染。
  check('spike 页与判定运行时就绪', booted.diag !== null && booted.boot.spike === true, JSON.stringify(booted.diag ?? {}).slice(0, 200))
} else {
  check('插件浏览器半区已挂载', booted.diag !== null && booted.diag.pet === true && booted.diag.canvas === true, JSON.stringify(booted.diag ?? {}).slice(0, 300))
}

// 2. 要验的实心元素真的存在（spike 的气球 / 桌宠的画布）
const SOLID_JS = JSON.stringify(SOLID_SELECTOR)
const solidExpr = 'JSON.stringify((() => {'
  + ' const host = document.querySelector(' + SOLID_JS + ');'
  + ' const canvas = host ? host.querySelector("canvas") : null;'
  + ' if (canvas) return { found: true, size: [canvas.width, canvas.height] };'
  + ' if (host) { const b = host.getBoundingClientRect(); return { found: true, size: [Math.round(b.width), Math.round(b.height)] }; }'
  + ' return { found: false, size: null };'
  + '})())'
const solid = JSON.parse(await until('实心元素出现', () => evaluate(solidExpr), (raw) => JSON.parse(raw).found === true, 30000))
check(SPIKE ? 'spike 气球已渲染' : 'Live2D canvas 已建立', solid.found === true, 'size=' + JSON.stringify(solid.size))

// 3. 壳 ↔ sidecar
await refreshShell(1200)
const state = shellStateNow()
check('壳已连上 sidecar', typeof state.sidecarUrl === 'string' && state.sidecarUrl.startsWith('http://127.0.0.1:'), String(state.sidecarUrl))
check('窗口是全屏透明层', Array.isArray(state.windowSize) && state.windowSize[0] > 800 && state.windowSize[1] > 600, JSON.stringify(state.windowSize))
check('穿透轮询在跑', state.probes > 0, 'probes=' + state.probes + ' errors=' + state.probeErrors)

// 4. 空白处 → 应该穿透
const origin = state.windowOrigin ?? [0, 0]
const scale = state.scale || 1
const emptyPoint = { x: 150, y: 320 }
setCursor(origin[0] + emptyPoint.x * scale, origin[1] + emptyPoint.y * scale)
const overEmpty = await until('空白处判定', () => refreshShell(500), (s) => Array.isArray(s.cursorLocal) && Math.abs(s.cursorLocal[0] - emptyPoint.x) < 8, 10000)
check('空白处判定为"穿透"', overEmpty.interactive === false, 'reason=' + overEmpty.lastReason + ' local=' + JSON.stringify(overEmpty.cursorLocal))
check('空白处窗口忽略光标事件', overEmpty.ignored === true, 'ignored=' + overEmpty.ignored)

// 5. 实心处 → 应该吃事件
//
// 目标点不能瞎猜：桌宠页的剪影是**模型当前帧**的三角面，而且判定要等命中遮罩抓完一帧；
// spike 页的气球还在慢慢上下浮动。所以先问页面"这几个候选点里哪个真的实心"（连续三次
// 都判 true 才算稳），再拿它去动系统光标。
const box = JSON.parse(await evaluate('JSON.stringify((() => { const r = document.querySelector(' + JSON.stringify(SOLID_SELECTOR) + '); if (!r) return null; const b = r.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } })())'))
check(SPIKE ? '找得到气球' : '找得到角色容器', box !== null, JSON.stringify(box))
let target = null
if (box !== null) {
  const candidates = SPIKE
    ? [[0.5, 0.5], [0.5, 0.45], [0.45, 0.5], [0.55, 0.5]]
    : [[0.5, 0.55], [0.5, 0.62], [0.45, 0.6], [0.55, 0.6], [0.5, 0.7]]
  const deadline = Date.now() + 25000
  while (Date.now() < deadline && target === null) {
    for (const [fx, fy] of candidates) {
      const pt = { x: Math.round(box.left + box.width * fx), y: Math.round(box.top + box.height * fy) }
      const hits = JSON.parse(await evaluate('JSON.stringify([1,2,3].map(() => window.__petDesktop.probe(' + JSON.stringify(pt) + ').interactive))'))
      if (hits.every((hit) => hit === true)) { target = pt; break }
    }
    if (target === null) await sleep(500)
  }
  check(SPIKE ? '页面上找得到气球上的点' : '页面上找得到"她"身上的点（等命中遮罩就绪）', target !== null, JSON.stringify(target))
}
if (target !== null) {
  setCursor(origin[0] + target.x * scale, origin[1] + target.y * scale)
  const overPet = await until('实心处判定', () => refreshShell(500), (s) => Array.isArray(s.cursorLocal) && s.interactive === true, 8000).catch(() => null)
  if (overPet === null) {
    check('实心处判定为"吃事件"', false, 'target=' + JSON.stringify(target) + ' 实测 local=' + JSON.stringify(shellState?.cursorLocal) + ' reason=' + shellState?.lastReason + ' probes=' + shellState?.probes)
  } else {
    check('实心处判定为"吃事件"', overPet.interactive === true, 'reason=' + overPet.lastReason)
    check('实心处窗口吃光标事件', overPet.ignored === false, 'ignored=' + overPet.ignored)
  }
}

// 6. 判定函数本身：两个位置给的理由必须不同
const verdicts = JSON.parse(await evaluate('JSON.stringify([window.__petDesktop.probe({ x: 150, y: 320 }), window.__petDesktop.probe(' + JSON.stringify(target ?? { x: 10, y: 10 }) + ')])'))
check('页面判定给出两种不同理由', verdicts[0].reason !== verdicts[1].reason, verdicts.map((v) => v.reason).join(' vs '))

// 7. 切换是"只在跨越边界时发生"，不是在每一个轮询里抖
const settled = await refreshShell(900)
await sleep(1200)
const stillSettled = await refreshShell(900)
check('判定切换不抖动（静止 1.2s 内没有新的切换）', stillSettled.changes === settled.changes, 'changes ' + settled.changes + ' -> ' + stillSettled.changes + '，probes ' + settled.probes + ' -> ' + stillSettled.probes)

// 8. 状态文件在持续更新（壳活着、轮询没停）
check('壳的状态在持续更新', stillSettled.probes > settled.probes && stillSettled.uptimeMs > settled.uptimeMs, 'probes +' + (stillSettled.probes - settled.probes) + '，uptime ' + stillSettled.uptimeMs + 'ms')

// 9. 读口齐备（托盘/退出属于 M1，这里只确认排查用的字段都在）
check('壳的调试读口齐备', ['probes', 'changes', 'probeErrors', 'active', 'ignored', 'windowSize', 'scale'].every((k) => k in state), Object.keys(state).join(','))

client.close()

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('DRIVER ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length + '（页面 ' + PAGE + '）')
process.exit(failed.length === 0 ? 0 : 1)
