// The merged 装扮 menu: every slot option must actually reach the model.
//
// This driver used to hash the canvas before and after a click and print
// whether it changed, then exit 0 unconditionally — so it asserted nothing, and
// its one signal was worthless anyway: the pet breathes and blinks, so no two
// frames are ever byte-identical and the hash always "changed". Between them,
// these two facts hid the state of the expression pipeline for several rounds.
//
// It now reads the parameter values the engine writes inside a frame, which is
// deterministic, and fails on a real mismatch.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel, killBrowser } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

const EDGE = browserPath()
const PORT = 9361
const PROFILE = join(PROFILES, '_cdp-exp')
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
let nextId = 0; const pending = new Map(); const reqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url
    if (u.includes('/api/live2d-pet/')) reqs.push(m.params.response.status + ' ' + u.replace(/^https?:\/\/[^/]+/, ''))
  }
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
await waitForBoot(ev)
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }

const WATCH = ['ParamCheek71', 'ParamCheek16', 'jingyu', 'ParamCheek70', 'ParamCheek83', 'pointX', 'pointY', 'pointZ', 'ParamCheek76', 'ParamCheek77']
const PROBE = [
  '(() => {',
  '  const c = window.__PET_DBG.core',
  '  const names = ' + JSON.stringify(WATCH),
  '  const ids = Array.from(c._model.parameters.ids)',
  '  window.__at = names.map((n) => ids.indexOf(n))',
  '  window.__last = null',
  '  const base = c.update.bind(c)',
  '  c.update = () => {',
  '    base()',
  '    window.__last = window.__at.map((i) => (i < 0 ? null : Number(c._model.parameters.values[i].toFixed(2))))',
  '  }',
  '  return true',
  '})()',
].join('\n')
check('parameter probe installed', (await ev(PROBE)) === true)
const frame = async () => JSON.parse(await ev('JSON.stringify(window.__last)') ?? 'null')
const at = (values, name) => values[WATCH.indexOf(name)]

await openPanel(ev)
await sleep(700)
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(!b) return false; b.click(); return true})()')
await sleep(700)
// 表情 and 装扮 are one menu now: 14 slots, each with its options plus a
// "none" button.
const slots = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-slot]").length')
// 槽位数会随 pet.json 变（氛围拆成三个独立槽、自拍独立成槽之后是 20）——
// 改槽位结构时记得一起改这里（browser-cdp skill 里那条"先全局搜一遍这类计数"）。
check('the merged menu renders every slot', slots === 20, 'slots=' + slots)

// Each chip must move the parameter its own .exp3.json declares.
for (const [label, param] of [["墨镜","ParamCheek71"],["星星眼","ParamCheek16"],["头顶鲸","jingyu"]]) {
  await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button"));'
    + ' const b=bs.find((x)=>x.textContent===' + JSON.stringify(label) + '); if(!b) return false; b.click(); return true})()')
  let seen = null
  for (let i = 0; i < 24; i += 1) {
    await sleep(250)
    const now = await frame()
    if (now !== null && at(now, param) === 1) { seen = now; break }
    seen = now
  }
  const pin = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())') ?? 'null')
  const layers = await ev('window.__dshLive2dPet.expressionLayerCount()')
  check('clicking ' + label + ' sets ' + param, at(seen, param) === 1,
    JSON.stringify(seen) + '  pinned=' + JSON.stringify(pin) + ' layers=' + layers)
  await ev('window.__dshLive2dPet.setExpressions([])')
  await sleep(600)
}

// A hand that writes on the tablet. The model has NO animation for this — the
// author left 点菜手X/Y at their defaults — so the plugin generates the curve.
// Assert on the parameters, not on pixels: the sweep is a moving target and a
// screenshot cannot tell "writing" from "breathing".
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(600)
await ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="rhand"]\');'
  + ' const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="写本本");'
  + ' if(!b) return false; b.click(); return true})()')
const pickWrite = () => ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="rhand"]\');'
  + ' const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="写本本");'
  + ' if(!b) return false; b.click(); return true})()')
const pinnedNow = async () => JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
const pts = []
let pressed = 0
for (let i = 0; i < 26; i += 1) {
  await sleep(320)
  // The idle fidget is allowed to change slots while this runs — that is by
  // design — so re-assert the choice instead of assuming it stays put. Reading
  // only the final sample made this flaky for a reason that had nothing to do
  // with the sweep.
  if (i % 6 === 5 && !(await pinnedNow()).includes('点菜按下')) await pickWrite()
  const now = await frame()
  if (now === null) continue
  pts.push([at(now, 'pointX'), at(now, 'pointY')])
  const z = at(now, 'pointZ')
  if (typeof z === 'number' && z > pressed) pressed = z
}
const xs = pts.map((q) => q[0])
const ys = pts.map((q) => q[1])
check('写本本 presses the pen down', pressed >= 1, 'pointZ peak=' + pressed)
check('写本本 moves the hand across the tablet', Math.max(...xs) - Math.min(...xs) > 8,
  'pointX range=' + (Math.max(...xs) - Math.min(...xs)).toFixed(2))
