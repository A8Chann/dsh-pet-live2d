import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel } from './ready.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9381
const URL_TO_OPEN = process.argv[2] ?? BASE + '/'
const PROFILE = join(PROFILES, '_cdp-gaze')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 140; i++) { await sleep(500); if (await ev('document.querySelectorAll("[data-dsh-live2d-pet] canvas").length') > 0) break }
await waitReady(ev)
// Assertions, not printouts: this driver used to end in an unconditional
// process.exit(0) with only console.log output, so it could never fail.
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '   ' + detail))
}
const out = {}
const gaze = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-gaze")')
const geo = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})())'))
const win = JSON.parse(await ev('JSON.stringify([window.innerWidth, window.innerHeight])'))
const move = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(500) }

await move(geo[0] + geo[2] / 2, geo[1] + geo[3] / 2)
check('the pet follows the pointer', (await gaze()) === 'pointer', 'data-gaze=' + await gaze())
await move(geo[0] - 120, geo[1] - 120)
check('just outside the pet still tracks', (await gaze()) === 'pointer', 'data-gaze=' + await gaze())
await move(5, 5)
await move(geo[0] + geo[2] / 2, geo[1] + geo[3] / 2)
// Polled: the CSS/SSE hop under a loaded suite is not instantaneous.
let retracked = false
for (let i = 0; i < 16 && !retracked; i += 1) {
  if ((await gaze()) === 'pointer') retracked = true
  else await sleep(150)
}
check('coming back re-tracks', retracked, 'data-gaze=' + await gaze())

// --- the gaze must SCALE with distance, not snap to full deflection --------
// The engine's own model.focus() runs the point through atan2 and keeps only
// the unit vector, so DISTANCE is discarded: a pointer one pixel off centre
// pulled the head to full deflection, and crossing the centre flipped it from
// full-left to full-right. That is the bug these pin down.
const gazeAt = async (fx, fy) => {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(geo[0] + geo[2] * fx),
    y: Math.round(geo[1] + geo[3] * fy),
  })
  await sleep(600)
  return JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.gazeTarget())'))
}
const middle = await gazeAt(0.5, 0.5)
check('the pointer at the centre is a neutral gaze',
  Math.abs(middle.x) < 0.01 && Math.abs(middle.y) < 0.01, JSON.stringify(middle))
const nudged = await gazeAt(0.53, 0.5)
check('a nudge near the centre is a SMALL gaze change', Math.abs(nudged.x) < 0.3,
  JSON.stringify(nudged) + '  (the old mapping gave full deflection here)')
// Just past the dead zone, so the ramp itself is exercised rather than the
// flat spot: 0.12 of the half-width is deliberately ignored.
const small = await gazeAt(0.60, 0.5)
check('just past the dead zone the gaze has barely moved', small.x > 0 && small.x < 0.25,
  JSON.stringify(small))
const halfway = await gazeAt(0.75, 0.5)
check('halfway out is a substantial gaze', Math.abs(halfway.x) > 0.4 && Math.abs(halfway.x) <= 1,
  JSON.stringify(halfway))
const farEdge = await gazeAt(1.0, 0.5)
check('the edge is full deflection', Math.abs(farEdge.x) > 0.95, JSON.stringify(farEdge))
check('the gaze grows with distance',
  Math.abs(middle.x) <= Math.abs(nudged.x) && Math.abs(nudged.x) <= Math.abs(small.x)
  && Math.abs(small.x) < Math.abs(halfway.x) && Math.abs(halfway.x) <= Math.abs(farEdge.x),
  [middle.x, nudged.x, small.x, halfway.x, farEdge.x].map((v) => v.toFixed(3)).join(' <= '))
// --- the mouth follows the same offset -------------------------------------
// Written per frame at the same seam as everything else. It used to never
// appear at all, because the per-frame pass returned early whenever nothing was
// pinned and no sweep was running.
await gazeAt(0.5, 0.5)
const mouthAt = async (fx, fy) => {
  await gazeAt(fx, fy)
  // The mouth EASES toward the pointer rather than snapping to it, so give it
  // a few time constants to arrive before reading.
  await sleep(700)
  return ev('window.__dshLive2dPet.mouthFollow()')
}
// Read the two mouth parameters straight off the model: the shape claim has to
// be checked on what the engine ends up with, not on our own math.
await ev('(() => {'
  + ' const c = window.__dshLive2dPet'
  + ' })()')
