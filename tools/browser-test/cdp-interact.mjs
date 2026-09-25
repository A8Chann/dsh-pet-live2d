// 互动与气泡：摸头/摸尾巴/转圈三个互动、相位台词、以及"所有文本/位置/开关都可配"。
//
// 对应用户这批的 (2)(3)(4)(5)(6)(7)(8)。断言分两类：
//   - **机制**：判定/触发真的发生了（摸尾巴命中、转圈累计够、相位弹台词）；
//   - **可配**：改设置真的改变行为（文本、偏移、开关），读的是"有效值"而不是 input.value。
//
// 注意：本 driver 必须用 `run-suite.mjs --jobs 1 interact` 跑（BASE 由 run-suite 拉起）。
// 裸跑 `node cdp-interact.mjs` 时 BASE 无人服务，页面加载不出来，而 waitReady 返回 false
// 不会自己抛 —— 表现是一堆"设置挂不出来"的假红。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel, pageErrors } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9388
const PROFILE = join(PROFILES, '_cdp-interact')
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

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(200) }
  return false
}
/** 防崩的 JSON 读口：读不到就返回 null，而不是让整个 driver 抛在 JSON.parse 上。 */
const json = async (expr) => {
  const raw = await ev(expr)
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}
const bubble = () => ev('(document.querySelector("[data-dsh-live2d-pet] [data-bubble]")||{}).textContent ?? null')
/** 用原生 setter 派发，React 的受控 input 才认（直接改 .value 会被忽略）。 */
const setInput = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (el === null) return false
  const proto = el.type === 'checkbox' ? window.HTMLInputElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, ${JSON.stringify(String(value))})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
/** 勾/取消一个开关（checkbox 用 click() 才会走 React 的 onChange）。 */
const setFlag = (key, wanted) => ev(`(() => {
  const box = document.querySelector('#dsh-settings-probe [data-flag=${JSON.stringify(key)}]')
  if (box === null) return false
  if (box.checked !== ${wanted ? 'true' : 'false'}) box.click()
  return true
})()`)

check('页面真的加载出来了（BASE 有服务）', (await ev('!!window.__dshLive2dPet')) === true, 'BASE=' + BASE)
check('模型与点击遮罩就绪', (await waitReady(ev)) === true)

// 把设置正文挂进探针容器（drivers 一直这么干；重复挂载会翻倍，所以先查在不在）。
const openSettings = async () => ev('(() => {'
  + ' if (document.querySelector("#dsh-settings-probe")) return true;'
  + ' const slot = (window.__pluginSections ?? {})["pet-settings"];'
  + ' if (!slot) return false;'
  + ' const host = document.createElement("div"); host.id = "dsh-settings-probe"; document.body.appendChild(host);'
  + ' window.ReactDOM.createRoot(host).render(slot.render());'
  + ' return true })()')
await openPanel(ev)
let mounted = false
for (let i = 0; i < 20 && !mounted; i += 1) { mounted = (await openSettings()) === true; if (!mounted) await sleep(300) }
check('设置正文能挂出来', mounted)
await sleep(900)

// --- (2)(3)(4) 设置里必须真的能配 ------------------------------------------
const cards = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-card]")).map(n => n.getAttribute("data-card")))')
check('设置页有「互动」卡', String(cards).includes('interact'), cards)
check('设置页有「气泡」卡', String(cards).includes('bubble'), cards)
const flags = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-flag]")).map(n => n.getAttribute("data-flag")))')
for (const key of ['patEnabled', 'tailEnabled', 'spinEnabled', 'bubbleEnabled']) {
  check('开关存在：' + key, String(flags).includes(key), flags)
}
const sliders = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-input]")).map(n => n.getAttribute("data-input")))')
for (const key of ['bubbleOffsetX', 'bubbleOffsetY', 'bubbleHoldMs', 'spinTurns', 'spinWindowMs']) {
  check('滑杆存在：' + key, String(sliders).includes(key), '')
}
// 台词：每个字段都要有输入框（"所有的文本都可配"）。
// fields 读不到就**判失败**，不能当成"没有字段所以全都有"（空洞断言）。
const fields = await json('JSON.stringify(window.__dshLive2dPet.lineFields())')
check('台词字段清单读得到（否则下面的"都有输入框"会空洞通过）',
  fields !== null && Array.isArray(fields.plain) && fields.plain.length >= 7, JSON.stringify(fields))
