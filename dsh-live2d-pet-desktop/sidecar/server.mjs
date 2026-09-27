// 桌面端的本地回环服务器（sidecar）。
//
// 为什么是"进程 + HTTP"而不是把插件翻成 Rust：
//
//   * `dsh-live2d-pet/lib/index.js`（宿主半区）是**平台无关的 Node**——宠物发现、
//     `pet.json` 解析、模型引用闭包白名单、Cubism Core 缓存全在里面，唯一的外部
//     假设是"有个 webServer 能挂路由"。翻成 Rust 就是第二份实现，而且是一份已经
//     修过好几个 bug、有回归测试的实现。
//   * 浏览器半区只认 `API = "/api/live2d-pet"` 这个**同源相对路径**：把它挂在本机
//     回环上，`lib/client.js` 一个字都不用改就能跑（fetch 目录、EventSource 相位、
//     资产路由全部照旧）。
//
// 所以这里只做三件事：起一个回环端口、把插件的真路由表挂上去、把页面发出去。
// 壳负责窗口、透明、穿透；插件负责宠物；两边都不需要知道对方的存在。
//
// 唯一的一条协议是启动时 stdout 上那一行 `PET_SIDECAR {...}`：壳从里面拿端口和
// "穿透判定表达式"。运行期只走 HTTP。
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP, PLUGIN, RUN } from './paths.mjs'
import { createDshLink } from './dsh-link.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

/** 0 = 让系统分配空闲端口；壳从握手行里读实际端口。 */
const WANT_PORT = Number(argOf('--port', process.env.PET_DESKTOP_PORT ?? '0'))
/** `spike` 用极简页面（只验壳能力），`pet` 挂真的 lib/client.js。 */
const PAGE = argOf('--page', process.env.PET_DESKTOP_PAGE ?? 'pet')
/** 静态页面目录：开发期用仓库里的副本，打包后换成随包的 dist。 */
const PAGE_DIR = resolve(argOf('--page-dir', join(DESKTOP, 'sidecar', 'page')))
/**
 * 要挂的 DSH。默认 `http://127.0.0.1:3080`（`dsh web` 的默认地址）；传 `none` 就纯本地独立。
 * 连不上不是错误：宠物照样站着、照样自己摸鱼，只是不跟着会话换相位。
 */
const DSH_BASE = argOf('--dsh', process.env.PET_DESKTOP_DSH ?? 'http://127.0.0.1:3080')

/** 桌面端自己的接口前缀（和插件无关，只给壳与页面用）。 */
const DESKTOP_API = '/__desktop'

// ---------------------------------------------------------------- 插件路由
//
// 直接 import 工作区里的插件源码，不 import npm 装下来的副本：桌面端与插件必须
// 同源。否则会出现"改了插件、桌面端还在跑旧逻辑"，这种两边不一致最难查。
const host = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
const { buildRoutes, ActivityHub, attachActivityEvents } = host

// 事件总线：桌面端没有 DSH 的 ctx（它在另一个进程里），所以给一个只会抛的桩。插件的每个
// 订阅都写在 try/catch 里（老宿主缺某个事件时本来就这么兜），所以桩不会炸——相位改由下面
// 的 SSE 桥直接喂给 hub。
const stubCtx = { on() { throw new Error('desktop sidecar: no in-process dsh event bus') } }
const hub = new ActivityHub()
attachActivityEvents(stubCtx, hub)

/**
 * 跟着会话走：订阅运行中 DSH 的相位流，喂给本地 hub。
 *
 * 注意这条链的两段分工：**DSH 里的插件宿主半区**负责把 12 个 DSH 事件折成 9 个相位
 * （含 tool → thinking 的 1200ms 防抖、done 的 3.5 秒回落），桌面端只是订阅者。所以
 * 桌面上演的相位语义和网页端**必然一致**，不是两套实现。
 */
const dshLink = DSH_BASE === 'none'
  ? { state: { base: 'none', connected: false, disabled: true }, dispose() {} }
  : createDshLink({ base: DSH_BASE, hub, log: (message) => console.log(message) })

const routes = buildRoutes(hub)
const exact = new Map(routes.filter((r) => r.kind === 'exact').map((r) => [r.path, r]))
const prefixes = routes.filter((r) => r.kind === 'prefix').sort((a, b) => b.path.length - a.path.length)