// Settle first: the value is EASED now, so reading it immediately after a move
// catches it mid-travel and reports the previous position.
/**
 * The mouth as written INSIDE the frame, once it has stopped travelling.
 *
 * The ease is frame-rate dependent at the bottom end: a 500ms frame is clamped
 * to a 120ms step, so under parallel load the mouth is still on its way when a
 * fixed sleep claims it should have arrived. That is exactly what made the lean
 * check compare a settled "down" (+/-0.461) against a half-travelled "up"
 * (0.281) and fail on a loaded machine while passing alone. Poll for the
 * asymptote instead of guessing how long the travel takes.
 */
const mouthParams = async () => {
  let last = null
  for (let i = 0; i < 25; i += 1) {
    await sleep(200)
    const now = await ev('JSON.stringify(window.__dshLive2dPet.mouthDebug())')
    if (now === last) return JSON.parse(now)
    last = now
  }
  return JSON.parse(last)
}
const mouthCentre = await mouthAt(0.5, 0.5)
const mouthHalf = await mouthAt(0.75, 0.5)
const mouthEdge = await mouthAt(1.0, 0.5)
const mouthBack = await mouthAt(0.5, 0.5)
check('the mouth is closed with the pointer at the centre', mouthCentre === 0, 'follow=' + mouthCentre)
check('the mouth opens with the pointer offset', mouthHalf > 0.2 && mouthEdge > mouthHalf,
  [mouthCentre, mouthHalf, mouthEdge].map((v) => Number(v).toFixed(3)).join(' < '))
check('the mouth closes again when the pointer comes back', mouthBack === 0, 'follow=' + mouthBack)
// Moving out of range used to snap the mouth open. It must now travel.
await gazeAt(0.5, 0.5)
await sleep(900)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo[0] + geo[2] - 4, y: geo[1] + Math.round(geo[3] / 2) })
await sleep(70)
const midEase = await ev('window.__dshLive2dPet.mouthFollow()')
await sleep(900)
const settled = await ev('window.__dshLive2dPet.mouthFollow()')
check('the mouth EASES toward the pointer instead of snapping',
  midEase > 0 && midEase < settled - 0.05,
  'after 70ms=' + Number(midEase).toFixed(3) + ' settled=' + Number(settled).toFixed(3))
// Opening ParamMouthOpenY alone lifts the UPPER lip, which reads as a gasp.
// The shape has to be pulled negative at the same time so the opening reads as
// the lower jaw dropping — the same thing 吐舌 does, minus the tongue.
/**
 * Put the pointer at (fx, fy) of the CHARACTER's box, wait for the mouth to
 * arrive, and return the resting contribution together with the normalized
 * offset the plugin actually computed for that spot.
 *
 * The measured ny matters: geo is the character's ink box, not the stage, and
 * its centre sits below the stage centre (493+300 vs a 300px stage at y=493 in
 * a 300px box — measured 2026-09: the box centre is 34px low). So fy=0.15 and
 * fy=0.85 are NOT mirror images in normalized space, and the old check that
 * demanded form(up) == -form(down) was asserting a symmetry the geometry does
 * not have. It failed on a loaded machine and passed alone, which is how a
 * driver bug survives: it looks like flakiness.
 */
