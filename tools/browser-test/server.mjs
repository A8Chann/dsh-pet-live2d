// Verification server: mounts the plugin's REAL route table on a plain node
// http server, plus a minimal page that stands in for the DSH shell (React UMD
// + a fake __ModuleLoader__). Nothing here ships; it exists so the plugin can
// be driven end-to-end from a headless browser.
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HERE, PLUGIN, PROFILES } from './paths.mjs'

const PORT = Number(process.argv[2] ?? 8793)

// Load the plugin's host half straight from source, so the server always tests
// the working tree rather than a copy.
const host = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
const { buildRoutes, ActivityHub, attachActivityEvents } = host

// The harness stands in for the DSH host, so it owns the activity hub too.
//
// It supplies a REAL (if tiny) event bus rather than a no-op ctx. That matters:
// with a stub, attachActivityEvents registered nothing and every phase test had
// to drive the hub through /__nudge, so the plugin's actual host-event wiring
// was never exercised — which is how a subscription to the non-existent
// 'tool/call' event survived a green suite while the pet ignored tool activity
// in the real DSH. The bus below lets /__emit fire the genuine event names.
const listeners = new Map()
const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
    return () => {
      const list = listeners.get(event) ?? []
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    }
  },
}
const emit = async (event, ...args) => {
  const out = []
  for (const handler of listeners.get(event) ?? []) out.push(await handler(...args))
  return out
}

const hub = new ActivityHub()
attachActivityEvents(bus, hub)

// 显示层路由也要挂上：客户端每秒问一次 `/api/live2d-pet/layer`，而**没有路由的 harness
// 会让它 404**，于是 `cdp-exp` 那条"没有失败的插件请求"断言会红（实测 5 个 404）。
// 用**真的** `createDisplayLayer`（不是假响应）：这样"设置页读到的显示层状态"走的也是
// 产品代码，顺手把 `/layer` 这条链在宿主侧也验了。
//
// home 指向一个可丢弃目录：绝不能让它读写用户真正的 `%DSH_HOME%\pet-desktop.json`。
//
// ⚠️ **必须按端口隔离**（`-<PORT>` 后缀）。原来所有 driver 共用 `.profiles/_layer-home`
// 一个目录，于是**前一个 driver 改过的设置会留给下一个**：`cdp-gaze` 会把右手池压成
// "只剩掏出手机"并写进这里的 `pet-settings.json`，紧接着跑的 `cdp-head` 断言的却是
// "没有哪个手部选项占绝对多数" —— 它读到那份存档，160/160 全是掏出手机，**必红**。
// 实测（2026-10）：`run-suite.mjs gaze head` 稳定复现，`head` 单独跑必绿；
// 在**改动之前**的提交（17e45b9）上同样复现 ⇒ 是测试夹具的串扰，不是产品回归。
// 每个 driver 有自己的服务器端口（`run-suite.mjs` 的 `PET_PORT_BASE + slot`），
// 所以按端口分目录 = 每个 driver 一份干净存档。
const { createDisplayLayer } = await import(pathToFileURL(join(PLUGIN, 'lib', 'display.js')).href)
const displayHome = join(PROFILES, '_layer-home-' + PORT)
mkdirSync(displayHome, { recursive: true })
const displayLayer = createDisplayLayer({
  home: displayHome,
  hint: 'harness: 没有桌面端二进制',
  resolveBinary: () => undefined,
  log: () => {},
})
displayLayer.binaryInfo = () => ({ found: false, path: null, source: null, supported: true, hint: 'harness' })

// 共享设置也挂上：driver 要能验证"宿主是权威、另一个窗口改了会同步过来"。
// home 用同一个可丢弃目录（按端口隔离，见上）—— 绝不能碰用户真正的 `%DSH_HOME%\pet-settings.json`。
const routes = buildRoutes(hub, displayLayer, displayHome)
const byPath = new Map(routes.filter((r) => r.kind === 'exact').map((r) => [r.path, r]))
const prefixes = routes.filter((r) => r.kind === 'prefix').sort((a, b) => b.path.length - a.path.length)

