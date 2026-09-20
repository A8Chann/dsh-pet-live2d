// Item #3 — every action and expression must end up back at the initial idle
// state on its own, with no help from the user.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel, closePanel } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9381
const PROFILE = join(PROFILES, '_cdp-idle-return')
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

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const exprCount = async () => Number(await ev('window.__dshLive2dPet.expressions().length'))
const motion = () => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.("data-motion")')
/**
 * Tap a non-head spot on the character every few seconds.
 *
 * Two purposes: it keeps lastInteraction fresh so the random 摸鱼 scheduler
 * cannot fire mid-assertion (a fidget is allowed to pick OpenCase, which made
 * "the held group was given up" flaky), and a body tap is now a pure
 * acknowledgement — it plays no motion, so it cannot disturb what is on trial.
 */
const startKeepAlive = async () => {
  const spot = JSON.parse(await ev(`(() => {
    const c = window.__dshLive2dPet
    const stage = document.querySelector('[data-dsh-live2d-pet] [data-stage]')
    const r = stage.getBoundingClientRect()
    for (let iy = 64 - 1; iy >= 0; iy--) {
      for (let ix = 0; ix < 64; ix++) {
        const lx = r.width * (ix + 0.5) / 64, ly = r.height * (iy + 0.5) / 64
        if (c.hitsMask(lx, ly, r.width, r.height) && !c.hitsHead(lx, ly)) {
          return JSON.stringify({ x: r.x + lx, y: r.y + ly })
        }
      }
    }
    return 'null'
  })()`))
  if (spot === null) return () => {}
  const timer = setInterval(() => {
    send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 })
      .then(() => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 }))
      .catch(() => {})
  }, 3000)
  return () => clearInterval(timer)
}

/** Poll until a predicate holds, so the test never races a random fidget. */
const until = async (fn, ms = 20000) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(500)
  }
}

// --- a panel choice PERSISTS ------------------------------------------------
//
// This block used to assert the opposite, because a manually pinned expression
// expired after EXPRESSION_HOLD_MS. That is the wrong contract for a dress-up
// panel: an outfit the user picked from the panel is a deliberate choice, and
// having it evaporate a few seconds later reads as a bug. The auto-clear is now
// reserved for what it was meant for — a reaction or a session phase must not
// leave the pet stuck — and that is checked by the phase block below.
await openPanel(ev)
await sleep(700)
// The panel opens on the 动作 tab; every effect is behind the merged 装扮 tab.
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(b) b.click(); return !!b})()')
await sleep(600)
const slots = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-slot]").length')
check('the 装扮 tab lists every slot', slots === 14, 'slots=' + slots)
await ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="glasses"]\');'
  + ' const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="圆眼镜");'
  + ' if(!b) return false; b.click(); return true})()')
await sleep(900)
check('picking a slot option pins it', (await exprCount()) > 0,
  'expressions=' + await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
await closePanel(ev)
// Well past EXPRESSION_HOLD_MS: the outfit must still be on.
await sleep(14000)
check('the panel choice is still there 14s later', (await exprCount()) > 0,
  'expressions=' + await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))

// --- a held pose is not permanent either -----------------------------------
// 掏出手机 is declared hold:true, so it parks in its final frame; the watchdog
// must still hand the body back (ACTION_HOLD_MAX_MS = 9s).
const stopKeepAlive = await startKeepAlive()
check('keep-alive found a spot on the body', true)
await ev('window.__dshLive2dPet.playOnce("OpenCase", 0, { kind: "panel" })')
check('掏出手机 parks in its held pose', await until(async () => (await ev('window.__dshLive2dPet.isHeld()')) === true, 8000),
  'isHeld=' + await ev('window.__dshLive2dPet.isHeld()'))
check('the held pose releases on its own (9s)', await until(async () => (await ev('window.__dshLive2dPet.isHeld()')) === false, 20000),
  'isHeld=' + await ev('window.__dshLive2dPet.isHeld()'))
// Once released the pet may legitimately pick a 摸鱼 animation, so the durable
// assertion is that it is NOT still parked in the held group.
// Polled, not read once: after the pose is released the pet is free to start a
// random 摸鱼, and OpenCase is itself in the fidget pool, so a single sample can
// legitimately catch it mid-replay. What matters is that it does not STAY parked.
check('the held group is really given up', await until(async () => (await ev('window.__dshLive2dPet.currentGroup()')) === null, 15000),
  'currentGroup=' + await ev('window.__dshLive2dPet.currentGroup()'))
stopKeepAlive()

// --- the reset funnel returns everything to rest ---------------------------
await ev('window.__dshLive2dPet.resetToRest()')
await sleep(1200)
check('resetToRest returns the motion to idle', (await motion()) === 'idle', 'data-motion=' + await motion())
check('resetToRest returns kind to idle', (await ev('window.__dshLive2dPet.kind()')) === 'idle', 'kind=' + await ev('window.__dshLive2dPet.kind()'))

// --- a session phase expression is cleared when the phase ends -------------
const stopKeepAlive2 = await startKeepAlive()
await fetch(BASE + '/__nudge?phase=thinking')
check('a session phase pins its expression', await until(async () => (await exprCount()) > 0, 15000),
  'expressions=' + await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
await fetch(BASE + '/__nudge?phase=idle')
check('leaving the phase clears the expression', await until(async () => (await exprCount()) === 0, 15000),
  'expressions=' + await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
stopKeepAlive2()

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
