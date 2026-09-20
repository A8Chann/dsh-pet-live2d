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
await sleep(3000)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok, detail }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const attr = (n) => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.(' + JSON.stringify(n) + ')')

// --- the plugin must actually subscribe to the live event names ------------
const emitTool = await api('/__emit?event=tools/pre-execute&name=read')
check('tools/pre-execute has a subscriber', emitTool.handlers > 0, 'handlers=' + emitTool.handlers)
check('tools/pre-execute resumes the waterfall chain', emitTool.resumed === true, 'resumed=' + emitTool.resumed)
check('a tool call moves the hub to the tool phase', emitTool.phase === 'tool', 'phase=' + emitTool.phase)

// --- and the pet must follow it --------------------------------------------
await sleep(1200)
check('pet reports the tool phase', (await attr('data-phase')) === 'tool', 'data-phase=' + await attr('data-phase'))
const motionDuringTool = await attr('data-motion')
check('pet plays its tool motion', motionDuringTool === 'Ketchup', 'data-motion=' + motionDuringTool)

// --- a long phase keeps animating instead of falling back to idle ----------
// Ketchup's own duration is a few seconds; watch well past it and require that
// the pet is STILL on the phase motion rather than parked on the idle loop.
let stillBusy = true
for (let i = 0; i < 14; i++) {
  await sleep(1000)
  if ((await attr('data-motion')) !== 'Ketchup') { stillBusy = false; break }
}
check('the tool phase sustains its animation past one motion length', stillBusy,
  'data-motion after 14s = ' + await attr('data-motion'))
check('the sustained pet still reports kind=phase', (await ev('window.__dshLive2dPet.kind()')) === 'phase',
  'kind=' + await ev('window.__dshLive2dPet.kind()'))

// --- returning from the tool must drop back to the idle loop ---------------
const after = await api('/__emit?event=tools/post-execute&name=read')
check('tools/post-execute leaves the tool phase', after.phase === 'thinking', 'phase=' + after.phase)
await sleep(1500)
check('pet stops sustaining once the tool returns', (await ev('window.__dshLive2dPet.sustained()')) === null,
  'sustained=' + await ev('window.__dshLive2dPet.sustained()'))

// --- a turn ending celebrates, then settles --------------------------------
const turn = await api('/__emit?event=agent/turn-stopping&name=done')
check('agent/turn-stopping drives the done phase', turn.phase === 'done', 'phase=' + turn.phase)
check('pet celebrates', (await attr('data-motion')) === 'BubbleGum', 'data-motion=' + await attr('data-motion'))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