// It must read as ONE continuous loop, not a stroke plus a snap back. The
// first version was a sawtooth, and the snap of ~2*ampX per cycle is exactly
// what made it look stiff, so the shape is asserted, not just the range.
// Judged by SHAPE, not by an absolute step size. Sampling is only ~320ms apart
// over a 2.8s loop, so a perfectly smooth curve still moves ~13 units between
// samples near its fastest point — an absolute threshold would call the loop
// itself a failure. What separates flowing from snapping is that a snap is a
// lone OUTLIER: a sawtooth travels at a constant rate and then jumps by the
// whole width at once. So compare the worst step with the typical one.
const jumps = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]))
const sorted = jumps.slice().sort((a, b) => a - b)
const typical = sorted[Math.floor(sorted.length * 0.9)]
const worst = sorted[sorted.length - 1]
check('写本本 flows instead of snapping back', worst < typical * 2.2,
  'worst step=' + worst.toFixed(2) + ' vs typical=' + typical.toFixed(2)
  + ' (a sawtooth snap is a lone outlier ~3.7x)')
check('写本本 traces a closed loop, not a drift',
  Math.min(...xs) < 0 && Math.max(...xs) > 0 && Math.min(...ys) < 0 && Math.max(...ys) > 0,
  'x ' + Math.min(...xs).toFixed(1) + '..' + Math.max(...xs).toFixed(1)
  + '  y ' + Math.min(...ys).toFixed(1) + '..' + Math.max(...ys).toFixed(1))
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(600)

// --- mutually exclusive options across slots --------------------------------
// 吐魂 and 吹泡泡糖 write DISJOINT parameters, so nothing in the engine stops
// them rendering together — a soul leaving the mouth through a bubble-gum
// pucker. Declared symmetrically, so either pick drops the other.
const slotPick = async (slotId, label) => {
  await ev('(()=>{const g=document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-panel] [data-slot="' + slotId + '"]')
    + '); if(!g) return false; const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent===' + JSON.stringify(label) + ');'
    + ' if(!b) return false; b.click(); return true})()')
  await sleep(1100)
  return JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
}
const withSoul = await slotPick('mood', '吐魂')
check('吐魂 can be picked on its own', withSoul.mood === '吐魂', JSON.stringify(withSoul))
const withBubble = await slotPick('mouth', '吹泡泡糖')
check('picking 吹泡泡糖 drops the rival 吐魂',
  withBubble.mouth === '吹泡泡糖' && withBubble.mood === undefined, JSON.stringify(withBubble))
const backToSoul = await slotPick('mood', '吐魂')
check('and picking 吐魂 drops 吹泡泡糖 in turn',
  backToSoul.mood === '吐魂' && backToSoul.mouth === undefined, JSON.stringify(backToSoul))
await slotPick('mood', '平静')
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(500)
// --- a paired option pulls in exactly ONE partner, and lets it go -----------
// pairs used to switch on EVERY option of the target slot, so 爱心眼 brought in
// 冒爱心 AND 心跳 AND 情绪花花 at once. Leaving the pair also has to undo it.
const paired = await slotPick('eyes', '爱心眼')
const pairedFaces = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
check('爱心眼 brings in 冒爱心', paired.mood === undefined && pairedFaces.includes('冒爱心'), JSON.stringify(pairedFaces))
check('and brings in NOTHING else from the ambient slot',
  !pairedFaces.includes('心跳') && !pairedFaces.includes('情绪花花'), JSON.stringify(pairedFaces))
await slotPick('eyes', '默认')
const released = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
check('going back to normal eyes releases the ambience',
  !released.includes('冒爱心') && !released.includes('心跳') && !released.includes('情绪花花'),
  JSON.stringify(released))
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(500)
// --- 「整体换眼」的两个槽位选项不能同时生效 --------------------------------
// 晕晕(ParamCheek77) 和 开心兴奋(ParamCheek76) 各自把自己那套眼睛美术推到不透明，
// 同时把「默认眼睛」那组 drawable 关掉。参数层面互不冲突，所以两套眼睛会一起画在
// 脸上（用户报的"晕晕和开心兴奋叠在一起"就是这张图）。pet.json 里声明为互斥，
// 面板点选必须互相顶掉，而不是叠加。
// 关掉摸鱼：它每 12-26 秒会重掷一次槽位，正好在断言中间把选择改掉。
await ev('window.__dshLive2dPet.setFidgetEnabled(false)')
await slotPick('eyes', '晕晕')
const dizzyAlone = await frame()
check('picking 晕晕 turns its own eye art on', at(dizzyAlone, 'ParamCheek77') === 1, JSON.stringify(dizzyAlone))
const afterHappy = await slotPick('mood', '开心兴奋')
const happyFrame = await frame()
check('picking 开心兴奋 drops 晕晕 instead of stacking both eye sets',
  afterHappy.mood === '开心兴奋' && afterHappy.eyes === undefined
  && at(happyFrame, 'ParamCheek76') === 1 && at(happyFrame, 'ParamCheek77') === 0,
  JSON.stringify(afterHappy) + ' ' + JSON.stringify(happyFrame))
