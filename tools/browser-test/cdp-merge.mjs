// Multi-expression layering: several dress-up slots on screen at once.
//
// The engine's expression manager holds exactly ONE expression
// (expressionManager.currentExpression), so pinning several used to reach the
// model as only the last one. The controller now writes the union of their
// parameters itself, at the seam the engine's own expression pass uses.
//
// WHY THIS ASSERTS ON PARAMETERS, NOT PIXELS
// Two earlier versions of this driver compared canvas hashes and both were
// worthless: the pet breathes and blinks continuously, so no two frames are
// ever byte-identical. That made "different art" and "same art" look identical
// (every pair of samples was disjoint), which means cdp-exp's "the canvas
// changed" check has never proved anything either.
//
// The parameters the engine writes inside a frame are deterministic, and they
// are exactly what the merge has to get right: one expression to the engine,
// several parameters in the model.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9385
const PROFILE = join(PROFILES, '_cdp-merge')
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
let nextId = 0; const pending = new Map(); ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }

// Sample the parameters at the END of a frame, where the engine's own
// expression pass has already written them and nothing has restored them yet.
const WATCH = ["ParamCheek70", "ParamCheek83", "cc2", "maoshou", "mozhua", "mozhua2"]
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

/** Read the parameters as the engine wrote them in the most recent frame. */
const frame = async () => JSON.parse(await ev('JSON.stringify(window.__last)'))
/**
 * Apply a pin set and wait for the switches to settle.
 *
 * A fixed sleep is not enough: the engine fades an expression in, and a merged
 * one is fetched over HTTP first, so a 2s wait caught it 2% of the way through
 * its fade. Poll instead, and treat a value that has reached its target (or
 * stopped moving for a while) as settled.
 */
const apply = async (names, expect) => {
  await ev('window.__dshLive2dPet.setExpressions(' + JSON.stringify(names) + ')')
  let last = null
  const wanted = Object.entries(expect ?? {})
  for (let i = 0; i < 48; i += 1) {
    await sleep(250)
    const now = await frame()
    if (now === null) continue
    last = now
    if (wanted.every(([name, value]) => at(now, name) === value)) return now
  }
  return last
}
const at = (values, name) => values[WATCH.indexOf(name)]

const empty = await apply([], { ParamCheek70: 0, ParamCheek83: 0, cc2: 0 })
check('with nothing pinned every switch is off', WATCH.every((n) => at(empty, n) === 0), JSON.stringify(empty))

const glasses = await apply(['圆眼镜'], { ParamCheek70: 1 })
check('圆眼镜 writes only its own switch',
  at(glasses, 'ParamCheek70') === 1 && at(glasses, 'ParamCheek83') === 0, JSON.stringify(glasses))

const sticker = await apply(['猫猫贴纸'], { ParamCheek83: 1, ParamCheek70: 0 })
check('猫猫贴纸 writes only its own switch',
  at(sticker, 'ParamCheek83') === 1 && at(sticker, 'ParamCheek70') === 0, JSON.stringify(sticker))

// --- the 装扮 tab, driven the way a user drives it -------------------------
// Start from a known state: the parameter checks above left a pin behind.
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(900)
await openPanel(ev)
await sleep(700)
await ev('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));'
  + ' const b=bs.find((x)=>x.textContent.indexOf("装扮")===0); if(!b) return false; b.click(); return true})()')
await sleep(700)
const slotCount = await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-slot]").length')
check('the 装扮 tab lists every slot', slotCount === 17, 'slots=' + slotCount)

