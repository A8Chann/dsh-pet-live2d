// **摸头 / 摸尾巴不该还原当前动作** —— 验证这一条。
//
// 用户的原话："摸头和摸尾巴不要还原当前动作啊，随机到哪一个插槽里的就放哪一个插槽里的就行了。"
//
// 所以判据是两条：
//   ① 先钉一个**槽位动作**（吹泡泡糖 / 掏出手机这种），再摸头 —— 那个动作**必须还在**
//      （原来会在反应结束时 `playIdle()`，把她整个拉回待机）；
//   ② 反应本身照常发生（台词弹出来），而且在"抽中的标签真的是槽位选项"时，它换的是**那一格**。
//
//   node tools/probe-reaction-keeps-action.mjs [--cdp 9401]
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
  console.error('CDP ' + CDP + ' 上没有页面（先带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
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
  pending.set(id, (message) => resolve(message.result?.result?.value))
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

/** 她的当前状态：动作组、kind、以及**画面值**（不是帧外基线）。 */
const state = () => inPage([
  'const api = window.__dshLive2dPet;',
  'const el = document.querySelector("[data-dsh-live2d-pet]");',
  // ⚠️ 读**画面值**必须用 `drawn(id)`（画出来的那一帧的钩子）。`params()` 那套读的是帧外
  // 基线，待机循环会把它拉回 0 —— 拿它断言"手机还举着"必然误判（本轮先踩了一次）。
  'let phone = null;',
  'try { phone = api.drawn("phone"); } catch (e) { phone = "threw:" + String(e && e.message); }',
  'return {',
  '  motion: el.getAttribute("data-motion"),',
  '  phase: el.getAttribute("data-phase"),',
  '  group: (api.currentGroup && api.currentGroup()) || null,',
  '  kind: (api.kind && typeof api.kind === "function") ? api.kind() : null,',
  '  phone: typeof phone === "number" ? Number(phone.toFixed(3)) : phone,',
  '};',
])

/**
 * 钉一个**槽位动作**：**按键找**覆盖所有槽位的那个按钮并点它（和用户点的一样）。
 *
 * 踩过的两个坑：
 *   * 按 `[data-slot-option]` 找 —— 那是**动作页签里带动作的芯片**（`data-slot-option`
 *     挂在它上面），在装扮页签上点它不生效，表现是"点了没反应"；
 *   * 按 `[data-slots] button` 那种猜标记找 —— 根本没这个元素。
 * 正确的是 `[data-panel] [data-slot="<槽位 id>"] [data-chips] button`（含文字匹配），
 * 与 `cdp-bubble` 的 `clickSlot` 一致。
 */
async function pinSlotAction(label) {
  return inPage([
    'const root = document.querySelector("[data-dsh-live2d-pet]");',
    'const slots = Array.from(root.querySelectorAll("[data-panel] [data-slot]"));',
    'for (const slot of slots) {',
    '  const buttons = Array.from(slot.querySelectorAll("[data-chips] button"));',
    '  const hit = buttons.find((b) => (b.textContent || "").trim() === args.label);',
    '  if (hit === undefined) continue;',
    '  hit.click();',
    '  return { pinned: true, slot: slot.getAttribute("data-slot"), rect: (() => { const b = hit.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() };',
    '}',
    'return { pinned: false, reason: "not-found" };',
  ], { label })
}

const bubble = () => inPage([
  'const el = document.querySelector("[data-dsh-live2d-pet] [data-bubble]");',
  'return { text: el === null ? null : (el.textContent || "").trim() };',
])

/** 摸一下头：找一个**只算头**的点并点它（和 cdp-interact 同一套找点方式）。 */
async function tapHead() {
  return inPage([
    'const api = window.__dshLive2dPet;',
    'const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
    'const r = stage.getBoundingClientRect();',
    'const N = 48;',
    'let best = null;',
    'for (let iy = 0; iy < N && best === null; iy += 1) {',
    '  for (let ix = 0; ix < N; ix += 1) {',
    '    const lx = r.width * (ix + 0.5) / N, ly = r.height * (iy + 0.5) / N;',
    '    const h = api.hitsHead(lx, ly), t = api.hitsTail(lx, ly);',
    '    if (h === true && t !== true && api.hitsMask(lx, ly, r.width, r.height) === true) { best = { lx, ly }; break; }',
    '  }',
    '}',
    'if (best === null) return { tapped: false };',
    'const hit = document.querySelector("[data-dsh-live2d-pet] [data-hit]");',
    'const target = document.elementFromPoint(r.left + best.lx, r.top + best.ly) || hit;',
    'const at = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {',
    '  bubbles: true, cancelable: true, clientX: r.left + best.lx, clientY: r.top + best.ly,',
    '  pointerId: 7, button: 0, buttons: buttons, isPrimary: true }));',
    'at("pointerdown", 1);',
    'at("pointerup", 0);',
    'return { tapped: true, at: best };',
  ])
}

// ---- 侦察：面板里有哪些槽位选项（决定能不能钉一个动作）---------------------
const chipProbe = await inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const panel = root.querySelector("[data-panel]");',
  'const chips = Array.from(root.querySelectorAll("[data-slots] button, [data-slot] button, [data-chip]"));',
  'return { panel: panel !== null, chips: chips.length, labels: chips.map((b) => (b.textContent || "").trim()).slice(0, 30) };',
])
console.log('面板状态：' + JSON.stringify(chipProbe))