const mouthRead = async () => JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.mouthDebug())'))
const mouthAtFull = async (fx, fy) => {
  const target = await gazeAt(fx, fy)
  // Poll for the value the geometry SAYS should be there, not for "it stopped
  // changing": a stalled frame clock also stops it changing, and that is how a
  // half-travelled mouth got recorded as a settled one.
  const want = { open: 0.65 * Math.hypot(target.x, target.y), form: -0.7 * target.y }
  let dbg = await mouthRead()
  for (let i = 0; i < 20; i += 1) {
    if (Math.abs(dbg.open - want.open) < 0.03 && Math.abs(dbg.form - want.form) < 0.03) break
    await sleep(200)
    dbg = await mouthRead()
  }
  return { target, follow: await ev('window.__dshLive2dPet.mouthFollow()'), dbg }
}
const mouthRest = await mouthAtFull(0.5, 0.5)
const mouthUp = await mouthAtFull(0.5, 0.15)
const mouthDown = await mouthAtFull(0.5, 0.85)
// Shape follows the pointer VERTICALLY: up leans it the way the author's own
// open-mouth keyframes do, down leans it the other way.
check('the mouth shape leans with the pointer height',
  mouthUp.dbg.form > 0.2 && mouthDown.dbg.form < -0.2,
  'up ' + JSON.stringify(mouthUp.dbg) + ' ny=' + mouthUp.target.y.toFixed(3)
  + '  down ' + JSON.stringify(mouthDown.dbg) + ' ny=' + mouthDown.target.y.toFixed(3))
// The full law, asserted against the offset the plugin computed rather than
// against assumed symmetric positions: the opening is MOUTH_FOLLOW (0.65) of
// the pointer's distance, the lean is MOUTH_DROP (0.7) of its vertical part.
const lawError = (sample) => ({
  open: Math.abs(sample.dbg.open - 0.65 * Math.hypot(sample.target.x, sample.target.y)),
  form: Math.abs(sample.dbg.form + 0.7 * sample.target.y),
})
check('the mouth equals 0.65·|offset| open and -0.7·ny lean at every position',
  [mouthRest, mouthUp, mouthDown].every((s) => lawError(s).open < 0.04 && lawError(s).form < 0.04),
  [mouthRest, mouthUp, mouthDown]
    .map((s) => 'ny=' + s.target.y.toFixed(3) + ' ' + JSON.stringify(s.dbg)).join('  '))
// And with the pointer on the STAGE centre — the only position that is really
// neutral — both contributions must be zero, so nothing is left pinned.
const vw = await ev('window.innerWidth')
const vh = await ev('window.innerHeight')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(vw / 2), y: Math.round(vh / 2) })
await sleep(700)
const neutralTarget = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.gazeTarget())'))
const neutralMouth = await mouthParams()
check('the mouth is shut with the pointer on the stage centre',
  Math.abs(neutralTarget.y) < 0.01 && neutralMouth.open < 0.02 && Math.abs(neutralMouth.form) < 0.02,
  'target ' + JSON.stringify(neutralTarget) + ' ' + JSON.stringify(neutralMouth))
await mouthAt(0.5, 0.5)

// --- the pet must BLINK -----------------------------------------------------
// The engine gates its blink behind "no motion drove parameters this frame",
// and this model's idle loop runs continuously, so that gate never opened and
// the pet never blinked at all. The engine's blink is off and this plugin
// drives one instead, so the only way it can regress is here.
await ev('window.__dshLive2dPet.blinkNow()')
let deepest = 0
let seen = 0
let wasOpen = true
for (let i = 0; i < 90; i += 1) {
  await sleep(60)
  const v = await ev('window.__dshLive2dPet.blinkAmount()')
  if (typeof v !== 'number') continue
  if (v > deepest) deepest = v
  if (wasOpen && v > 0.5) seen += 1
  wasOpen = v === 0
}
check('a blink actually closes the eyes', deepest > 0.8, 'deepest=' + Number(deepest).toFixed(2))
// Polled: a fresh blink can start between the sampling loop ending and this read.
let opened = false
for (let i = 0; i < 20 && !opened; i += 1) {
  if ((await ev('window.__dshLive2dPet.blinkAmount()')) === 0) opened = true
  else await sleep(120)
}
check('the eyes open again after blinking', opened)
// And it must happen on its own, not only when forced: roughly one blink every
// 2.2-6.4s, so a 12s window must contain several.
// Counted by the client, not sampled from here: a blink is ~225ms end to end
// and a CDP round trip is easily 100ms+, so polling missed most of them and
// reported "never blinks" for a pet that blinks perfectly well.
const before = await ev('window.__dshLive2dPet.blinkCount()')
await sleep(13000)
const after = await ev('window.__dshLive2dPet.blinkCount()')
check('the pet blinks on its own', after - before >= 1, (after - before) + ' blinks in 13s')
// --- 指针「不在场」时必须回正 ---------------------------------------------
// 鼠标移出窗口后 pointermove 不再发来，宠物会僵在最后一个注视方向上。页面拿不到
// 窗口外的指针位置（要原生钩子），所以做的是回正：离开窗口 / 失焦 / 切标签页。
await gazeAt(1.0, 0.5)
const beforeLeave = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.gazeTarget())'))
check('先把视线拉到一边（准备验回正）', Math.abs(beforeLeave.x) > 0.5, JSON.stringify(beforeLeave))
await ev('document.documentElement.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }))')
await sleep(900)
const afterLeave = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.gazeTarget())'))
check('鼠标离开窗口后视线回正',
  Math.abs(afterLeave.x) < 0.02 && Math.abs(afterLeave.y) < 0.02
  && (await gaze()) === 'center',
  JSON.stringify(afterLeave) + ' data-gaze=' + await gaze())
