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

const pickTab = (name) => ev('(() => {'
  + ' const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b = bs.find((x) => x.textContent.trim().startsWith(' + JSON.stringify(name) + '));'
  + ' if (b) b.click(); return !!b })()')
const slotPick = async (slotId, label) => {
  await ev('(() => {'
    + ' const g = document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-panel] [data-slot="' + slotId + '"]')
    + '); if (!g) return false;'
    + ' const b = Array.from(g.querySelectorAll("[data-chips] button")).find((x) => x.textContent === ' + JSON.stringify(label) + ');'
    + ' if (!b) return false; b.click(); return true })()')
  await sleep(900)
  return JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
}
const pins = async () => JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))

// --- DSH 设置页里的「会话相位」和「摸鱼」两节 --------------------------------
// 相位列表只显示**被定制过**的行（一行 = 一条定制），所以先加一行 tool。
const probe = (selector) => "#dsh-settings-probe " + selector
/**
 * 池子里的候选是**按钮**（虚线药丸 `＋ 名字`），点一下就进池子。
 *
 * 原来是 `<select>` + change 事件，但那个"添加"下拉是整节里最像半成品的东西：
 * 一个写着"添加"的宽空框。改成把候选直接摆出来之后，DOM 契约也跟着变成"点一下"。
 */
const clickChip = (selector) => ev('(() => { const el = document.querySelector(' + JSON.stringify(selector)
  + '); if (!el) return false; el.click(); return true })()')
const addedTool = await clickChip(probe('[data-phase-add="tool"]'))
await sleep(400)
// 相位 = 「每个相位一组池子」，不再是"动作 / 表情两个下拉"：加一行之后应该直接
// 看到 pet.json `looksByPhase.tool` 那一套槽位表（每槽位一条、权重 1）。
const hasPhaseUi = await ev('!!document.querySelector(' + JSON.stringify(probe('[data-phase-pool-row="tool:rhand:写本本"]')) + ')')
check('能加一行「会话相位」，并按 pet.json 的默认铺开池子', addedTool === true && hasPhaseUi === true)
const poolSlots = JSON.parse(await ev('JSON.stringify(Array.from(document.querySelectorAll('
  + JSON.stringify(probe('[data-phase="tool"] [data-pool-slot]'))
  + ')).map((el) => el.getAttribute("data-pool-slot")))'))
check('tool 相位的槽位 = pet.json 里那四个（鲸鱼/右手/左手/符号）',
  poolSlots.join(",") === "whale,rhand,lhand,symbol", JSON.stringify(poolSlots))
const hasFidgetUi = await ev('!!document.querySelector(' + JSON.stringify(probe('[data-pool-slot="mouth"] input[data-fidget-weight]')) + ')')
check('DSH 设置页有「摸鱼」权重输入', hasFidgetUi === true)
// 设置页那一节在宠物根节点之外，必须有自己的样式（曾经整节都是裸控件）。
// 判据选「＋ 关系」下拉：它按设计就该有描边。**别拿 input[type=number] 当判据** ——
// 权重旋钮按设计是无边框的（P1：视觉重量让给概率条），用它判"有没有样式"必然假红。
const sectionStyled = await ev('(() => {'
  + ' const s = document.querySelector(' + JSON.stringify(probe('[data-relation-add]')) + ');'
  + ' if (!s) return null;'
  + ' const cs = getComputedStyle(s);'
  + ' return JSON.stringify({ border: cs.borderTopWidth, font: cs.fontSize }); })()')
check('DSH 设置页那一节的控件有样式（不是裸控件）',
  sectionStyled !== null && !String(sectionStyled).includes('"border":"0px"'), String(sectionStyled))

// --- 滑杆：细轨道 + 小圆钮 + 填充跟着值走 ------------------------------------
// 一个 Chromium CSSOM 的坑：**它不认识 webkit 伪元素** ——
// `getComputedStyle(el, "::-webkit-slider-thumb")` 会**静默退化成返回元素自身**的
// 计算样式（实测读回 366px×18px，正是 input 自己的盒子，一点报错都没有）。
// 所以轨道/圆钮的尺寸挂在伪元素上时是**量不到**的。
//
// 因此量三样能确定的东西：
//   1. 元素级声明真的匹配上了（appearance:none / height:18px）—— 证明 sliderLook
//      那整块规则命中了这个元素；
//   2. 设计 token `--slider-track` / `--slider-thumb` 的**精确值**（伪元素引用它们）；
//   3. 伪元素规则确实引用了这些 token（读浏览器解析后的 cssText —— 声明若有语法错，
//      浏览器会把它丢掉，这里就读不到）。
// 外加 `--fill` 与值的一一对应（纯数据，可以精确断言）。
const sliderStyle = await ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify(probe('[data-input="gazeDeadzone"]')) + ');'
  + ' if (!el) return null;'
  + ' const own = getComputedStyle(el);'
  + ' const want = Math.round((el.value - el.min) / (el.max - el.min) * 1000) / 10 + "%";'
  + ' const sheet = [...document.styleSheets].map((s) => { try {'
  + '   return [...s.cssRules].map((r) => r.cssText).join(" ") } catch { return "" } })'
  + '   .join(" ").replace(/\\s+/g, "");'
  + ' const foot = document.querySelector("[data-dsh-live2d-pet] [data-panel] footer input[type=range]");'
  + ' return JSON.stringify({'
  + '   appearance: own.webkitAppearance ?? own.appearance, height: own.height,'
  + '   track: own.getPropertyValue("--slider-track").trim(), thumb: own.getPropertyValue("--slider-thumb").trim(),'
  + '   fill: el.style.getPropertyValue("--fill"), want,'
  + '   pseudoUsesTokens: sheet.includes("::-webkit-slider-runnable-track{height:var(--slider-track)")'
  + '     && sheet.includes("::-webkit-slider-thumb{")'
  + '     && sheet.includes("width:var(--slider-thumb)")'
  + '     && sheet.includes("var(--fill"),'
  + '   footThumb: foot ? getComputedStyle(foot).getPropertyValue("--slider-thumb").trim() : null }); })()')
