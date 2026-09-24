// Item #4 — the session stream must drive the pet through the REAL DSH event
// names, and a long phase must keep its animation running.
//
// This is the test that would have caught the original bug: the plugin
// subscribed to 'tool/call', which is a session-LOG event rather than a cordis
// lifecycle event, so it never fired. Asserting on /__emit proves the plugin's
// own subscriptions work, which /__nudge never could.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9377
const PROFILE = join(PROFILES, '_cdp-host-events')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const api = async (path) => JSON.parse(await (await fetch(BASE + path)).text())

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok, detail }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const attr = (n) => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.(' + JSON.stringify(n) + ')')
/** Poll until a predicate holds, so assertions never race an async hop. */
const until = async (fn, ms = 10000) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

// --- the plugin must actually subscribe to the live event names ------------
const emitTool = await api('/__emit?event=tools/pre-execute&name=read')
check('tools/pre-execute has a subscriber', emitTool.handlers > 0, 'handlers=' + emitTool.handlers)
check('tools/pre-execute resumes the waterfall chain', emitTool.resumed === true, 'resumed=' + emitTool.resumed)
check('a tool call moves the hub to the tool phase', emitTool.phase === 'tool', 'phase=' + emitTool.phase)

// --- and the pet must follow it --------------------------------------------
await sleep(1200)
check('pet reports the tool phase', (await attr('data-phase')) === 'tool', 'data-phase=' + await attr('data-phase'))
// The tool look, not the Ketchup motion: Ketchup also drives 蛋包饭 and 挤压, so
// it painted omurice and ketchup on screen during every tool call. The hand
// writing on the tablet is what shows now.
const toolFaces = await ev('JSON.stringify(window.__dshLive2dPet.expressions())')
// Assert on the pinned set, not on slotSelections: the phase layer is what put
// the brush there, and slotSelections only tracks the user's own picks.
check('pet takes the tool look', toolFaces.includes('点菜按下'), 'expressions=' + toolFaces)
check('the tool look never shows 蛋包饭 or 挤番茄酱',
  !toolFaces.includes('蛋包饭') && !toolFaces.includes('挤番茄酱'), toolFaces)
check('the tool look keeps a brush or eraser in hand', /画笔|橡皮/.test(toolFaces), toolFaces)

// --- a long phase keeps animating instead of falling back to idle ----------
// Sample where the pen is, well past any one-shot's length. The sweep is a
// generated curve, so a hand that stopped is the failure being looked for.
let stillMoving = false
let previous = null
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const pen = await ev('JSON.stringify(window.__dshLive2dPet.sweepPosition())')
  if (pen === null || pen === undefined) { previous = pen; continue }
  if (previous !== null && pen !== previous) { stillMoving = true; break }
  previous = pen
}
// Demanding a NON-NULL first sample: the sweep is what carries this phase, so
// "no sweep at all" must fail rather than satisfy a vacuous comparison.
check('the tool phase sustains its animation past one motion length', stillMoving,
  'pen samples ended at ' + previous)
check('the sustained pet still reports kind=phase', (await ev('window.__dshLive2dPet.kind()')) === 'phase',
  'kind=' + await ev('window.__dshLive2dPet.kind()'))

// --- returning from the tool must drop back to the idle loop ---------------
// The revert is debounced (TOOL_IDLE_MS) so consecutive tools in one turn do
// not flap the phase and restart the animation.
const post = await api('/__emit?event=tools/post-execute&name=read')
check('tools/post-execute does not revert instantly', post.phase === 'tool', 'phase=' + post.phase)
// Polled, not slept: the revert is a 1200ms debounce plus an SSE hop, and under
// a loaded parallel suite both stretch. A fixed sleep raced it and reported a
// real behaviour as a failure.
const steppedDown = await until(async () => (await attr('data-phase')) === 'thinking', 10000)
check('the tool phase steps down once tools stop', steppedDown, 'data-phase=' + await attr('data-phase'))
await sleep(1500)
check('pet stops sustaining once the tool returns', (await ev('window.__dshLive2dPet.sustained()')) === null,
  'sustained=' + await ev('window.__dshLive2dPet.sustained()'))