// ------------------------------------------------------------------ 页面静态

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function sendFile(response, file) {
  const full = resolve(file)
  if (!full.startsWith(PAGE_DIR)) {
    response.writeHead(403)
    response.end()
    return
  }
  if (!existsSync(full)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('missing: ' + full)
    return
  }
  const body = readFileSync(full)
  response.writeHead(200, {
    'content-type': MIME[full.slice(full.lastIndexOf('.'))] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    // 桌面端没有构建步骤，页面改完就该立刻生效——别让缓存把它藏起来。
    'cache-control': 'no-store',
  })
  response.end(body)
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 穿透判定：**页面来领任务**（见 sidecar/page/desktop.js 的说明）。
 *
 * 任务挂在这里，页面每 20ms 来领一次；领到就算、算完就回。壳那边只是在等一个 HTTP
 * 响应，所以它完全不知道中间还隔了一个渲染进程。
 *
 * 判定**只可能在渲染进程里做**——右键面板、气泡这些 DOM 盒子的位置只有布局知道；
 * 剪影那部分由 `lib/client.js` 自己管。而坐标只能由壳给（窗口一旦忽略光标事件，
 * Windows 就把命中测试交给下层窗口，页面根本收不到鼠标移动；Electron 是靠
 * `forward: true` 额外喂消息解决的，Tauri 没有这个开关）。
 */
const PROBE_WAIT_MS = 2500
let PROBE_SEQ = 0
let PROBE_TASK = null
let PROBE_STATS = { asked: 0, answered: 0, dropped: 0, lastReason: '' }

/**
 * 壳的状态文件。
 *
 * 壳每 33ms 写一次（`src-tauri/src/lib.rs` 的 `write_state`），这里只负责读出来挂成
 * `GET /__desktop/shell`。**为什么绕文件而不是 IPC**：页面是从 loopback 加载的，
 * Tauri 对远程源默认拒绝自定义命令（实测 `shell_state not allowed. Plugin not found`），
 * 走通得开远程 IPC 权限——那正好和"别给发布版留后门"相反。文件这条路不需要任何权限，
 * 而且换壳（Electron / 系统 WebView）时照样成立：谁能写一个 JSON 谁就能当壳。
 */
const SHELL_STATE_FILE = join(RUN, 'shell-state.json')

function readShellState() {
  try {
    return JSON.parse(readFileSync(SHELL_STATE_FILE, 'utf8'))
  } catch {
    return { ok: false, reason: 'no-shell-state', file: SHELL_STATE_FILE }
  }
}

// -------------------------------------------------------------------- 服务器

const server = createServer((request, response) => {
  let url
  try {
    url = new URL(request.url ?? '/', 'http://pet.local')
  } catch {
    response.writeHead(400)
    response.end()
    return
  }
  const pathname = url.pathname

  // 壳每 ~33ms 来问一次"光标下面是页面还是桌面"。任务挂起来，等页面来领。
  //
  // 这个请求**一直挂到页面回答**（或者 PROBE_WAIT_MS 超时）才回。踩过的坑：早先版本
  // 是"能答就答、答不了就回 pending 立刻结束"，而页面领到任务通常要 10–20ms，于是壳
  // 的每一次请求都恰好落在"还没答"的窗口里，永远读到 pending、永远判 false——
  // 表面上像"判定完全没生效"，实际上是回得太早。**要等，不要回占位符。**
  if (pathname === DESKTOP_API + '/probe' && request.method === 'POST') {
    readBody(request).then((raw) => {
      let point = {}
      try {
        point = JSON.parse(raw || '{}')
      } catch {
        /* 空 body = 用上一次的坐标再判一次 */
      }
      PROBE_SEQ += 1
      PROBE_STATS.asked += 1
      const task = {
        seq: PROBE_SEQ,
        x: Number.isFinite(point.x) ? point.x : null,
        y: Number.isFinite(point.y) ? point.y : null,
        screenX: point.screenX,
        screenY: point.screenY,
        answer: null,
        done: null,
      }
      // 上一个任务还没被领走就被顶掉：这是"页面卡住"的信号，记一笔。
      if (PROBE_TASK !== null && PROBE_TASK.answer === null) PROBE_STATS.dropped += 1
      PROBE_TASK = task

      const startedAt = Date.now()
      const finish = (verdict) => {
        if (task.done !== null) return
        task.done = verdict
        if (task.answer === null) {
          task.answer = verdict
          PROBE_STATS.dropped += 1
        }
        try {
          json(response, 200, verdict)
        } catch {
          /* 壳已经不等了 */
        }
      }
      const tick = () => {
        if (task.done !== null) return
        if (task.answer !== null) {
          finish(task.answer)
          return
        }
        if (Date.now() - startedAt >= PROBE_WAIT_MS) {
          finish({ interactive: false, reason: 'probe-timeout' })
          return
        }
        setTimeout(tick, 4).unref?.()
      }
      tick()
    }, () => json(response, 400, { interactive: false, reason: 'bad-body' }))
    return
  }

  // 页面来领任务。
  if (pathname === DESKTOP_API + '/probe/pending') {
    const task = PROBE_TASK
    if (task === null || task.answer !== null) {
      json(response, 200, { ok: false, reason: task === null ? 'no-task' : 'answered' })
      return
    }
    json(response, 200, { ok: true, seq: task.seq, x: task.x, y: task.y, screenX: task.screenX, screenY: task.screenY })
    return
  }

  // 页面交答案。
  if (pathname === DESKTOP_API + '/probe/answer' && request.method === 'POST') {
    readBody(request).then((raw) => {
      let answer = {}
      try {
        answer = JSON.parse(raw || '{}')
      } catch {
        /* 坏 body：当成"不知道" */
      }
      const task = PROBE_TASK
      if (task !== null && task.seq === answer.seq) {
        task.answer = {
          interactive: answer.interactive === true,
          reason: typeof answer.reason === 'string' ? answer.reason : '',
          at: Date.now(),
        }
        PROBE_STATS.answered += 1
        PROBE_STATS.lastReason = task.answer.reason
      }
      json(response, 200, { ok: true, seq: answer.seq })
    }, () => json(response, 400, { ok: false }))
    return
  }

  // 壳的状态（driver 的读口）：`GET` 直接给，`POST` 等**下一份新鲜的**再给——
  // 驱动刚挪完光标就 POST，如果立刻回，读到的可能还是挪之前那一份。
  if (pathname === DESKTOP_API + '/shell') {
    if (request.method === 'GET') {
      json(response, 200, readShellState())
      return
    }
    if (request.method === 'POST') {
      readBody(request).then((raw) => {
        let waitMs = 900
        try {
          const asked = JSON.parse(raw || '{}')
          if (Number.isFinite(asked.waitMs)) waitMs = Math.min(4000, Math.max(0, asked.waitMs))
        } catch {
          /* 空 body = 用默认等待 */
        }
        const startedAt = Date.now()
        const before = readShellState()
        const tick = () => {
          const now = readShellState()
          const fresh = now.uptimeMs !== undefined && now.uptimeMs !== before.uptimeMs
          if (fresh || Date.now() - startedAt >= waitMs) {
            json(response, 200, now)
            return
          }
          setTimeout(tick, 25)
        }
        tick()
      }, () => json(response, 400, { ok: false, reason: 'bad-body' }))
      return
    }
  }

  // 壳的探活 + 自检读口：`GET /__desktop/ping` 能一眼看出 sidecar 活着、
  // 用的是哪个页面、插件发现了几只宠物、探针任务有没有人在领。
  if (pathname === DESKTOP_API + '/ping') {
    let pets = []
    try {
      pets = host.buildCatalog().map((pet) => ({ id: pet.id, displayName: pet.displayName }))
    } catch (error) {
      pets = ['ERR ' + String((error && error.message) || error)]
    }
    json(response, 200, {
      ok: true,
      page: PAGE,
      pageDir: PAGE_DIR,
      pid: process.pid,
      pets,
      phase: hub.snapshot(),
      dsh: dshLink.state,
      probe: PROBE_STATS,
      shell: readShellState(),
    })
    return
  }

  for (const route of prefixes) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) {
      route.handler(request, response)
      return
    }
  }
  const route = exact.get(pathname)
  if (route !== undefined) {
    route.handler(request, response)
    return
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendFile(response, join(PAGE_DIR, PAGE === 'spike' ? 'spike.html' : 'index.html'))
    return
  }
  // 页面的静态资源，或者 vendor 目录里那份 React UMD。
  const pagePrefixes = [
    ['/page/', join(PAGE_DIR, normalize(decodeURIComponent(pathname.slice('/page/'.length))))],
    ['/react/', join(PAGE_DIR, 'react', normalize(decodeURIComponent(pathname.slice('/react/'.length))))],
  ]
  for (const [prefix, file] of pagePrefixes) {
    if (pathname.startsWith(prefix)) {
      sendFile(response, file)
      return
    }
  }
  // 和真实的 DSH 一样按**包名**寻址，页面里的 script 标签就不必为桌面端改一份。
  if (pathname === '/plugins/dsh-pet-live2d/client.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(readFileSync(join(PLUGIN, 'lib', 'client.js')))
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found: ' + pathname)
})

server.listen(WANT_PORT, '127.0.0.1', () => {
  const { port } = server.address()
  const base = 'http://127.0.0.1:' + port
  // 握手行：壳从 stdout 里读这一行（整个进程间协议就这一行）。
  process.stdout.write('PET_SIDECAR ' + JSON.stringify({
    ok: true,
    url: base,
    port,
    page: PAGE,
    pid: process.pid,
    probeUrl: base + DESKTOP_API + '/probe',
    pingUrl: base + DESKTOP_API + '/ping',
    shellUrl: base + DESKTOP_API + '/shell',
    stateFile: SHELL_STATE_FILE,
  }) + '\n')
})

// 收尸：壳退出（或用户 Ctrl+C）时把端口让出来，别留孤儿进程占着监听。
const bye = () => {
  hub.dispose()
  dshLink.dispose()
  server.close(() => process.exit(0))
  // 还有 keep-alive 连接时不至于卡住不退。
  setTimeout(() => process.exit(0), 300).unref?.()
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
process.stdin.on('end', bye)