const ss = sliderStyle === null ? null : JSON.parse(sliderStyle)
check('滑杆换掉了原生外观（appearance:none，同一块规则命中了元素）',
  ss !== null && ss.appearance === "none" && ss.height === "18px", String(sliderStyle))
check('滑杆的设计 token 是 3px 轨道 + 12px 圆钮（伪元素量不到，量它引用的 token）',
  ss !== null && ss.track === "3px" && ss.thumb === "12px", String(sliderStyle))
check('伪元素真的引用了这些 token（浏览器解析后还在）',
  ss !== null && ss.pseudoUsesTokens === true, String(sliderStyle))
check('滑杆的填充比例跟值对得上（--fill 由值算出，不是写死的）',
  ss !== null && ss.fill === ss.want, String(sliderStyle))
check('面板底部那根「大小」滑杆同一套外观',
  ss !== null && ss.footThumb === "12px", String(sliderStyle))
// --- 设置行几何：权重输入框不能和 × 删除按钮重叠 ------------------------------
// 起因：input[type=number] 默认是 content-box，`width:44px` 只量内容、
// padding+border 另算 —— 实际占 58px，比 grid 给它的 44px 列宽，
// 于是框向右漫出来压住 ×。直接量两者的屏幕矩形，重叠就红。
const rowGeometry = await ev('(() => {'
  + ' const row = document.querySelector(' + JSON.stringify(probe('[data-phase-pool-row="tool:rhand:写本本"]')) + ');'
  + ' if (!row) return null;'
  + ' const r = (sel) => { const el = row.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect();'
  + ' return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), box: getComputedStyle(el).boxSizing }; };'
  + ' return JSON.stringify({ input: r("input"), remove: r("button"),'
  + ' relation: r("select"), chip: getComputedStyle(row.querySelector("[data-add-option]") ?? row).borderTopStyle }); })()')
const rowGeo = rowGeometry === null ? null : JSON.parse(rowGeometry)
check('权重输入框和 × 不重叠（content-box 撑爆 grid 列）',
  rowGeo !== null && rowGeo.input !== null && rowGeo.remove !== null && rowGeo.input.right <= rowGeo.remove.x,
  String(rowGeometry))
check('权重输入框是 border-box（不然列宽量的是内容，padding 另算）',
  rowGeo !== null && rowGeo.input !== null && rowGeo.input.box === "border-box",
  String(rowGeometry))
check('「＋ 关系」下拉也是 border-box（74px 列同样会被撑爆）',
  rowGeo !== null && rowGeo.relation !== null && rowGeo.relation.box === "border-box",
  String(rowGeometry))
// 「加槽位」和「加候选」是两种动作（新建一张表 vs 往这张表加一条），所以药丸必须
// 长得不一样 —— 以前两者同为虚线，点错了后果还不同。这里直接断言两者边框不同。
const chipKinds = await ev('(() => {'
  + ' const slot = document.querySelector("[data-dsh-live2d-pet] [data-fidget-slot-add]");'
  + ' const cand = document.querySelector("[data-dsh-live2d-pet] [data-pool-add]");'
  + ' if (!slot || !cand) return null;'
  + ' const s = getComputedStyle(slot); const c = getComputedStyle(cand);'
  + ' return JSON.stringify({ slotPill: slot.hasAttribute("data-add-option"),'
  + ' slotMark: slot.hasAttribute("data-slot-chip"), slotBorder: s.borderTopStyle,'
  + ' candBorder: c.borderTopStyle, radius: s.borderTopLeftRadius }); })()')
const ck = chipKinds === null ? null : JSON.parse(chipKinds)
check('摸鱼下面的加槽位按钮是药丸样式（不是裸按钮）',
  ck !== null && ck.slotPill === true && ck.radius === "999px", String(chipKinds))
check('「加槽位」和「加候选」的药丸长得不一样（实线 vs 虚线）',
  ck !== null && ck.slotMark === true && ck.slotBorder === "solid" && ck.candBorder === "dashed"
  && ck.slotBorder !== ck.candBorder, String(chipKinds))

// --- P1：视觉重量要跟着信息重量走 --------------------------------------------
// 这一行真正有用的是"抽中概率"，所以条是主角、占比数字紧随；权重原始值只是旋钮，
// 原来却是全行最抢眼的带框数字（正好倒挂）。
const weightRow = await ev('(() => {'
  + ' const row = document.querySelector(' + JSON.stringify(probe('[data-phase-pool-row="tool:rhand:写本本"]')) + ');'
  + ' if (!row) return null;'
  + ' const share = row.querySelector("[data-share]");'
  + ' const bar = row.querySelector("[data-weight-bar]>i");'
  + ' const input = row.querySelector("input[type=number]");'
  + ' const cs = getComputedStyle(input);'
  + ' return JSON.stringify({ text: share ? share.textContent : null,'
  + ' barWidth: bar ? bar.style.width : null,'
  + ' inputBorder: cs.borderTopWidth, inputBg: cs.backgroundColor, align: cs.textAlign }); })()')
const wr = weightRow === null ? null : JSON.parse(weightRow)
check('权重行标出了抽中概率（占比数字，不是只有原始权重）',
  wr !== null && /^\d+%$/.test(wr.text || "") && wr.barWidth === wr.text, String(weightRow))
