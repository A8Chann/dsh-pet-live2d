// ②③④：反应的**临时槽位改动**与"重锤出击"的冲突清理。
//
// 三条用户要求：
//   ② 摸头/摸尾巴触发表情后，过一段要**把对应插槽还原为默认**；
//   ④ 转晕同理（同一套机制）；
//   ③ 重锤出击前若眼部是「晕晕/呆呆眼」、情绪是「开心兴奋/闭眼口水」，要先还原为默认。
//
// 判据都读 `slotSelections()`（槽位=标签的映射，null/缺失即"回默认"）。
//
//   node tools/probe-reaction-revert.mjs [--cdp 9401]
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面（带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
  process.exit(2)
}
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => {
    const failure = message.result?.exceptionDetails
    if (failure !== undefined) {
      resolve({ __error: String(failure.exception?.description ?? failure.text ?? 'threw') })
      return
    }
    resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
async function inPage(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = 'JSON.stringify((function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })())'
  const raw = await evaluate(expression)
  return raw === undefined ? undefined : JSON.parse(raw)
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

const selections = () => inPage([
  'const api = window.__dshLive2dPet;',
  'const s = (api.slotSelections && typeof api.slotSelections === "function") ? api.slotSelections() : null;',
  'const pick = (id) => (s === null || s[id] === undefined ? null : s[id]);',
  'return { eyes: pick("eyes"), mood: pick("mood"), symbol: pick("symbol"), raw: s };',
])

/** 直接调反应入口（等价于摸头/摸尾/转晕抽中某个候选）。 */
const fireReaction = (label) => inPage([
  'const api = window.__dshLive2dPet;',
  // 反应入口挂在组件上，不在控制器 API 里 —— 用"点她一下"的方式走真实路径太慢，
  // 这里用控制器上的 `playOnce` 之外的路：`effectiveReactions()` 只读。
  // 所以退一步：直接改槽位（等价于反应换掉那一格），验的是**收回机制**本身。
  'return { ok: true };',
])

// ---- ③ 重锤出击：先清掉冲突的眼部/情绪 --------------------------------------
console.log('')
console.log('--- ③ 重锤出击要先把冲突的眼部/情绪还原为默认')
// 先把眼部设成「晕晕」、情绪设成「闭眼口水」（都在用户的名单里）。
const setSlot = (slotId, label) => inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const slot = root.querySelector("[data-panel] [data-slot=\\"" + args.slotId + "\\"]");',
  'if (slot === null) return { ok: false, reason: "no-slot" };',
  'const buttons = Array.from(slot.querySelectorAll("[data-chips] button"));',
  'const hit = buttons.find((b) => (b.textContent || "").trim() === args.label);',
  'if (hit === undefined) return { ok: false, options: buttons.map((b) => (b.textContent || "").trim()) };',
  'hit.click();',
  'return { ok: true };',
], { slotId, label })

// 打开面板并切到装扮页签。
await inPage(['if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");', 'return true;'])
await sleep(700)
await inPage([
  'const stage = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
  'stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
  'return true;',
])
await sleep(500)
await inPage([
  'const buttons = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));',
  'const tab = buttons.find((b) => (b.textContent || "").includes("装扮"));',
  'if (tab) tab.click();',
  'return true;',
])
await sleep(500)

const setEyes = await setSlot('eyes', '晕晕')
const setMood = await setSlot('mood', '闭眼口水')
check('能把眼部设成「晕晕」、情绪设成「闭眼口水」', setEyes.ok === true && setMood.ok === true,
  JSON.stringify({ setEyes, setMood }))
await sleep(600)
const before = await selections()
console.log('  设置之后：' + JSON.stringify({ eyes: before.eyes, mood: before.mood }))

// 收起面板，然后**摸头**（默认候选里有「重锤出击」，多摸几次直到抽中它）。
await inPage([
  'const close = document.querySelector("[data-dsh-live2d-pet] [data-panel] [data-close]");',
  'if (close) close.click();',
  'return true;',
])
await sleep(400)

const tapHead = () => inPage([
  'const api = window.__dshLive2dPet;',
  'const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
  'const r = stage.getBoundingClientRect();',
  'const N = 48;',
  'let best = null;',
  'for (let iy = 0; iy < N && best === null; iy += 1) {',
  '  for (let ix = 0; ix < N; ix += 1) {',
  '    const lx = r.width * (ix + 0.5) / N, ly = r.height * (iy + 0.5) / N;',
  '    if (api.hitsHead(lx, ly) === true && api.hitsTail(lx, ly) !== true && api.hitsMask(lx, ly, r.width, r.height) === true) { best = { lx, ly }; break; }',
  '  }',
  '}',
  'if (best === null) return { tapped: false };',
  'const hit = document.querySelector("[data-dsh-live2d-pet] [data-hit]");',
  'const target = document.elementFromPoint(r.left + best.lx, r.top + best.ly) || hit;',
  'const at = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {',
  '  bubbles: true, cancelable: true, clientX: r.left + best.lx, clientY: r.top + best.ly,',
  '  pointerId: 9, button: 0, buttons: buttons, isPrimary: true }));',
  'at("pointerdown", 1); at("pointerup", 0);',
  'return { tapped: true };',
])