// ---- 模拟 DSH NEXT 的 `dsh-app:` 协议门禁（issue #10）----
//
// 设了 `PET_GATE_TOKEN` 之后，**资产路径**（`/api/live2d-pet/asset/*`）的请求不带
// `x-pet-gate` 一律 403、空 body —— 与真实门禁的行为对应（那一版只给"主窗口帧发出的
// 请求"补令牌，而 Electron 不把自定义协议上的 Worker 请求交给 webRequest，于是 Worker
// 里的 fetch 永远没有令牌）。
//
// 这里用"页面给主线程 fetch 补头"来复刻同一条差别：页面自己的请求带令牌、blob Worker
// 里的请求带不上。**只拦资产路径**是刻意的：真实门禁补令牌是在网络层（`<script>`/`<img>`
// 也能带上），而这里的垫片只能包 `fetch`；把范围收到贴图/模型这条路上，夹具才既像真机构、
// 又不至于把加载 vendor 与 core 的 `<script>` 也拦掉。
//
// 门禁默认是**关**的，由 driver 经 `/__gate?on=1` 打开，于是同一个 server 既能跑
// "能用 Worker"的对照，也能跑"Worker 被拦"的场景。
const GATE = process.env.PET_GATE_TOKEN ?? ''
const GATED_PREFIX = '/api/live2d-pet/asset/'
let gateOn = false
/** 资产请求的到达记录：带没带令牌，用来断言"这次到底走了哪条路"。 */
const gateSeen = []