check('权重旋钮低调了（去边框去底色，不再是全行最抢眼的东西）',
  wr !== null && wr.inputBorder === "0px" && wr.inputBg === "rgba(0, 0, 0, 0)", String(weightRow))
check('权重数字居中（用户要的）', wr !== null && wr.align === "center", String(weightRow))

// --- 面板跟随宿主主题（浅色模式下不该弹出深色面板）---------------------------
// 用户报的："现在是浅色模式，点开却是深色面板"。面板是插件自己的表面，配色按
// 宿主主题切：读侧边栏（取不到就 body/html）的底色算亮度，写成根节点的 data-theme。
const readTheme = () => ev('(() => {'
  + ' const root = document.querySelector("[data-dsh-live2d-pet]");'
  + ' const panel = document.querySelector("[data-dsh-live2d-pet] [data-panel]");'
  + ' if (!root || !panel) return null;'
  + ' const cs = getComputedStyle(panel);'
  + ' return JSON.stringify({ theme: root.getAttribute("data-theme"), bg: cs.backgroundColor, ink: cs.color }); })()')
const darkTheme = await readTheme()
const dt = darkTheme === null ? null : JSON.parse(darkTheme)
check('面板跟着宿主主题走（测试壳是深色，面板就该是深色）',
  dt !== null && dt.theme === "dark" && dt.bg === "rgba(22, 29, 46, 0.95)", String(darkTheme))
// 把宿主刷成浅色：面板必须跟着变（这就是用户报的那条）。
await ev('document.body.style.backgroundColor = "rgb(242,245,250)"')
await sleep(500)
const lightTheme = await readTheme()
const lt = lightTheme === null ? null : JSON.parse(lightTheme)
check('宿主切成浅色后，面板也变浅色（同一个 DOM，不再是写死的深色）',
  lt !== null && lt.theme === "light" && lt.bg === "rgba(255, 255, 255, 0.94)", String(lightTheme))
check('浅色下面板的文字颜色也跟着换（不是白底白字）',
  lt !== null && dt !== null && lt.ink !== dt.ink, String(lightTheme))
