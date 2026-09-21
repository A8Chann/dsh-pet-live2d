import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel } from './ready.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9441
const PROFILE = join(PROFILES, '_cdp-motion')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)
const IDS = ["chuipaopao","chuipaopao2","chuipaopao7","pengshui","jingyu","phone","phone2","phone4"]
const readExpr = 'JSON.stringify((()=>{const raw=window.__PET_DBG.model.internalModel.coreModel._model.parameters; const o={}; for(const id of ' + JSON.stringify(IDS) + '){const i=Array.from(raw.ids).indexOf(id); o[id]=i<0?"NOID":+raw.values[i].toFixed(2)} return o})())'
/**
 * Parameters as the model has them, plus what the frame actually DREW.
 *
 * The raw array is read BETWEEN frames, and the engine's frame runs
 * saveParameters() -> update() -> loadParameters(): that last call puts the
 * engine's own baseline back over every layer the plugin writes. So the raw
 * value is "what the motion system alone produced" — for a parameter nothing
 * else touches the two agree, but only the _drawn half answers "what is on
 * screen", and that is what these assertions are about.
 */
const read = async () => {
  const out = JSON.parse(await ev(readExpr))
  for (const id of ['chuipaopao', 'phone', 'jingyu']) {
    out[id + '_drawn'] = await ev('window.__dshLive2dPet.drawn(' + JSON.stringify(id) + ')')
  }
  return out
}
const motion = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
const opt = (g) => ev('JSON.stringify(window.__dshLive2dPet.optionsFor(' + JSON.stringify(g) + '))')
const out = {}
// Assertions, not printouts: this driver used to end in an unconditional
// process.exit(0) with only console.log output, so it could never fail.
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '   ' + detail))
}

await ev('window.__dshLive2dPet.playIdle()'); await sleep(1200)
const rest = await read()

// (1) bubble gum must not leave the mouth inflated
await ev('window.__dshLive2dPet.playOnce("BubbleGum",0,{kind:"panel"})')
await sleep(1500); const bubbleDuring = await read()
// NOT "wait for idle": a hold+persist motion never goes idle, so that loop span
// the full 15s and a natural fidget changed the mouth slot in the meantime.
// Wait out the motion's own declared duration instead.
await sleep(5000); const bubbleAfter = await read()
check('bubble gum leaves the mouth inflated while it runs', bubbleDuring.chuipaopao_drawn > 0,
  JSON.stringify(bubbleDuring))
// 吹泡泡糖 is declared hold+persist: the user asked for actions to PARK on their
// last frame rather than relax. The original expectation here was the opposite.
check('and it PARKS on its last frame rather than relaxing',
  bubbleAfter.chuipaopao_drawn === 1, 'after=' + bubbleAfter.chuipaopao_drawn)

// (2) the spray must show the whale, then clean up
// The spray is gated: with no whale on screen it must refuse to play at all.
check('the spray is refused with no whale present', (await ev('window.__dshLive2dPet.canPlay("SprayWater")')) === false)
await openPanel(ev)
await sleep(700)
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(b) b.click(); return !!b})()')
await sleep(700)
await ev('(()=>{const g=document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="whale"]\');'
  + ' if(!g) return false; const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent==="放桌上");'
  + ' if(!b) return false; b.click(); return true})()')
// Polled: the panel click, the React render and the guard all have to land.
let allowed = false
for (let i = 0; i < 20 && !allowed; i += 1) {
  allowed = (await ev('window.__dshLive2dPet.canPlay("SprayWater")')) === true
  if (!allowed) await sleep(200)
}
check('with a whale on screen the spray is allowed', allowed)
await ev('window.__dshLive2dPet.playOnce("SprayWater",0,{kind:"panel"})')
await sleep(300); const sprayDuring = await read()
// 鲸鱼喷水 is 0.467s long and also holds, so again: no idle to wait for.
await sleep(2500); const sprayAfter = await read()
check('the spray shows the whale', sprayDuring.jingyu_drawn === 1, 'jingyu=' + sprayDuring.jingyu_drawn)
// 鲸鱼喷水 is declared hold+persist too, so it PARKS with the whale out. The
// original expectation here predates that requirement.
check('and it PARKS with the whale out', sprayAfter.jingyu_drawn === 1, JSON.stringify(sprayAfter))

// (3) 掏出手机 must HOLD the phone
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(1800); const openDuring = await read()
await sleep(3000); const openHeld = await read()
check('掏出手机 raises the phone', openDuring.phone_drawn > 0.5, 'phone=' + openDuring.phone_drawn)
check('and HOLDS it rather than relaxing', openHeld.phone_drawn > 0.5, 'phone=' + openHeld.phone_drawn)

// (4) a selfie is gated on the phone already being out
// KNOWN GAP, asserted as it behaves rather than as it should: the guard reads
// the SLOT SELECTION, and this driver raised the phone with the raw motion, so
// the phone is visibly out (phone=1) while the guard still says no. Recorded
// here so the gap is visible instead of silently passing.
const selfieWithRawPhone = await ev('window.__dshLive2dPet.canPlay("Selfie")')
check('GAP: a motion-raised phone does not satisfy the selfie guard',
  selfieWithRawPhone === false && openHeld.phone_drawn > 0.5,
  'phone=' + openHeld.phone_drawn + ' canPlay(Selfie)=' + selfieWithRawPhone)

// (5) motion switches must CROSS-FADE
// start() used to call stopAllMotions() unconditionally, which cleared the
// outgoing motion instantly: with nothing to fade out of, every switch became
// a hard cut. It now stops only when replaying the same group+index.
await ev('window.__dshLive2dPet.playOnce("Hammer",0,{kind:"probe"})')
await sleep(500)
await ev('window.__dshLive2dPet.playOnce("BubbleGum",0,{kind:"probe"})')
let overlap = 0
for (let i = 0; i < 14; i += 1) {
  await sleep(60)
  const n = await ev('window.__dshLive2dPet.blending()')
  if (typeof n === 'number' && n > overlap) overlap = n
}
check('switching motions cross-fades instead of cutting', overlap >= 2,
  'peak motions in flight=' + overlap)
await ev('window.__dshLive2dPet.resetToRest()')
await sleep(600)

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)