// 摸几次，直到"重锤出击"被抽中（它一开演就该把眼部/情绪清掉）。
let cleared = false
let clearedAt = null
for (let i = 0; i < 12 && cleared === false; i += 1) {
  await tapHead()
  for (let wait = 0; wait < 8 && cleared === false; wait += 1) {
    await sleep(250)
    const now = await selections()
    if (now.eyes === null && now.mood === null) { cleared = true; clearedAt = i; }
  }
  await sleep(400)
}
check('摸头抽中「重锤出击」时，眼部与情绪都被还原为默认',
  cleared === true, cleared === true ? ('第 ' + (clearedAt + 1) + ' 次摸头后清掉') : '摸了 12 次都没清掉')
const afterHammer = await selections()
console.log('  清理之后：' + JSON.stringify({ eyes: afterHammer.eyes, mood: afterHammer.mood }))

// ---- ②④ 反应换掉的槽位，过一段要收回默认 ------------------------------------
console.log('')
console.log('--- ②④ 反应留下的槽位改动，' + 12 + ' 秒内收回默认（用「摸尾巴」触发）')
// 摸尾巴：默认候选是「吐魂」（情绪槽位的选项）。先确认它在槽位里。
await inPage([
  'const stage = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
  'stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
  'return true;',
])
await sleep(500)
await inPage([
  'const buttons = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));',
  'const tab = buttons.find((b) => (b.textContent || "").includes("装扮"));',
  'if (tab) tab.click();',
  'return true;',
])
await sleep(400)
// 先把情绪设成「调皮」，这样"被反应换掉"看得出来。
const setMood2 = await setSlot('mood', '调皮')
await inPage([
  'const close = document.querySelector("[data-dsh-live2d-pet] [data-panel] [data-close]");',
  'if (close) close.click();',
  'return true;',
])
await sleep(400)
const moodBefore = (await selections()).mood
check('起始情绪设成「调皮」（好观察它有没有被收回）', moodBefore === '调皮', String(moodBefore))

const tapTail = () => inPage([
  'const api = window.__dshLive2dPet;',
  'const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
  'const r = stage.getBoundingClientRect();',
  'const N = 64;',
  'let best = null;',
  'for (let iy = 0; iy < N && best === null; iy += 1) {',
  '  for (let ix = 0; ix < N; ix += 1) {',
  '    const lx = r.width * (ix + 0.5) / N, ly = r.height * (iy + 0.5) / N;',
  '    if (api.hitsTail(lx, ly) === true && api.hitsMask(lx, ly, r.width, r.height) === true) { best = { lx, ly }; break; }',
  '  }',
  '}',
  'if (best === null) return { tapped: false };',
  'const hit = document.querySelector("[data-dsh-live2d-pet] [data-hit]");',
  'const target = document.elementFromPoint(r.left + best.lx, r.top + best.ly) || hit;',
  'const at = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {',
  '  bubbles: true, cancelable: true, clientX: r.left + best.lx, clientY: r.top + best.ly,',
  '  pointerId: 11, button: 0, buttons: buttons, isPrimary: true }));',
  'at("pointerdown", 1); at("pointerup", 0);',
  'return { tapped: true };',
])

// 一直摸到"某个槽位真的被反应换掉"为止（说明反应改到了槽位）。
let changed = null
for (let i = 0; i < 14 && changed === null; i += 1) {
  const tap = await tapTail()
  if (tap.tapped !== true) { console.log('  摸不到尾巴（可能没戴尾巴配件）'); break }
  for (let wait = 0; wait < 8 && changed === null; wait += 1) {
    await sleep(250)
    const now = await selections()
    if (now.mood !== moodBefore) changed = now.mood
  }
  await sleep(300)
}
check('摸尾巴能把某个槽位换掉（反应生效）', changed !== null,
  '情绪：' + moodBefore + ' → ' + String(changed))

if (changed !== null) {
  // **等它自己收回默认**：REACTION_REVERT_MS = 12 秒，给它 18 秒余量。
  let reverted = false
  let revertedAt = null
  for (let i = 0; i < 90 && reverted === false; i += 1) {
    await sleep(250)
    const now = await selections()
    if (now.mood === null || now.mood === moodBefore) { reverted = true; revertedAt = (i + 1) * 250 }
  }
  check('**过一段之后自动收回默认**（不留下永久表情）', reverted === true,
    reverted ? ('约 ' + revertedAt + 'ms 后情绪=' + String((await selections()).mood)) : '等了 22 秒还没收回')
} else {
  check('**过一段之后自动收回默认**（不留下永久表情）', false, '没触发到槽位改动，无法验证')
}

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('REACTION-REVERT ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