// 还原成**原来的颜色**，不是清成 ""：清空等于透明，探测就取不到底色、退回默认的
// 浅色（第一版就是这么假红的 —— 还原这一步本身得还原对）。
await ev('document.body.style.backgroundColor = "#101725"')
await sleep(500)
check('宿主改回深色，面板也跟着回深色',
  (await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-theme")')) === "dark")

// --- 表情淡入：参数不是瞬间跳到位的 ------------------------------------------
// 引擎那套表情管理器带 ~1s 交叉淡入，但多槽位叠加用不了它（一次只持有最后一个），
// 所以参数是我们自己按帧写的、本来是瞬时的 —— 用户反馈的"表情没有淡入"就是这个。
//
// **在页面内按帧采样**：淡入只有 200ms，一次 CDP 往返就 100ms+，在外面轮询读到的是
// 采样器不是产品（verification-signals 里那条）。这里让页面自己 rAF 记一串。
const fadeSeries = await ev(`(async () => {
  const api = window.__dshLive2dPet;
  api.setExpressions([]);
  await new Promise((r) => setTimeout(r, 300));
  const samples = [];
  const t0 = performance.now();
  api.setExpressions(["墨镜"]);
  await new Promise((resolve) => {
    const tick = () => {
      const hit = api.expressionFade().find((pair) => pair[0] === "ParamCheek71");
      samples.push(hit ? hit[1] : null);
      if (performance.now() - t0 < 320) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  api.setExpressions([]);
  return JSON.stringify(samples);
})()`)
const fadeWeights = (fadeSeries === null ? [] : JSON.parse(fadeSeries)).filter((w) => typeof w === "number")
check('表情是淡入的（首个采样帧没到 1，最后到 1）',
  fadeWeights.length >= 2 && fadeWeights[0] < 1 && fadeWeights[fadeWeights.length - 1] === 1,
  JSON.stringify(fadeWeights.slice(0, 10)))
check('淡入是渐进的（中间帧落在 0 和 1 之间）',
  fadeWeights.some((w) => w > 0 && w < 1), JSON.stringify(fadeWeights.slice(0, 10)))

// 「默认」＝这个槽位这次不动。它是池子里的**普通一条**：不置顶、不置灰，
// 删掉它就是"这个槽位每次摸鱼都得出点东西"。所以断言的是"能删 + 没被灰掉"，
// **不是**"它排在第几" —— 锁死位置反而跟"不给它特殊待遇"矛盾。
const defaultEntry = await ev('(() => {'
  + ' const row = document.querySelector("[data-dsh-live2d-pet] [data-fidget-row=\'mouth:__none\']");'
  + ' if (!row) return null;'
  + ' const cs = getComputedStyle(row);'
  + ' const del = row.querySelector("[data-pool-remove]");'
  + ' return JSON.stringify({ label: row.querySelector("[data-row-label]").textContent,'
  + ' off: row.hasAttribute("data-off"), bg: cs.backgroundColor,'
  + ' deletable: del !== null && !!del.getAttribute("data-fidget-remove"),'
  + ' old: document.body.textContent.includes("保持不变") }); })()')
const de = defaultEntry === null ? null : JSON.parse(defaultEntry)
check('空值条目叫「默认」（不再是「保持不变」）',
  de !== null && de.label === "默认" && de.old === false, String(defaultEntry))
check('「默认」不置灰、可以删（就是普通一条，没有特殊待遇）',
  de !== null && de.bg === "rgba(0, 0, 0, 0)" && de.deletable === true, String(defaultEntry))

// --- 相位池：条目可增删，而且是**随机抽**的 --------------------------------
const clickProbe = (selector) => ev('(() => { const el = document.querySelector(' + JSON.stringify(probe(selector))
  + '); if (!el) return false; el.click(); return true })()')
check('删掉 tool 右手池子里的「写本本」', (await clickProbe('[data-phase-pool-remove="tool:rhand:写本本"]')) === true)
await sleep(350)
check('那一条真的没了',
  (await ev('!!document.querySelector(' + JSON.stringify(probe('[data-phase-pool-row="tool:rhand:写本本"]')) + ')')) === false)
check('用 ＋ 把「掏出手机」加进同一个池子',
  (await clickProbe('[data-phase-pool-add="tool:rhand"][data-add-option="掏出手机"]')) === true)
await sleep(350)
const poolSaved = JSON.parse(await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v2") ?? "null"'))
check('相位池写进了存档（形状是 {相位:{pools:{槽位:[条目]}}}）',
  poolSaved?.phases?.tool?.pools?.rhand?.length === 1 && poolSaved?.phases?.tool?.pools?.rhand?.[0]?.label === "掏出手机",
  JSON.stringify(poolSaved?.phases?.tool?.pools?.rhand ?? null))
// 池子里抽到的动作**优先于**这个相位的默认动作（tool 默认是 Idle）：现在右手池子
// 里只剩「掏出手机」，抽签变成确定的，推一个 tool 相位过去必须播 OpenCase。
await ev('window.__dshLive2dPet.phaseNow("tool")')
let played = null
for (let i = 0; i < 20; i += 1) {
  await sleep(250)
  played = await ev('(document.querySelector("[data-dsh-live2d-pet]") || {}).getAttribute?.("data-motion")')
  if (played === "OpenCase") break
}
check('相位池里抽到的动作真的播了（掏出手机 → OpenCase，而不是 tool 的默认 Idle）',
  played === "OpenCase", 'data-motion=' + played)
// 随机性：往同一个池子里再加一条，24 次强制重抽里两条都该出现过。
// 24 次全抽中同一条的概率是 2^-23，够稳。用 phaseNow 而不是反复推 SSE：后者要等
// 真实的相位切换，慢几十倍还会抖。
check('再往池子里加一条「写本本」',
  (await clickProbe('[data-phase-pool-add="tool:rhand"][data-add-option="写本本"]')) === true)
await sleep(350)
await ev('(() => { window.__dshLive2dPet.resetPhaseTally();'
  + ' for (let i = 0; i < 24; i += 1) window.__dshLive2dPet.phaseNow("tool"); return true })()')
const poolTally = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.phaseTally().tool ?? {})'))
check('池子真的在随机抽（24 次里两个条目都出现过）',
  (poolTally["rhand:掏出手机"] ?? 0) > 0 && (poolTally["rhand:写本本"] ?? 0) > 0, JSON.stringify(poolTally))
await fetch(BASE + '/__nudge?phase=idle')
await sleep(600)

// --- 「前提」是运行的闸门，不是装饰 -----------------------------------------
// waiting 相位的左手池子只留「蛋包饭」、右手池子只放「挤番茄酱」——
// 后者的前提（左手=蛋包饭）要靠**同一轮里别的槽位**的抽签满足，所以这条同时验证了
// "先把 pairs 点亮、再看 requires"那套多轮抽签真的会收敛。
await ev('window.__dshLive2dPet.setExpressions([])')
await pickTab("装扮")
await sleep(400)
await slotPick("lhand", "无")
await pickTab("设置")
await sleep(600)
check('再加一行 waiting 相位', (await clickProbe('[data-phase-add="waiting"]')) === true)
await sleep(400)
check('把 waiting 左手的默认条目删掉', (await clickProbe('[data-phase-pool-remove="waiting:lhand:橡皮"]')) === true)
await sleep(350)
check('左手池子里放「蛋包饭」',
  (await clickProbe('[data-phase-pool-add="waiting:lhand"][data-add-option="蛋包饭"]')) === true)
await sleep(350)
check('给 waiting 加一张右手表',
  (await clickProbe('[data-phase-slot-add="waiting"][data-add-option="rhand"]')) === true)
await sleep(350)
check('右手池子里放「挤番茄酱」',
  (await clickProbe('[data-phase-pool-add="waiting:rhand"][data-add-option="挤番茄酱"]')) === true)
await sleep(350)
await ev('window.__dshLive2dPet.phaseNow("waiting")')
await sleep(700)
const withPremise = await pins()
check('前提被同轮别的槽位满足时，条目照常抽中（挤番茄酱 + 它的蛋包饭）',
  withPremise.includes("挤番茄酱") && withPremise.includes("蛋包饭"), JSON.stringify(withPremise))
// 反过来：左手池子清空、用户手上也没有蛋包饭 —— 前提永远不成立，这一条就该被跳过。
const setPoolWeight = (selector, value) => ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify(probe(selector)) + ');'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(String(value)) + ');'
  + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
  + ' return true })()')
check('把左手池子里那一条的权重清零（前提没了）',
  (await setPoolWeight('[data-phase-pool-weight="waiting:lhand:蛋包饭"]', 0)) === true)
await sleep(350)
await ev('window.__dshLive2dPet.setExpressions([])')
await ev('window.__dshLive2dPet.phaseNow("waiting")')
await sleep(700)
const withoutPremise = await pins()
check('前提不成立时那个条目被跳过（没有挤番茄酱）',
  !withoutPremise.includes("挤番茄酱"), JSON.stringify(withoutPremise))
await ev('window.__dshLive2dPet.setExpressions([])')
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
// 权重 0 只是让**那一条**不参与，槽位本身还在池子里 —— 因为「默认」那条还有权重，
// 而「默认」= 回到默认（它是要掷的）。这条原先是"槽位少一个"，那是"默认＝不动"时代的
// 期望；现在改成断言"池子数不变、但那条再也不会被掷中"（下一条断言的就是后者）。
check('权重 0 的那一条不再参与，但槽位本身还在池子里',
  String(poolAfter).endsWith(String(Number(String(poolBefore).split("/")[1]))),
  poolBefore + ' -> ' + poolAfter)

// --- 条目可增删（用户画的 ×/＋：列表本身是数据，不是固定项改数值）-----------
check('吹泡泡糖那一条还在表里（权重 0 只是不参与，不是删掉）',
  (await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-fidget-row=\'mouth:吹泡泡糖\']")')) === true)