const gateScript = () => '<script>(function () {'
  + '  const TOKEN = ' + JSON.stringify(GATE) + ';'
  + '  const gated = (target) => target.origin === location.origin && target.pathname.startsWith("/api/");'
  + '  const realFetch = window.fetch;'
  + '  window.fetch = function (input, init) {'
  + '    try {'
  + '      const href = typeof input === "string" ? input : ((input && input.url) || String(input));'
  + '      if (gated(new URL(href, location.href))) {'
  + '        const headers = new Headers((init && init.headers) || undefined);'
  + '        headers.set("x-pet-gate", TOKEN);'
  + '        init = Object.assign({}, init, { headers });'
  + '      }'
  + '    } catch (error) { /* 拼不出绝对地址就原样发 */ }'
  + '    return realFetch.call(this, input, init);'
  + '  };'
  // 引擎自己还有一条 XHR 加载器（moc3 / 动作 / physics / model3.json 都走它）。
  // 真机的令牌是网络层补的，fetch 与 XHR 一样有；这里只能自己给两条都补上。
  + '  const realOpen = XMLHttpRequest.prototype.open;'
  + '  XMLHttpRequest.prototype.open = function (method, url) {'
  + '    this.__petGateUrl = url;'
  + '    return realOpen.apply(this, arguments);'
  + '  };'
  + '  const realSend = XMLHttpRequest.prototype.send;'
  + '  XMLHttpRequest.prototype.send = function () {'
  + '    try {'
  + '      if (gated(new URL(String(this.__petGateUrl), location.href))) this.setRequestHeader("x-pet-gate", TOKEN);'
  + '    } catch (error) { /* 同上 */ }'
  + '    return realSend.apply(this, arguments);'
  + '  };'
  + '})();</script>'

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const pathname = url.pathname

  if (pathname === '/__gate') {
    if (url.searchParams.has('on')) gateOn = url.searchParams.get('on') === '1'
    if (url.searchParams.has('reset')) gateSeen.length = 0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ configured: GATE !== '', on: gateOn, requests: gateSeen }))
    return
  }

  if (GATE !== '' && gateOn && pathname.startsWith(GATED_PREFIX)) {
    const carried = req.headers['x-pet-gate'] === GATE
    gateSeen.push({ path: pathname, carried })
    if (!carried) {
      // 空 body —— 真实门禁就是 `new Response(null, { status: 403 })`。
      res.writeHead(403)
      res.end()
      return
    }
  }

  // A/B/C renderer comparison: ?variant=X swaps which client bundle the page
  // loads, so one checkout can exercise several builds.
  if (pathname === '/' || pathname === '/blank') {
    const variant = url.searchParams.get('variant')
    let page = readFileSync(join(HERE, 'index.html'), 'utf8')
    if (variant) page = page.replace('/plugins/dsh-pet-live2d/client.js', '/variants/client-' + variant + '.js')
    if (GATE !== '') page = page.replace('<script src="/react.js"></script>', gateScript() + '<script src="/react.js"></script>')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  if (pathname === '/harness.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(join(HERE, 'harness.js')))
    return
  }
  if (pathname === '/react.js' || pathname === '/react-dom.js') {
    // Served from the harness' own dependencies, so no UMD copy is vendored.
    const rel = pathname === '/react.js'
      ? join('react', 'umd', 'react.development.js')
      : join('react-dom', 'umd', 'react-dom.development.js')
    const file = join(HERE, 'node_modules', rel)
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('missing ' + file + ' -- run npm install in tools/browser-test first.')
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(file))
    return
  }
  // 和真实的 DSH 一样按**包名**寻址：/plugins/<包名>/client.js
  if (pathname === '/plugins/dsh-pet-live2d/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
    res.end(readFileSync(join(PLUGIN, 'lib', 'client.js')))
    return
  }
  if (pathname === '/index-before.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(join(HERE, 'index-before.html')))
    return
  }
  if (pathname.startsWith('/variants/')) {
    // The DBG variant is generated HERE, from the live client source, on every
    // request.
    //
    // It used to be a file on disk rebuilt by the suite runner, which meant any
    // driver run directly (or before the runner got to it) loaded a copy from
    // whenever it was last generated — and silently tested yesterday's code.
    // That trap has now cost two debugging sessions; generating it removes the
    // possibility rather than documenting it.
    if (pathname === '/variants/client-DBG.js') {
      const ANCHOR = '        model = loaded;\n        modelRef.current = loaded;'
      const HOOK = [
        '',
        '        if (typeof window !== "undefined") {',
        '          window.__PET_DBG = {',
        '            app,',
        '            get model() { return app.stage.children.find((c) => c.internalModel !== undefined) ?? null; },',
        '            get core() { const m = app.stage.children.find((c) => c.internalModel !== undefined); return m ? m.internalModel.coreModel : null; },',
        '          };',
        '        }',
      ].join('\n')
      const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
      if (!source.includes(ANCHOR)) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('client.js: variant anchor not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
      res.end(source.replace(ANCHOR, ANCHOR + HOOK))
      return
    }
    const file = join(HERE, pathname.slice(1))
    if (!existsSync(file)) { res.writeHead(404); res.end('missing ' + file); return }
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(file))
    return
  }
  if (pathname === '/__nudge') {
    const phase = url.searchParams.get('phase') || 'idle'
    if (phase === 'done') hub.celebrate()
    else hub.set(phase, '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(hub.snapshot().phase)
    return
  }

  // Fire a REAL DSH lifecycle event through the bus, so the plugin's own
  // subscriptions are what the assertions observe. Waterfall events get a
  // trailing next() so a handler that resumes the chain can be detected.
  if (pathname === '/__emit') {
    const event = url.searchParams.get('event') || ''
    const name = url.searchParams.get('name') || ''
    let resumed = false
    // 链 resume 的那一刻宠物在演什么。waterfall 型的事件（提问、写文件）**整个挂在链上**，
    // 等 handler 返回时相位早回落了 —— 不在这里当场记一笔，`asking` 根本观测不到。
    let phaseAtNext = null
    const next = async () => { resumed = true; phaseAtNext = hub.snapshot().phase; return { kind: 'accept' } }
    const payload = event.startsWith('tools/')
      ? { name, callId: 'test-call', parent: undefined }
      : { status: name, agent: {} }
    const seen = listeners.get(event)
    const handlers = seen ?? []
    for (const handler of handlers) {
      try { await handler(payload, next) } catch (error) { console.error('emit ' + event + ': ' + error) }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      event, handlers: handlers.length, resumed, phaseAtNext, phase: hub.snapshot().phase,
    }))
    return
  }

  const exact = byPath.get(pathname)
  if (exact !== undefined) { exact.handler(req, res); return }
  for (const route of prefixes) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) { route.handler(req, res); return }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('no route: ' + pathname)
})

server.listen(PORT, '127.0.0.1', () => console.log('test server on http://127.0.0.1:' + PORT))