// --- consecutive tool calls must not flap the phase ------------------------
// Drive three calls back to back with a gap shorter than the debounce and
// require the phase to have stayed on 'tool' the whole way.
// First pair: wait for the phase to actually ARRIVE before judging anything.
// Polling a fixed 300ms sampled the value from before the SSE hop landed and
// reported that latency as a flap.
await api('/__emit?event=tools/pre-execute&name=read')
await api('/__emit?event=tools/post-execute&name=read')
const arrived = await until(async () => (await attr('data-phase')) === 'tool', 10000)
check('a tool call reaches the pet', arrived, 'data-phase=' + await attr('data-phase'))
// Now two more back-to-back pairs. The 1200ms debounce must absorb them, so
// every sample taken right after a pair is still on 'tool'.
let flapped = !arrived
for (let i = 0; i < 2 && !flapped; i++) {
  await api('/__emit?event=tools/pre-execute&name=read')
  await api('/__emit?event=tools/post-execute&name=read')
  if ((await attr('data-phase')) !== 'tool') flapped = true
}
check('consecutive tools do not flap the phase', !flapped, 'data-phase=' + await attr('data-phase'))
await sleep(2000)
await api('/__emit?event=tools/pre-execute&name=read')
await api('/__emit?event=tools/post-execute&name=read')
await sleep(2000)
check('a lone tool still steps down afterwards', (await attr('data-phase')) === 'thinking', 'data-phase=' + await attr('data-phase'))

// --- DSH 0.1.7 新接的三个状态 ------------------------------------------------
// 事件词汇表不小（0.1.7 的 `*.d.ts` 里声明了 100 个可订阅事件），但只有一部分能翻译成
// "宠物该演什么"。接的三个填的都是**真实的空档**，没接的（fs/write-intent、workflow/*）
// 理由写在 lib/index.js 的注释里。
// 先回一个干净的起点。
await api('/__emit?event=agent/status&name=running')
await sleep(300)
// ① 向你提问：waterfall 一直挂到你把问题答完，所以 asking 正好等于"卡在等你"的那段。
//    相位要在 next() 那一刻读 —— handler 返回时链已经 resume、相位早回落了。
const asking = await api('/__emit?event=user-questions/request&name=which')
check('user-questions/request 有订阅者', asking.handlers > 0, 'handlers=' + asking.handlers)
check('提问会 resume 链（否则会卡住整个问答）', asking.resumed === true)
check('提问期间宠物演 asking（以前还在演"干活"）',
  asking.phaseAtNext === 'asking', 'phaseAtNext=' + asking.phaseAtNext)
// ② 子代理：长活，和一次普通工具调用分开。
const helper = await api('/__emit?event=subagent/start&name=explore')
check('子代理跑起来进入 helper', helper.phase === 'helper', 'phase=' + helper.phase)
await api('/__emit?event=subagent/end&name=explore')
check('子代理结束回到 thinking',
  (await api('/__emit?event=agent/status&name=running')).phase === 'thinking')
// ③ 消息排队：短促一个"收到"，然后回到刚才在演的东西。
const queued = await api('/__emit?event=tools/pre-execute&name=read')
check('先让宠物在 tool 相位', queued.phase === 'tool', 'phase=' + queued.phase)
const inbox = await api('/__emit?event=agent/inbox/inserted&name=hi')
check('消息排队时给一个短促的 queued 反应', inbox.phase === 'queued', 'phase=' + inbox.phase)
// 读**客户端镜像的** data-phase 来观察回落：用 `/__emit` 去轮询相位本身就是扰动
// （每发一次 `agent/status:running` 就把相位按回 thinking，永远看不到 tool）。
const backToTool = await until(async () => (await attr('data-phase')) === 'tool', 5000)
check('queued 是短促的：回落到排队前那个相位（tool），不是一律回 idle',
  backToTool, 'data-phase=' + await attr('data-phase'))

// --- a turn ending celebrates, then settles --------------------------------
const turn = await api('/__emit?event=agent/turn-stopping&name=done')
check('agent/turn-stopping drives the done phase', turn.phase === 'done', 'phase=' + turn.phase)
// Polled: the phase reaches the client over SSE, and under a loaded parallel
// suite that hop is not instantaneous. Reading data-motion once raced it.
const celebrated = await until(async () => (await attr('data-motion')) === 'BubbleGum', 8000)
check('pet celebrates', celebrated, 'data-motion=' + await attr('data-motion'))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