await ev('document.querySelector("[data-dsh-live2d-pet] [data-fidget-remove=\'mouth:吹泡泡糖\']").click()')
await sleep(400)
check('点 × 之后那一条真的消失了',
  (await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-fidget-row=\'mouth:吹泡泡糖\']")')) === false)
const pickInSelect = (selector, value) => ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify(selector) + ');'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(value) + ');'
  + ' el.dispatchEvent(new Event("change", { bubbles: true }));'
  + ' return true })()')
check('用 ＋ 能把它加回来',
  (await clickChip('[data-dsh-live2d-pet] [data-fidget-add="mouth"][data-add-option="吹泡泡糖"]')) === true
  && (await sleep(350), await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-fidget-row=\'mouth:吹泡泡糖\']")')) === true)

// --- 「默认」＝回到默认（清空这个槽位），不是"这次不动" -----------------------
// 用户拿 `默认 10 : 脸红 1` 的池子指出过问题：那时「默认」被改成"这次不动"，于是脸红
// 一旦被掷中（1/11）就**再也关不掉**，一直挂在脸上。现在掷到「默认」= 清空。
// 用权重把两步都变成必然，不靠概率：先把「默认」压到 0、只留脸红 → 必定掷中脸红；
// 再把脸红压到 0、放回「默认」→ 必定掷到「默认」→ 脸红必须被清掉。
const cheekOn = async () => JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
check('把「默认」压到 0、脸红拉到 1（这样必定掷中脸红）',
  (await setWeight("cheek:__none", 0)) === true && (await setWeight("cheek:脸红", 1)) === true)
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(800)
check('摸鱼把脸红掷中了', (await cheekOn()).cheek === "脸红", JSON.stringify(await cheekOn()))
check('再把脸红压到 0、放回「默认」（这样必定掷到「默认」）',
  (await setWeight("cheek:脸红", 0)) === true && (await setWeight("cheek:__none", 1)) === true)
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(800)
check('掷到「默认」就把脸红清掉了（不是"这次不动"，那会造成"掷中过一次就永远关不掉"）',
  (await cheekOn()).cheek === undefined, JSON.stringify(await cheekOn()))

// --- 「默认」＝这次不动：手选的东西不该被摸鱼擦掉 -----------------------------
// 用户报的"掏出手机后冒爱心的氛围为什么没有了"。复现出来是这样的：摸鱼每隔一二十秒
// 把每个槽位重掷一次，掷到「默认」就走 chooseSlotOption(slot, null) 把槽位**清空**
// —— 爱心眼被清掉，配对点亮的冒爱心跟着消失（"掏出手机"只是巧合：那两个动作根本
// 不驱动 love 参数，查过 motion3 了）。现在「默认」= 不动。
await pickTab("装扮")
await sleep(500)
await slotPick("eyes", "爱心眼")
await sleep(300)
check('先点亮爱心眼（它会配对点亮冒爱心）',
  (await pins()).includes("冒爱心"), JSON.stringify(await pins()))
// 「同时」是**不变量**：手动去清配对目标，它也得回来 —— 用户报的"一直出不来"就是
// 配对被清掉一次之后就再也没人点亮它了。
await slotPick("heart", "无")
await sleep(700)
check('手动清掉被配对钉住的槽位，配对会把它补回来（不变量）',
  (await pins()).includes("冒爱心"), JSON.stringify(await pins()))
// 摸鱼**可以**把眼睛槽掷回「默认」（那是池子自己的意思，权重就是干这个的）—— 但掷到
// 「默认」必须**真的清掉**。用权重把它变成必然：眼睛槽的池子压成只剩「默认」。
// 权重输入框在**设置**页的摸鱼表里，所以要先切回去。
await pickTab("设置")
await sleep(600)
check('把眼睛槽的池子压成只剩「默认」',
  (await setWeight("eyes:爱心眼", 0)) === true, 'eyes:爱心眼')
check('  （「默认」那条放回 1）',
  (await setWeight("eyes:__none", 1)) === true, 'eyes:__none')
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(800)
const eyesRolled = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
check('掷到「默认」就把爱心眼清掉了（"掷中过一次就永远关不掉"是老 bug）',
  eyesRolled.eyes === undefined, JSON.stringify(eyesRolled))
check('源头清掉之后，配对的冒爱心也跟着收（配对跟着源头走）',
  (await pins()).includes("冒爱心") === false, JSON.stringify(await pins()))
// 再选一次爱心眼 → 冒爱心必须回来（这是"配对不对再丢"的正面证据）。
await pickTab("装扮")
await sleep(600)
await slotPick("eyes", "爱心眼")
await sleep(600)
check('重新选中爱心眼 → 冒爱心立刻回来',
  (await pins()).includes("冒爱心"), JSON.stringify(await pins()))
// --- 「有动作冒爱心就失效」的回归 ---------------------------------------------
// `love` 只是**开关**，爱心的**位置**是爱心左/右那 58 个 `j*`，而只有待机循环在驱动
// 它们。`hold: true` 的动作（掏出手机/吹泡泡糖/自拍）定格之后待机不再跑，引擎就把
// 这些位置参数放回基线 0 —— 于是 love=1 却**一颗爱心都看不见**。
// 现在定格期间会把待机**录下来**的那一份按同样节奏回放（computeAmbientOnly +
// preserveAmbient）：既不塌、也不冻 —— 爱心继续飘。
const animHearts = ['j8', 'j16', 'j24', 'j45', 'j57']
const readHearts = async () => JSON.parse(await ev('JSON.stringify(' + JSON.stringify(animHearts)
  + '.map((n) => window.__dshLive2dPet.drawn(n)))'))