// 打开面板（右键），再切到"装扮"页签找芯片。
await inPage([
  'const stage = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
  'stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
  'return true;',
])
await sleep(500)
const slotsTab = await inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const buttons = Array.from(root.querySelectorAll("[data-panel] [data-tabs] button"));',
  'const tab = buttons.find((b) => (b.textContent || "").includes("装扮"));',
  'if (tab !== undefined) tab.click();',
  'return { tabs: buttons.map((b) => (b.textContent || "").trim()), clicked: tab !== undefined };',
])
console.log('页签：' + JSON.stringify(slotsTab))
await sleep(600)

const chipProbe2 = await inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const chips = Array.from(root.querySelectorAll("[data-panel] button")).filter((b) => {',
  '  const t = (b.textContent || "").trim();',
  '  return t === "吹泡泡糖" || t === "掏出手机" || t === "自拍动画" || t === "挤番茄酱";',
  '});',
  'return { found: chips.map((b) => (b.textContent || "").trim()) };',
])
console.log('槽位动作芯片：' + JSON.stringify(chipProbe2))

// 相位会**接管槽位动作**（设计如此：会话进行中相位优先），所以先把相位切到 idle ——
// 否则"钉一个槽位动作"根本立不住（第一版在这种状态下量到"手机没举起来"，其实是相位在演）。
await inPage([
  'if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");',
  'return true;',
])
await sleep(900)

const pin = await pinSlotAction('掏出手机')
check('能在面板里钉一个槽位动作（掏出手机）', pin.pinned === true, JSON.stringify(pin))
if (pin.pinned === true) {
  // **轮询到姿势真的到位**，而不是睡一个猜出来的毫秒数就断言。
  // （`cdp-bubble` 用的也是这套；点完立刻读会拿到还在缓动中的 0。）
  let pinned = null
  for (let i = 0; i < 30; i += 1) {
    pinned = await state()
    if ((pinned.phone ?? 0) > 0.5) break
    await sleep(200)
  }
  const pinnedPhone = pinned?.phone ?? 0
  check('钉上之后手机真的举起来了（姿势在）', pinnedPhone > 0.5, JSON.stringify(pinned))
  // 收起面板，免得挡住点击。
  await inPage([
    'const close = document.querySelector("[data-dsh-live2d-pet] [data-panel] [data-close]");',
    'if (close) close.click();',
    'return true;',
  ])
  await sleep(400)

  const tap = await tapHead()
  check('找得到一个只算头的点并点到了她', tap.tapped === true, JSON.stringify(tap))
  if (tap.tapped === true) {
    // 反应是异步的（台词要缓一下），等它出来再等它结束。
    let said = null
    for (let i = 0; i < 20 && said === null; i += 1) {
      const now = await bubble()
      if (now.text !== null && now.text !== '') said = now.text
      else await sleep(200)
    }
    check('摸头照常有反应（弹了台词）', said !== null, 'bubble=' + JSON.stringify(said))
    // 反应全程 + 收尾（原来就是在这里被 playIdle 拉回待机的）。
    await sleep(7000)
    const after = await state()
    const afterPhone = after.phone ?? 0
    check('**摸头之后手机还在手里**（当前动作没被还原）',
      afterPhone > 0.5,
      '之前 phone=' + pinnedPhone + '  之后 phone=' + afterPhone + '  kind=' + after.kind + ' group=' + after.group)
    check('当前动作组仍然是那个槽位动作（没被换成 idle）',
      after.group === pinned.group,
      '之前 ' + pinned.group + ' → 之后 ' + after.group)
  }
}

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('REACTION-KEEPS-ACTION ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