const missing = []
for (const key of (fields?.plain ?? [])) {
  const found = await ev('document.querySelector("#dsh-settings-probe [data-line-input=\\"' + key + '\\"]") !== null')
  if (found !== true) missing.push(key)
}
for (const key of (fields?.phase ?? [])) {
  const found = await ev('document.querySelector("#dsh-settings-probe [data-line-input=\\"phase:' + key + '\\"]") !== null')
  if (found !== true) missing.push('phase:' + key)
}
check('每条台词都有输入框（问候/摸头/相位…全都能改）',
  (fields?.plain?.length ?? 0) > 0 && missing.length === 0, '缺: ' + JSON.stringify(missing))
// 反应候选：三组 chips，且默认值与宠物声明一致
const chips = await json(`JSON.stringify({
  pat: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="patReactions"] [data-reaction-chip]').length,
  tail: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="tailReactions"] [data-reaction-chip]').length,
  spin: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="spinReactions"] [data-reaction-chip]').length,
  patOn: window.__dshLive2dPet.effectiveReactions('patReactions'),
  tailOn: window.__dshLive2dPet.effectiveReactions('tailReactions'),
  spinOn: window.__dshLive2dPet.effectiveReactions('spinReactions'),
})`)
check('三组反应候选都渲染出来了（chips 数 > 0）',
  (chips?.pat ?? 0) > 0 && (chips?.tail ?? 0) > 0 && (chips?.spin ?? 0) > 0,
  JSON.stringify({ pat: chips?.pat, tail: chips?.tail, spin: chips?.spin }))
check('摸头默认候选 = 宠物声明的三个',
  (chips?.patOn ?? []).length === 3 && (chips?.patOn ?? []).includes('重锤出击'), JSON.stringify(chips?.patOn))
check('转晕默认候选 = 晕晕', (chips?.spinOn ?? []).includes('晕晕'), JSON.stringify(chips?.spinOn))