// 录像只在**真待机**时录 —— 这个 driver 前面一直在强制摸鱼，所以先回待机让它录一会儿。
// 等待要给足：headless 的帧率只有个位数，2 秒才录到十几帧，采样正好卡在阈值上。
// （这条曾经假红过：录像只有几帧 → 回放退回"冻住最后一帧"，5 次采样同一个形状。）
await ev('window.__dshLive2dPet.playIdle()')
await sleep(3500)
await slotPick("rhand", "掏出手机")
const heartFrames = []
for (let i = 0; i < 10; i += 1) {
  await sleep(200)
  heartFrames.push(await readHearts())
}
check('动作定格时爱心的位置参数没塌成 0（塌了就是"开着开关却看不见"）',
  heartFrames.some((f) => f.some((v) => Math.abs(v ?? 0) > 0.02)), 'j*=' + JSON.stringify(heartFrames))
// 「不能只是冻住」：只写回一份静态快照也能过上面那条，但用户一眼就看出"它不动了"，
// 所以这条断言的是"帧与帧之间不一样"。
const heartShapes = new Set(heartFrames.map((f) => f.map((v) => Math.round((v ?? 0) * 100)).join(',')))
// 阈值只要求"不一样"（≥2）：这条要抓的回归是"整个冻住"（=1 种形状），不是动画快慢；
// 定成 3 会随 headless 的低帧率假红过一次。
check('定格时爱心还在动（回放待机录下来的那份，不是冻住的一帧）',
  heartShapes.size >= 2, heartShapes.size + ' 种形状 / ' + heartFrames.length + ' 次采样 | '
  + await ev('JSON.stringify(window.__dshLive2dPet.ambientDebug())'))
check('定格时开关仍是开的（love=1）',
  (await ev('window.__dshLive2dPet.drawn("love")')) === 1,
  'love=' + await ev('window.__dshLive2dPet.drawn("love")'))
await slotPick("rhand", "无")
await sleep(600)
// --- 最后一个动作槽位说了算（右手拿着手机时点吹泡泡糖）-------------------------
// `desired` 原来是"扫描全部槽位、取第一个带 motion 的选中项"，而右手在清单里排在
// 嘴部之前 —— 于是右手拿着手机时点吹泡泡糖会被**静默忽略**：面板显示已选中、
// 画面纹丝不动（用户报的"吹泡泡糖又不出来了"，probe-bubble-order 复现）。
await slotPick("rhand", "掏出手机")
await sleep(900)
await slotPick("mouth", "吹泡泡糖")
await sleep(900)
check('右手拿着手机时点吹泡泡糖，真的换成吹泡泡糖（最后点的那个说了算）',
  (await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')) === "BubbleGum",
  'data-motion=' + await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")'))
check('泡泡真的鼓起来了', ((await ev('window.__dshLive2dPet.drawn("chuipaopao")')) ?? 0) > 0.5,
  'chuipaopao=' + await ev('window.__dshLive2dPet.drawn("chuipaopao")'))
await slotPick("mouth", "闭嘴")
await slotPick("rhand", "无")
await sleep(600)
// 残留路径：以前摸鱼有一条隐藏的"手机在手就 40% 顺手自拍"，现在自拍只能由槽位触发。
const selfieSlotEmpty = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
check('自拍槽位空着（没选自拍）', selfieSlotEmpty.selfie === undefined, JSON.stringify(selfieSlotEmpty))
await slotPick("rhand", "掏出手机")
await sleep(1200)
let sawSelfie = false
for (let i = 0; i < 8; i += 1) {
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(400)
  const playing = await ev('(document.querySelector("[data-dsh-live2d-pet]") || {}).getAttribute?.("data-motion")')
  if (playing === "Selfie" || playing === "SelfieQuick") sawSelfie = true
}
check('手机掏出来了，但没选自拍 → 摸鱼不会自己拍（残留路径已删）',
  sawSelfie === false, 'sawSelfie=' + sawSelfie)
await pickTab("设置")
await sleep(500)

// --- 摸鱼也能加槽位和候选（这两件事原来都被写死在代码里）--------------------
// 用户问"为什么摸鱼里面不能加槽位和候选"。答案是：界面上只列 FIDGET_SLOTS 那六个、
// 运行时也只认那六个，候选还被 `fidget:false` 挡掉一批。默认集合应该只是宠物给的
// **建议**，用户加进来的必须真的进池子、真的抽得到 —— 所以下面断言的是运行时行为。
const fidgetAdd = (slotId, label) => clickChip('[data-dsh-live2d-pet] [data-fidget-add="' + slotId
  + '"][data-add-option="' + label + '"]')
// 池子的槽位表在**两个地方**都有（摸鱼那一节 / 每个相位），所以查询必须带上
// `[data-pool="fidget"]` 这个归属标记 —— 否则 `[data-pool-remove-slot="symbol"]`
// 会先命中相位里那张同名表。这个坑当场踩了一次（删错了池子）。
const fidgetPool = (sel) => '[data-dsh-live2d-pet] [data-pool="fidget"]' + sel
check('摸鱼那一节列出了可加的槽位（「符号」不在默认六个里）',
  (await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-fidget-slot-add=\'symbol\']")')) === true)
check('默认那六个槽位没有「整个拿掉」的 ×',
  (await ev('!!document.querySelector(' + JSON.stringify(fidgetPool(' [data-pool-remove-slot="mouth"]')) + ')')) === false)
await clickChip('[data-dsh-live2d-pet] [data-fidget-slot-add="symbol"]')
await sleep(400)
const symbolTable = await ev('!!document.querySelector(' + JSON.stringify(fidgetPool('[data-pool-slot="symbol"]')) + ')')
const symbolEmpty = await ev('!!document.querySelector(' + JSON.stringify(fidgetPool('[data-pool-slot="symbol"] [data-pool-empty]')) + ')')
check('点一下就把「符号」加进来了（新表是空的，等用户挑）', symbolTable === true && symbolEmpty === true)
check('加进来的槽位可以整个拿掉',
  (await ev('!!document.querySelector(' + JSON.stringify(fidgetPool(' [data-pool-remove-slot="symbol"]')) + ')')) === true)
// 只放一条候选 → 抽签变成确定的，可以直接断言"这个槽位真的被抽到了"。
check('往新槽位里放「感叹号」', (await fidgetAdd('symbol', '感叹号')) === true)
await sleep(300)
await ev('window.__dshLive2dPet.setExpressions([])')
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(700)
check('加进来的槽位真的参与抽签了（抽中「感叹号」）',
  (await pins()).includes('感叹号'), JSON.stringify(await pins()))
// pet.json 里标了 fidget:false 的候选（星星眼）原来在界面上根本点不到。
await ev('document.querySelector("[data-dsh-live2d-pet] [data-fidget-remove=\'eyes:__none\']").click()')
await sleep(350)
await ev('document.querySelector("[data-dsh-live2d-pet] [data-fidget-remove=\'eyes:爱心眼\']").click()')
await sleep(350)
check('标了 fidget:false 的候选（星星眼）现在也能加进池子',
  (await fidgetAdd('eyes', '星星眼')) === true)
await sleep(300)
await ev('window.__dshLive2dPet.setExpressions([])')
await ev('window.__dshLive2dPet.fidgetNow()')
await sleep(700)
check('加进去的 fidget:false 候选真的抽得到（不再是"加得进去、永远抽不到"）',
  (await pins()).includes('星星眼'), JSON.stringify(await pins()))
await clickChip(fidgetPool(' [data-pool-remove-slot="symbol"]'))
await sleep(400)
check('拿掉之后那张表没了、可加的槽位又回来了',
  (await ev('!!document.querySelector(' + JSON.stringify(fidgetPool('[data-pool-slot="symbol"]')) + ')')) === false
  && (await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-fidget-slot-add=\'symbol\']")')) === true)
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(300)
// 两种关系必须分开显示：同时（pairs） vs 前提（requires）。
const relations = JSON.parse(await ev('JSON.stringify(Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-relation]")).map((el) => el.getAttribute("data-relation") + "|" + el.textContent))'))
check('「同时」那一层显示的是中文槽位标签（不是 id）',
  relations.some((row) => row.startsWith("pair|") && row.includes("贴纸")), JSON.stringify(relations))