const afterDizzy = await slotPick('eyes', '晕晕')
const dizzyFrame = await frame()
check('and picking 晕晕 drops 开心兴奋 in turn',
  afterDizzy.eyes === '晕晕' && afterDizzy.mood === undefined
  && at(dizzyFrame, 'ParamCheek77') === 1 && at(dizzyFrame, 'ParamCheek76') === 0,
  JSON.stringify(afterDizzy) + ' ' + JSON.stringify(dizzyFrame))
await slotPick('eyes', '默认')
await slotPick('mood', '平静')
// 相位 + 反应这条路径**不经过面板**：相位把情绪钉成开心兴奋，转圈的反应再直接
// pin 晕晕。互斥必须放在 pin 的漏斗里才兜得住，否则还是会两套眼睛一起画。
await ev('window.__dshLive2dPet.phaseNow("done")')
await sleep(1500)
const phaseFrame = await frame()
check('the done phase pins 开心兴奋 on its own', at(phaseFrame, 'ParamCheek76') === 1, JSON.stringify(phaseFrame))
await ev('window.__dshLive2dPet.setExpressions(' + JSON.stringify(['开心兴奋', '晕晕']) + ')')
await sleep(700)
const bypassFrame = await frame()
check('a pin set that bypasses the panel still cannot stack both eye sets',
  at(bypassFrame, 'ParamCheek77') === 1 && at(bypassFrame, 'ParamCheek76') === 0,
  JSON.stringify(bypassFrame))
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(600)
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(400)
// --- 互斥只裁剪输出，**不许**把对手从声明层删掉 -----------------------------
// 这条是 PR #5 带进来、我事后补的：互斥一开始把结果当成了下一轮的输入，于是被顶掉的
// 那条**从集合里消失**，谁也不会再加回来。用户看到的版本是「相位 = 完成」时点一下
// 「晕晕」、反应 12 秒后收回默认 —— 相位那张脸再也不出现，直到下一条相位消息。
//
// 判据分两步，缺一不可：
//   ① 手点那一下，声明层里**两条都还在**（相位没被销毁）；
//   ② 手点的那条被收走之后，相位那条**自己回到生效层**（不需要再来一条相位消息）。
await ev('window.__dshLive2dPet.phaseNow("done")')
await sleep(1500)
await slotPick('eyes', '晕晕')
const declaredWhilePicked = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.declaredExpressions())'))
const effectiveWhilePicked = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.expressions())'))
check('a manual pick beats the phase on screen, but does not DESTROY it',
  effectiveWhilePicked.includes('晕晕') && !effectiveWhilePicked.includes('开心兴奋')
  && declaredWhilePicked.includes('晕晕') && declaredWhilePicked.includes('开心兴奋'),
  'declared=' + JSON.stringify(declaredWhilePicked) + ' effective=' + JSON.stringify(effectiveWhilePicked))
await slotPick('eyes', '默认')
const restored = await frame()
check('and when the pick is cleared, the phase face comes back on its own',
  at(restored, 'ParamCheek76') === 1 && at(restored, 'ParamCheek77') === 0,
  JSON.stringify(restored))
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(600)
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(400)
// --- motion-only options must not render as permanently pressed -------------
// The highlight used `option.expressions.every((n) => pinned[n] === true)`, and
// a motion-only option has an EMPTY expression list — [].every(...) is
// vacuously true, so 掏出手机 and 吹泡泡糖 were lit up from the moment the panel
// opened. Selection is now read from the slot's own chosen label.
const pressedChips = async () => JSON.parse(await ev('JSON.stringify(Array.from('
  + 'document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button[data-on]"))'
  + '.map((b) => b.textContent))'))
await slotPick('rhand', '无')
await slotPick('mouth', '吹泡泡糖')
await slotPick('mouth', '闭嘴')
await sleep(600)
const idlePressed = await pressedChips()
check('nothing is pressed while nothing is chosen',
  !idlePressed.includes('掏出手机') && !idlePressed.includes('吹泡泡糖'), JSON.stringify(idlePressed))
await slotPick('rhand', '掏出手机')
const onePressed = await pressedChips()
check('a motion option lights up only when it is the chosen one',
  onePressed.includes('掏出手机') && !onePressed.includes('吹泡泡糖'), JSON.stringify(onePressed))
await slotPick('rhand', '无')

// --- 掏出手机 / 吹泡泡糖 belong to the slots, not the 动作 tab ---------------
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("动作")===0); if(b) b.click(); return !!b})()')
await sleep(600)
const motionLabels = JSON.parse(await ev('JSON.stringify(Array.from('
  + 'document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-body] [data-group] > span"))'
  + '.map((s) => s.textContent))'))
check('the 动作 tab offers the real motions', motionLabels.length >= 5, JSON.stringify(motionLabels))
check('but not the two that are slot choices',
  !motionLabels.some((l) => /掏出手机|吹泡泡糖/.test(l)), JSON.stringify(motionLabels))
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(400)
check('no failed plugin request', !reqs.some((r) => !r.startsWith('200')),
  JSON.stringify(reqs.filter((r) => !r.startsWith('200')).slice(0, 5)))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close(); killBrowser(edge)
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