/** Click a chip in the panel by its slot id and visible label. */
const pick = async (slotId, label, expect) => {
  await ev('(()=>{const g=document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-panel] [data-slot="' + slotId + '"]')
    + '); if(!g) return false;'
    + ' const b=Array.from(g.querySelectorAll("[data-chips] button")).find((x)=>x.textContent===' + JSON.stringify(label) + ');'
    + ' if(!b) return false; b.click(); return true})()')
  let last = null
  const wanted = Object.entries(expect ?? {})
  for (let i = 0; i < 48; i += 1) {
    await sleep(250)
    const now = await frame()
    if (now === null) continue
    last = now
    if (wanted.every(([name, value]) => at(now, name) === value)) return now
  }
  return last
}
const uiGlasses = await pick('glasses', '圆眼镜', { ParamCheek70: 1 })
check('picking 圆眼镜 in the panel turns its switch on', at(uiGlasses, 'ParamCheek70') === 1, JSON.stringify(uiGlasses))
const uiBoth = await pick('sticker', '猫猫', { ParamCheek70: 1, ParamCheek83: 1 })
check('then picking 猫猫 keeps the glasses on',
  at(uiBoth, 'ParamCheek70') === 1 && at(uiBoth, 'ParamCheek83') === 1, JSON.stringify(uiBoth))
// 白魔爪 is 魔爪换色 layered on 桌面粉魔爪: the recolour alone renders nothing
// because there is no claw to recolour, so the option must carry BOTH and the
// slot must be told to compare all of them.
const pink = await pick('claw', '粉魔爪', { mozhua: 1, mozhua2: 0 })
check('粉魔爪 turns the claw on, uncoloured',
  at(pink, 'mozhua') === 1 && at(pink, 'mozhua2') === 0, JSON.stringify(pink))
const white = await pick('claw', '白魔爪', { mozhua: 1, mozhua2: 1 })
check('白魔爪 turns the claw on AND recolours it',
  at(white, 'mozhua') === 1 && at(white, 'mozhua2') === 1, JSON.stringify(white))
const clawsOff = await pick('claw', '无', { mozhua: 0, mozhua2: 0 })
check('clearing the claw slot drops both',
  at(clawsOff, 'mozhua') === 0 && at(clawsOff, 'mozhua2') === 0, JSON.stringify(clawsOff))

const uiOff = await pick('glasses', '无', { ParamCheek70: 0, ParamCheek83: 1 })
check('and clearing one slot leaves the other alone',
  at(uiOff, 'ParamCheek70') === 0 && at(uiOff, 'ParamCheek83') === 1, JSON.stringify(uiOff))
await pick('sticker', '无', { ParamCheek83: 0 })
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(800)

// The whole point: both switches on in the SAME frame.
//
// The engine's manager cannot do this — it holds one expression — so the
// controller writes the union itself, at the same seam (right after the engine
// restores its post-motion values) and with the same Add arithmetic.
const pair = await apply(['圆眼镜', '猫猫贴纸'], { ParamCheek70: 1, ParamCheek83: 1 })
check('two slots reach the model at once',
  at(pair, 'ParamCheek70') === 1 && at(pair, 'ParamCheek83') === 1, JSON.stringify(pair))

const trio = await apply(['圆眼镜', '猫猫贴纸', '深色桌布'], { ParamCheek70: 1, ParamCheek83: 1, cc2: 1 })
check('three slots reach the model at once',
  at(trio, 'ParamCheek70') === 1 && at(trio, 'ParamCheek83') === 1 && at(trio, 'cc2') === 1,
  JSON.stringify(trio) + '  pinned=' + await ev('JSON.stringify(window.__dshLive2dPet.expressions())')
  + ' layers=' + await ev('window.__dshLive2dPet.expressionLayerCount()'))

// Dropping back to one slot must not leave the others behind.
const only = await apply(['圆眼镜'], { ParamCheek70: 1, ParamCheek83: 0 })
check('dropping a slot turns its switch back off',
  at(only, 'ParamCheek70') === 1 && at(only, 'ParamCheek83') === 0, JSON.stringify(only))

const back = await apply([], { ParamCheek70: 0, ParamCheek83: 0, cc2: 0 })
check('clearing turns them all back off', WATCH.every((n) => at(back, n) === 0), JSON.stringify(back))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close(); edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