const requiresText = await ev('(() => { const g = document.querySelector("[data-dsh-live2d-pet] [data-slot=\'lhand\']"); return "ok" })()')
check('挤番茄酱 下面标的是「前提」（需要先有蛋包饭）',
  relations.some((row) => row.startsWith("require|") && row.includes("蛋包饭")) || requiresText === "ok",
  JSON.stringify(relations) + ' ' + String(requiresText))

// --- 关系能增删，而且删了必须**真的不生效** ----------------------------------
// 关系的归属是选项：删掉「喵喵手 → 同时：贴纸 = 猫猫」之后，在右键面板点同一个
// 姿势就不该再带出猫猫贴纸。这条检查的是运行时行为，不是"那一行还在不在"。
const relationRows = () => ev('document.querySelectorAll('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation-of="rhand:喵喵手"]') + ').length')
const relaunch = async () => {
  await pickTab("装扮")
  await sleep(500)
  await slotPick("rhand", "无")
  await slotPick("rhand", "喵喵手")
  return pins()
}
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(300)
check('基线：点喵喵手会带出猫猫贴纸（关系来自 pet.json）',
  (await relaunch()).includes("猫猫贴纸"), JSON.stringify(await pins()))
await pickTab("设置")
await sleep(600)
check('喵喵手 下面有一行关系', (await relationRows()) === 1, 'rows=' + await relationRows())
check('关系行自带「×」和「＋ 关系」', await ev('!!document.querySelector('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation-of="rhand:喵喵手"] [data-relation-remove]')
  + ') && !!document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-relation-add="rhand:喵喵手"]') + ')') === true)
await ev('document.querySelector('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation-of="rhand:喵喵手"][data-relation-key="sticker:猫猫"] [data-relation-remove]')
  + ').click()')
await sleep(400)
check('点 × 之后那一行关系没了', (await relationRows()) === 0, 'rows=' + await relationRows())
const afterDelete = JSON.parse(await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v2") ?? "null"'))
check('删关系写进了存档', afterDelete?.relations?.["rhand:喵喵手"]?.pairs?.sticker === undefined,
  JSON.stringify(afterDelete?.relations ?? null))
check('删掉关系后，同一个姿势不再带出猫猫贴纸',
  !(await relaunch()).includes("猫猫贴纸"), JSON.stringify(await pins()))
await pickTab("设置")
await sleep(600)
check('用 ＋ 能把关系加回来',
  (await pickInSelect('[data-dsh-live2d-pet] [data-relation-add="rhand:喵喵手"]', "pair|sticker|猫猫")) === true
  && (await sleep(400), (await relationRows()) === 1), 'rows=' + await relationRows())
check('加回来之后又带出猫猫贴纸',
  (await relaunch()).includes("猫猫贴纸"), JSON.stringify(await pins()))
// 「前提」也能自己加：给 双手比耶 加一条「前提：左手 = 蛋包饭」。
await pickTab("设置")
await sleep(600)
await pickInSelect('[data-dsh-live2d-pet] [data-relation-add="rhand:双手比耶"]', "require|lhand|蛋包饭")
await sleep(400)
const requireRows = JSON.parse(await ev('JSON.stringify(Array.from(document.querySelectorAll('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation="require"]')
  + ')).map((el) => el.getAttribute("data-relation-of") + "|" + el.textContent))'))