// --- (3) 摸尾巴：判定与反应 -------------------------------------------------
// 在网格里找"命中尾巴、但不是头"的点（探针式定位，确定性）。
const tailProbe = await json(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let tail = null, headCount = 0, tailCount = 0
  for (let iy = 0; iy < 40; iy++) {
    for (let ix = 0; ix < 40; ix++) {
      const lx = r.width * (ix + 0.5) / 40, ly = r.height * (iy + 0.5) / 40
      const isTail = c.hitsTail(lx, ly)
      if (c.hitsHead(lx, ly)) headCount += 1
      if (isTail) { tailCount += 1; if (tail === null && !c.hitsHead(lx, ly)) tail = { lx, ly } }
    }
  }
  return JSON.stringify({ tail, headCount, tailCount, rect: { x: r.x, y: r.y } })
})()`)
check('摸尾巴判定有命中区域（模型里确实有尾巴/翅膀部件）',
  (tailProbe?.tailCount ?? 0) > 0, JSON.stringify({ tailCount: tailProbe?.tailCount, headCount: tailProbe?.headCount }))
check('尾巴区域和头部区域是分开的（存在只命中尾巴的点）',
  tailProbe?.tail !== null && tailProbe?.tail !== undefined, JSON.stringify(tailProbe?.tail))

// --- (5)(7)(8) 气泡：相位台词 / 偏移 / 总开关 -------------------------------
await ev('window.__dshLive2dPet.phaseNow("thinking")')
// 问候气泡也在用同一个位置，所以轮询到**等于 thinking 那句**为止。
const thinkingLine = await ev('window.__dshLive2dPet.effectiveLines().phase.thinking')
const phaseSaid = await until(async () => (await bubble()) === thinkingLine, 9000)
check('会话相位会弹台词气泡（thinking）', phaseSaid,
  'bubble=' + (await bubble()) + ' 台词=' + thinkingLine)
// 位置偏移：改滑杆 -> 气泡上的 CSS 变量跟着变（值，不是布局规则）
check('改得了气泡左右偏移', (await setInput('#dsh-settings-probe [data-input="bubbleOffsetX"]', '40')) === true)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("done")')
await until(async () => (await bubble()) !== null, 6000)
const offset = await ev('(() => {'
  + ' const node = document.querySelector("[data-dsh-live2d-pet] [data-bubble]");'
  + ' return node === null ? null : node.style.getPropertyValue("--bubble-x") })()')
check('气泡位置偏移可配（改了立刻反映到气泡上）', offset === '40px', '--bubble-x=' + offset)
// 总开关：关掉之后任何台词都不弹
check('关得掉气泡总开关', (await setFlag('bubbleEnabled', false)) === true)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(600)
// 先确认"这时候本来该弹"：手动把开关开回来试一次，再关掉验证。
await setFlag('bubbleEnabled', true)
await ev('window.__dshLive2dPet.phaseNow("failed")')
const wouldSay = await until(async () => (await bubble()) === (await ev('window.__dshLive2dPet.effectiveLines().phase.failed')), 8000)
check('开着开关时 failed 相位确实会弹（下面那条断言才有意义）', wouldSay, 'bubble=' + (await bubble()))
await setFlag('bubbleEnabled', false)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(500)
// 等上一条气泡自己消失，再触发一次：这次不该出现。
await until(async () => (await bubble()) === null, 8000)
await ev('window.__dshLive2dPet.phaseNow("done")')
await sleep(1500)
check('关掉总开关后不再弹气泡', (await bubble()) === null, 'bubble=' + (await bubble()))
check('开关状态可读（进了同一份设置存档）',
  (await ev('window.__dshLive2dPet.settingsOverrides().flags.bubbleEnabled')) === false)
check('开得回来', (await setFlag('bubbleEnabled', true)) === true)
await sleep(400)

// --- (4) 转圈转晕 -----------------------------------------------------------
// 先把时间窗调大：合成的画圈是**逐次 CDP 往返**（231 次约 1.5-2 秒），默认窗口
// 1600ms 会在转完之前到期、每轮清零。真实用户转两圈约 1 秒，所以默认值没问题 ——
// 需要迁就的是测试。顺带这条断言也就验证了"窗口可配"。
check('时间窗可配（调大到 6000ms）',
  (await setInput('#dsh-settings-probe [data-input="spinWindowMs"]', '6000')) === true)
await sleep(400)
check('窗口设置真的生效了',
  (await ev('window.__dshLive2dPet.spinDebug().windowMs')) === 6000,
  'windowMs=' + await ev('window.__dshLive2dPet.spinDebug().windowMs'))
const spinSetup = await json(`(() => {
  const r = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect()
  return JSON.stringify({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, radius: r.width * 0.45 })
})()`)
const steps = 96
const turns = 3.2
for (let i = 0; i <= steps * turns; i++) {
  const angle = (i / steps) * Math.PI * 2
  const x = Math.round((spinSetup?.cx ?? 0) + Math.cos(angle) * (spinSetup?.radius ?? 100))
  const y = Math.round((spinSetup?.cy ?? 0) + Math.sin(angle) * (spinSetup?.radius ?? 100))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}
const spinLine = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().spin)')
const spun = await until(async () => {
  const text = await bubble()
  return text !== null && String(spinLine).includes(text)
}, 5000)
const spinState = await ev('JSON.stringify(window.__dshLive2dPet.spinDebug())')
check('鼠标绕圈会转晕（弹台词）', spun, 'bubble=' + (await bubble()) + ' 台词=' + String(spinLine) + ' 状态=' + spinState)
check('转圈检测真的触发了（fires > 0，而不是"看着像没反应"）',
  ((await json('JSON.stringify(window.__dshLive2dPet.spinDebug())'))?.fires ?? 0) > 0, spinState)
// 「晕晕」驱动的是 ParamCheek77；`drawn()` 按名字片段找参数，两种写法都试一下，
// 断错参数名会得到"表情没生效"的假象（我第一版写的是 hun，根本不存在）。
const cheekHit = await until(async () => {
  const v = ((await ev('window.__dshLive2dPet.drawn("Cheek77")'))
    ?? (await ev('window.__dshLive2dPet.drawn("ParamCheek77")')) ?? 0)
  return v > 0.1
}, 4000)
check('转晕会演「晕晕」（表情真的写进模型）', cheekHit,
  'Cheek77=' + await ev('window.__dshLive2dPet.drawn("Cheek77")'))

// --- 台词可改：改了之后真的说新的 -------------------------------------------
check('改得了「被转晕」的台词', (await setInput('#dsh-settings-probe [data-line-input="spin"]', '测试专用台词')) === true)
await sleep(400)
const edited = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().spin)')
check('改台词之后有效台词跟着变', String(edited).includes('测试专用台词'), edited)
check('台词覆盖进了同一份设置存档',
  String(await ev('JSON.stringify(window.__dshLive2dPet.settingsOverrides().lines)')).includes('spin'))

const errors = await pageErrors(ev)
check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 240))
const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