// 嘴也要跟着回中位（它和视线共用同一个指针目标）。
const mouthAfterLeave = await mouthParams()
check('嘴也跟着回到中位', mouthAfterLeave.open < 0.05 && Math.abs(mouthAfterLeave.form) < 0.05,
  JSON.stringify(mouthAfterLeave))
// 再动一下就恢复跟随。
await gazeAt(0.75, 0.5)
check('指针回来后重新跟随', (await gaze()) === 'pointer', 'data-gaze=' + await gaze())

// --- 设置面板：改「注视死区」必须立刻改变手感，并记进 localStorage -----------
await openPanel(ev)
await sleep(700)
await ev('(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b = bs.find((x) => x.textContent === "设置"); if (b) b.click(); return !!b })()')
await sleep(600)
const hasSlider = await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-input=\'gazeDeadzone\']")')
check('设置页有「注视死区」滑杆', hasSlider === true)
// React 的受控 input 认的是原生 setter 派发的 input 事件，直接改 .value 会被它忽略。
const setSlider = (key, value) => ev('(() => {'
  + ' const el = document.querySelector("[data-dsh-live2d-pet] [data-input=\'' + key + '\']");'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(String(value)) + ');'
  + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
  + ' return true })()')
check('把死区拉到 0.5', (await setSlider("gazeDeadzone", 0.5)) === true)
await sleep(400)
const stored = JSON.parse(await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v1") ?? "null"'))
check('改动写进了 localStorage', stored !== null && stored.gazeDeadzone === 0.5, JSON.stringify(stored))
// 死区 0.5 之后，之前能动的那一下现在应该纹丝不动。
const nudgedAfter = await gazeAt(0.60, 0.5)
check('死区生效：同一个位置现在不再牵引视线', Math.abs(nudgedAfter.x) < 0.01, JSON.stringify(nudgedAfter))
// 恢复默认之后再拉一下，应该又能动了。
await ev('(() => { const b = document.querySelector("[data-dsh-live2d-pet] [data-reset=\'tuning\']"); if (b) b.click(); return !!b })()')
await sleep(400)
const restored = await gazeAt(0.60, 0.5)
check('「恢复默认」把死区放回 0.12（又能动了）', Math.abs(restored.x) > 0.01, JSON.stringify(restored))

// --- 设置必须挂在 DSH 自己的设置页里（右键面板那份只是过渡）-------------------
const sectionIds = JSON.parse(await ev('JSON.stringify(Object.keys(window.__pluginSections ?? {}))'))
check('插件往 DSH 设置页注册了一节', sectionIds.includes("pet-settings"), JSON.stringify(sectionIds))
const mounted = await ev('(() => {'
  + ' const slot = (window.__pluginSections ?? {})["pet-settings"];'
  + ' if (!slot) return "NO_SLOT";'
  + ' const host = document.createElement("div"); host.id = "dsh-settings-probe"; document.body.appendChild(host);'
  + ' window.ReactDOM.createRoot(host).render(slot.render());'
  + ' return slot.meta.label(); })()')
check('那一节的标题是「桌宠」', mounted === "桌宠", String(mounted))
await sleep(600)
const inDsh = await ev('!!document.querySelector("#dsh-settings-probe [data-pet-settings] [data-input=\'gazeDeadzone\']")')
check('DSH 设置页那一节里也有「注视死区」滑杆（和右键面板共用同一份值）', inDsh === true)
// 在 DSH 设置页里改，宠物必须跟着变 —— 两处 UI 共用模块作用域的 TUNING。
await ev('(() => {'
  + ' const el = document.querySelector("#dsh-settings-probe [data-input=\'gazeDeadzone\']");'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
  + ' setter.call(el, "0.5"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
await sleep(400)
const afterDshChange = await gazeAt(0.60, 0.5)
check('在 DSH 设置页改死区，宠物立刻跟着变', Math.abs(afterDshChange.x) < 0.01, JSON.stringify(afterDshChange))

// --- DSH 设置页里的「会话相位」和「摸鱼」两节 --------------------------------
const hasPhaseUi = await ev('!!document.querySelector("#dsh-settings-probe [data-phase=\'tool\'] select[data-phase-motion]")')
check('DSH 设置页有「会话相位」下拉', hasPhaseUi === true)
const hasFidgetUi = await ev('!!document.querySelector("#dsh-settings-probe [data-fidget-slot=\'mouth\'] input[data-fidget-none]")')
check('DSH 设置页有「摸鱼」权重输入', hasFidgetUi === true)

// 选一个和默认不同的动作，然后真的推一个 tool 相位过去 —— 必须播这个动作。
const setSelect = (selector, value) => ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify("#dsh-settings-probe " + selector) + ');'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(value) + ');'
  + ' el.dispatchEvent(new Event("change", { bubbles: true }));'
  + ' return true })()')
check('把 tool 相位的动作改成 Hammer', (await setSelect('[data-phase-motion=\'tool\']', "Hammer")) === true)
await sleep(300)
const phaseSaved = JSON.parse(await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v2") ?? "null"'))
check('相位覆盖写进了存档', phaseSaved !== null && phaseSaved.phases?.tool?.motion === "Hammer", JSON.stringify(phaseSaved?.phases ?? null))
await fetch(BASE + '/__nudge?phase=tool')
let played = null
for (let i = 0; i < 20; i += 1) {
  await sleep(250)
  played = await ev('(document.querySelector("[data-dsh-live2d-pet]") || {}).getAttribute?.("data-motion")')
  if (played === "Hammer") break
}
check('会话相位真的播了设置里指定的动作', played === "Hammer", 'data-motion=' + played)
await fetch(BASE + '/__nudge?phase=idle')
await sleep(600)

// 摸鱼：把嘴部唯一可触发选项的权重清零 —— 它应该整个退出摸鱼池。
// poolSize 是摸鱼真正跑过之后才写上的，所以先强制摸一次再读基线。
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(600)
const poolBefore = await ev('window.__dshLive2dPet.fidgetTally().poolSize')
const setWeight = (key, value) => ev('(() => {'
  + ' const el = document.querySelector("[data-dsh-live2d-pet] [data-fidget-weight=\'' + key + '\']");'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(String(value)) + ');'
  + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
  + ' return true })()')
check('在右键面板里把「吹泡泡糖」的摸鱼权重改成 0', (await setWeight("mouth:吹泡泡糖", 0)) === true)
await sleep(300)
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(800)
const poolAfter = await ev('window.__dshLive2dPet.fidgetTally().poolSize')
check('权重 0 的槽位退出摸鱼池（池子少一个）',
  String(poolBefore) !== String(poolAfter) && String(poolAfter).endsWith(String(Number(String(poolBefore).split("/")[1]) - 1)),
  poolBefore + ' -> ' + poolAfter)

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)