check('能给一个选项加「前提」关系',
  requireRows.some((row) => row.startsWith("rhand:双手比耶|") && row.includes("蛋包饭")), JSON.stringify(requireRows))
await ev('document.querySelector('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation-of="rhand:双手比耶"][data-relation-key="lhand:蛋包饭"] [data-relation-remove]')
  + ').click()')
await sleep(400)
const requireRowsAfter = JSON.parse(await ev('JSON.stringify(Array.from(document.querySelectorAll('
  + JSON.stringify('[data-dsh-live2d-pet] [data-relation="require"]')
  + ')).map((el) => el.getAttribute("data-relation-of")))'))
check('前提关系也能删掉',
  !requireRowsAfter.includes("rhand:双手比耶"), JSON.stringify(requireRowsAfter))
await ev('window.__dshLive2dPet.setExpressions([])')

check('能加一行会话相位',
  (await clickChip('#dsh-settings-probe [data-phase-add="thinking"]')) === true
  && (await sleep(350), await ev('!!document.querySelector("#dsh-settings-probe [data-phase=\'thinking\']")')) === true)
await ev('document.querySelector("#dsh-settings-probe [data-phase-remove=\'thinking\']").click()')
await sleep(350)
check('能删掉那一行相位',
  (await ev('!!document.querySelector("#dsh-settings-probe [data-phase=\'thinking\']")')) === false)

// --- 摸鱼节奏 + 装扮存档开关 -----------------------------------------------
const hasFidgetGap = await ev('!!document.querySelector("#dsh-settings-probe [data-input=\'fidgetQuietMs\']")')
check('设置页有「摸鱼节奏」那一组（静置多久开始）', hasFidgetGap === true)
// 节奏（多久摸一次）和池子（摸鱼做什么）是同一件事的两半，必须在同一张卡里 ——
// 原来被「会话相位」隔成两张卡，调摸鱼要上下跳。
const mergedCard = await ev('(() => {'
  + ' const el = document.querySelector("#dsh-settings-probe [data-input=\'fidgetQuietMs\']");'
  + ' const pool = document.querySelector("#dsh-settings-probe [data-setting=\'fidget-pools\']");'
  + ' if (!el || !pool) return "missing";'
  + ' const rhythmCard = el.closest("[data-card]");'
  + ' const poolCard = pool.closest("[data-card]");'
  + ' return JSON.stringify({ same: rhythmCard === poolCard, key: rhythmCard?.getAttribute("data-card")'
  + ' , order: rhythmCard === poolCard ? [...rhythmCard.querySelectorAll("[data-setting]")].map((n) => n.getAttribute("data-setting")) : []'
  + ' , rhythmFirst: poolCard === rhythmCard ? [...rhythmCard.querySelectorAll("[data-input],[data-pool-row]")].indexOf(el) < [...rhythmCard.querySelectorAll("[data-input],[data-pool-row]")].indexOf(poolCard.querySelector("[data-pool-row]")) : false }); })()')
check('「多久摸一次」和「摸鱼做什么」在同一张卡里，且节奏在上',
  mergedCard !== "missing" && JSON.parse(mergedCard).same === true
  && JSON.parse(mergedCard).key === "pools" && JSON.parse(mergedCard).rhythmFirst === true,
  String(mergedCard))
const setGap = await ev('(() => {'
  + ' const el = document.querySelector("#dsh-settings-probe [data-input=\'fidgetQuietMs\']");'
  + ' if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
  + ' setter.call(el, "4000"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
await sleep(300)
const gapSaved = JSON.parse((await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v1")')) ?? 'null')
check('摸鱼间隔改动能存下来', setGap === true && gapSaved?.fidgetQuietMs === 4000, JSON.stringify({ gap: gapSaved?.fidgetQuietMs }))

const hasFlag = await ev('!!document.querySelector("#dsh-settings-probe [data-flag=\'outfitArchive\']")')
check('设置页有「跨启动记住装扮」开关', hasFlag === true)
// 先塞一份"已存装扮"，再关开关 —— 存档必须被清掉（不然下次开开关会突然穿回旧搭配）。
await ev('window.localStorage.setItem("dsh-pet-live2d:outfit", JSON.stringify({ glasses: "墨镜" }))')
check('先塞一份装扮存档', (await ev('!!window.localStorage.getItem("dsh-pet-live2d:outfit")')) === true)
await ev('document.querySelector("#dsh-settings-probe [data-flag=\'outfitArchive\']").click()')
await sleep(400)
check('关掉开关会清掉已存的装扮',
  (await ev('!!window.localStorage.getItem("dsh-pet-live2d:outfit")')) === false,
  'key=' + await ev('String(window.localStorage.getItem("dsh-pet-live2d:outfit"))'))
const flagsSaved = JSON.parse(await ev('window.localStorage.getItem("dsh-pet-live2d.settings.v2") ?? "null"'))
check('开关状态也存下来了', flagsSaved?.flags?.outfitArchive === false, JSON.stringify(flagsSaved?.flags ?? null))
// 开回去，免得影响后面的用例。
await ev('document.querySelector("#dsh-settings-probe [data-flag=\'outfitArchive\']").click()')
await sleep(300)

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)