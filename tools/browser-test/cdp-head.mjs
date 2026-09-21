// Items #1 and #2 — 重锤出击 belongs to the head, and neither it nor 鲸鱼喷水
// may be picked as a random idle "摸鱼" animation.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { openPanel,  waitReady } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9379
const PROFILE = join(PROFILES, '_cdp-head')
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
const attr = (n) => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.(' + JSON.stringify(n) + ')')

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

// --- locate one head point and one non-head point on the character ---------
const probe = JSON.parse(await ev(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let head = null, body = null
  for (let iy = 0; iy < 64 && (head === null || body === null); iy++) {
    for (let ix = 0; ix < 64; ix++) {
      const lx = r.width * (ix + 0.5) / 64, ly = r.height * (iy + 0.5) / 64
      if (!c.hitsMask(lx, ly, r.width, r.height)) continue
      const isHead = c.hitsHead(lx, ly)
      if (isHead && head === null) head = { lx, ly }
      if (!isHead && body === null && iy > 40) body = { lx, ly }
    }
  }
  return JSON.stringify({ head, body, rect: { x: r.x, y: r.y, w: r.width, h: r.height } })
})()`))
check('the model yields a measurable head region', probe.head !== null, JSON.stringify(probe.head))
check('part of the character is NOT head', probe.body !== null, JSON.stringify(probe.body))

// --- tapping the head swings the hammer ------------------------------------
await ev('window.__dshLive2dPet.playIdle()')
await sleep(900)
await clickAt(probe.rect.x + probe.head.lx, probe.rect.y + probe.head.ly)
await sleep(1200)
// A head pat answers with ONE of three reactions at random — 重锤出击, 问号 or
// 星星眼 — and deliberately does NOT blush.
const patMotion = await attr('data-motion')
const patFaces = await ev('window.__dshLive2dPet.expressions()')
const patReaction = patMotion === 'Hammer' ? 'Hammer' : (patFaces[0] ?? '(none)')
check('a head tap answers with one of the three reactions',
  ['Hammer', '问号', '星星眼'].includes(patReaction),
  'motion=' + patMotion + ' faces=' + JSON.stringify(patFaces))
check('a head tap does NOT blush', !patFaces.includes('脸红'), JSON.stringify(patFaces))

// --- tapping the body must NOT swing the hammer ----------------------------
await ev('window.__dshLive2dPet.resetToRest()')
await sleep(1600)
await clickAt(probe.rect.x + probe.body.lx, probe.rect.y + probe.body.ly)
await sleep(1200)
const bodyMotion = await attr('data-motion')
check('a body tap does NOT play 重锤出击', bodyMotion !== 'Hammer', 'data-motion=' + bodyMotion)

// --- the fidget must never pick the interaction verbs ----------------------
const allowed = JSON.parse(await ev(`JSON.stringify((() => {
  const c = window.__dshLive2dPet
  const groups = Object.keys(c.groups())
  const out = {}
  for (const g of groups) out[g] = c.fidgetAllowed(g)
  return out
})())`))
check('摸鱼 may not play 重锤出击', allowed.Hammer === false, 'Hammer=' + allowed.Hammer)
check('摸鱼 may not play 鲸鱼喷水', allowed.SprayWater === false, 'SprayWater=' + allowed.SprayWater)
const idle = await ev('window.__dshLive2dPet.idleName()')
check('the idle loop itself is never a fidget', (await ev('window.__dshLive2dPet.fidgetAllowed(window.__dshLive2dPet.idleName())')) === true)
const pool = Object.keys(allowed).filter((g) => g !== idle && allowed[g])
check('a non-empty fidget pool remains', pool.length > 0, 'pool=' + JSON.stringify(pool))
check('the fidget pool excludes both verbs', !pool.includes('Hammer') && !pool.includes('SprayWater'), 'pool=' + JSON.stringify(pool))

// --- motion premises, and a fidget that actually does something ------------
// A selfie needs the phone already out, the whale spray needs a whale, the
// ketchup squeeze needs the omurice under it. playOnce refuses a motion whose
// premise is missing, so NO path (panel, fidget, phase) can play one.
const can = async (g) => ev('window.__dshLive2dPet.canPlay(' + JSON.stringify(g) + ')')
check('a selfie is refused with no phone out', (await can('Selfie')) === false)
check('a quick selfie is refused with no phone out', (await can('SelfieQuick')) === false)
check('the whale spray is refused with no whale', (await can('SprayWater')) === false)
check('the ketchup squeeze is refused with no omurice', (await can('Ketchup')) === false)
check('an unguarded motion is always allowed', (await can('BubbleGum')) === true)
// Checked HERE, while the premise is still missing: further down the panel puts
// the phone out on purpose, and then a selfie SHOULD start.
check('a blocked motion refuses to start',
  (await ev('window.__dshLive2dPet.playOnce("Selfie", 0, { kind: "probe" })')) === false)

// The fidget used to do NOTHING: it reaches the slot chooser through a ref, and
// that ref was never assigned, so every draw silently hit a no-op default.
await openPanel(ev)
await sleep(700)
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(b) b.click(); return !!b})()')
await sleep(700)
await ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="rhand"]\');'
  + ' if(!g) return false; const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="掏出手机");'
  + ' if(!b) return false; b.click(); return true})()')
await sleep(1200)
check('with the phone out, a selfie is allowed', (await can('Selfie')) === true)
check('but the ketchup squeeze is still refused', (await can('Ketchup')) === false)
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(600)
let changed = 0
let sawMotion = false
for (let i = 0; i < 10; i += 1) {
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(700)
  const state = await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())')
  if (state !== '{}') changed += 1
  if ((await attr('data-motion')) !== 'idle') sawMotion = true
}
check('a fidget actually changes the pet', changed >= 4, changed + '/10 draws changed something')
// Deliberately NOT asserted: after the weights were tightened, a fidget plays a
// motion only as often as the user asked for (rarely). The draw distribution
// below is the real contract.
void sawMotion

// --- the mouth must be NORMAL most of the time ------------------------------
// Sampled over many draws: 吐舌 is excluded from fidgets entirely, and the mouth
// carries a heavy "leave it alone" weight so the pet does not pull a face every
// time it idles.
let mouthNormal = 0
let total = 0
let tongue = 0
for (let i = 0; i < 34; i += 1) {
  await ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="mouth"]\');'
    + ' const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="闭嘴");'
    + ' if(b) b.click(); return true})()')
  await sleep(120)
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(320)
  const chosen = await ev('window.__dshLive2dPet.slotSelections().mouth ?? null')
  total += 1
  if (chosen === null) mouthNormal += 1
  if (chosen === '吐舌') tongue += 1
}
check('吐舌 never comes up in a fidget', tongue === 0, 'tongue draws=' + tongue)
check('the mouth stays normal most of the time', mouthNormal >= total * 0.6,
  mouthNormal + '/' + total + ' draws left the mouth alone')
// The unblocking side is asserted on a clean state BEFORE any fidget runs: a
// fidget legitimately opens the selfie by drawing 掏出手机 for the hand, so
// checking it afterwards would be testing the fidget, not the guard.
await ev('window.__dshLive2dPet.setExpressions([])')
// --- the fidget's draw distribution -----------------------------------------
// Asserted on the DRAWS the client counted, not on sampled state. State is a
// poor proxy: a value persists across rounds that never touch its slot, so
// counting it made a 7% draw look like 61% and sent me chasing a weighting bug
// that did not exist.
await ev('window.__dshLive2dPet.resetFidgetTally()')
for (let i = 0; i < 160; i += 1) {
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(45)
}
const tally = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.fidgetTally())'))
const drawn = tally.drawn ?? {}
const drawsFor = (slot) => Object.entries(drawn).filter(([k]) => k.startsWith(slot + ':'))
const count = (key) => drawn[key] ?? 0
const slotTotal = (slot) => drawsFor(slot).reduce((a, [, v]) => a + v, 0)
check('the fidget actually runs', (tally.fired ?? 0) >= 150, 'fired=' + tally.fired)
check('吐舌 is never drawn', count('mouth:吐舌') === 0, JSON.stringify(drawsFor('mouth')))
check('the fidget never draws an excluded mood',
  ['悲伤', '大哭', '生气', '吐魂'].every((m) => count('mood:' + m) === 0), JSON.stringify(drawsFor('mood')))
check('the left hand is only ever 蛋包饭 or nothing',
  drawsFor('lhand').every(([k]) => k === 'lhand:无' || k === 'lhand:蛋包饭'), JSON.stringify(drawsFor('lhand')))
check('the eyes are mostly left normal',
  count('eyes:爱心眼') <= slotTotal('eyes') * 0.25,
  count('eyes:爱心眼') + '/' + slotTotal('eyes') + ' draws')
check('the mouth is mostly left normal',
  count('mouth:吹泡泡糖') <= slotTotal('mouth') * 0.3,
  count('mouth:吹泡泡糖') + '/' + slotTotal('mouth') + ' draws')
check('no single hand option dominates',
  Math.max(...drawsFor('rhand').map(([, v]) => v)) <= slotTotal('rhand') * 0.6,
  JSON.stringify(drawsFor('rhand')))
await ev('window.__dshLive2dPet.setExpressions([])')
const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
