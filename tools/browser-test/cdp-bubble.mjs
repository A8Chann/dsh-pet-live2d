// 吹泡泡糖这类「动作 + 定格」状态必须能真的关掉。
//
// 这个 driver 存在的唯一理由：那个 bug 前后骗过两个人两次，而两次都是
// 量错了地方。引擎的一帧是
//
//     saveParameters() -> update() -> loadParameters()
//
// 我们的图层（表情 / 嘴 / 扫动画 / 动作还原）写在 saveParameters 缝上，
// update() 把当时的值烘进模型，然后**帧尾的 loadParameters() 把引擎自己的
// 基线整片盖回来**。于是帧外读 core._model.parameters.values 拿到的永远是
// 「图层之前」的姿势：动作停了它还是 1，看起来就是"关不掉"。
//
// 所以这里的断言一律走 window.__dshLive2dPet.drawn(id)：那是上一帧真正画
// 出去的值。raw 基线也照样读一次并断言，把这条缝钉死在测试里——哪天引擎换
// 了帧序，这条会先炸，而不是等到用户来报"又关不掉了"。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel } from './ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9383
const PROFILE = join(PROFILES, '_cdp-bubble')
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

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '   ' + detail))
}
/** 上一帧真正画出去的值。 */
const drawn = (id) => ev('window.__dshLive2dPet.drawn(' + JSON.stringify(id) + ')')
/** 帧尾 loadParameters() 之后的基线值，也就是引擎自己的姿势。 */
const raw = (id) => ev('(() => { const p = window.__PET_DBG.core._model.parameters;'
  + ' const i = Array.from(p.ids).indexOf(' + JSON.stringify(id) + '); return i < 0 ? null : +p.values[i].toFixed(3) })()')
/** 轮询到条件成立，返回是否成立。 */
const until = async (fn, tries = 30, gap = 200) => {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    last = await fn()
    if (last === true) return true
    await sleep(gap)
  }
  return last
}

await openPanel(ev)
await sleep(700)
await ev('(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b = bs.find((x) => x.textContent.indexOf("装扮") === 0); if (b) b.click(); return !!b })()')
await sleep(700)

/** 点某个槽位的选项；label 为 null 时点它的「无」。 */
const clickSlot = (slot, label) => ev('(() => {'
  + ' const g = document.querySelector(\'[data-dsh-live2d-pet] [data-panel] [data-slot="' + slot + '"]\');'
  + ' if (!g) return "NOSLOT";'
  + ' const bs = Array.from(g.querySelectorAll("[data-chips] button"));'
  + ' const b = ' + (label === null
    ? 'bs.find((x) => !x.hasAttribute("data-slot-option"))'
    : 'bs.find((x) => x.textContent === ' + JSON.stringify(label) + ')')
  + '; if (!b) return "NOBTN:" + bs.map((x) => x.textContent).join("/");'
  + ' b.click(); return "OK" })()')

// (1) 起点：嘴是闭的
check('吹泡泡糖之前嘴是闭的（画面 0）', (await drawn('chuipaopao')) === 0,
  'drawn=' + (await drawn('chuipaopao')) + ' raw=' + (await raw('chuipaopao')))

// (2) 选吹泡泡糖 -> 画面里的嘴鼓起来
check('吹泡泡糖能把嘴吹起来', (await clickSlot('mouth', '吹泡泡糖')) === 'OK')
check('画面里的嘴鼓起（chuipaopao 与 chuipaopao2 都是 1）',
  (await until(async () => (await drawn('chuipaopao')) === 1 && (await drawn('chuipaopao2')) === 1)),
  'drawn=' + (await drawn('chuipaopao')) + '/' + (await drawn('chuipaopao2')))

// (3) 切回无 -> 画面里的嘴必须瘪回去。这是核心断言。
check('切回无之后画面里的嘴瘪回去了', (await clickSlot('mouth', null)) === 'OK')
check('第一轮：切回无之后 chuipaopao/chuipaopao2 的画面值都是 0',
  (await until(async () => (await drawn('chuipaopao')) === 0 && (await drawn('chuipaopao2')) === 0)),
  'drawn=' + (await drawn('chuipaopao')) + '/' + (await drawn('chuipaopao2')))

// (4) 帧外基线仍然停在 1——这不是 bug，是引擎帧尾 loadParameters() 的结果。
//     它必须留着，否则上面那条断言可能只是"恰好读到了同一个数组"。
const rawAfter = await raw('chuipaopao')
check('GAP：帧外基线仍是 1（引擎帧尾 loadParameters 的姿势），所以断言只能读 drawn()',
  rawAfter === 1, 'raw=' + rawAfter + ' drawn=' + (await drawn('chuipaopao')))

// (5) 第二轮。上一版就死在这里：还原表被"帧外基线"污染成 1，
//     于是"还原"忠实地还原成一个鼓着的嘴。跑三轮，因为这类污染往往是
//     从第二轮才开始，只在单轮里测永远看不出来。
for (const round of [2, 3]) {
  await clickSlot('mouth', '吹泡泡糖')
  const inflated = await until(async () => (await drawn('chuipaopao')) === 1)
  const dbg = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.releaseDebug())'))
  check('第 ' + round + ' 轮：还能把嘴吹起来', inflated === true,
    'drawn=' + (await drawn('chuipaopao')) + ' 还原表=' + JSON.stringify(dbg.releaseSample))
  // 新动作的快照必须是"画面里的"值(0)，不是帧外基线(1)。
  check('第 ' + round + ' 轮：快照记的是画面里的嘴（0），不是帧外基线（1）',
    dbg.heldSample === 0, 'heldSample=' + dbg.heldSample)
  await clickSlot('mouth', null)
  check('第 ' + round + ' 轮：切回无之后嘴还是瘪的',
    (await until(async () => (await drawn('chuipaopao')) === 0 && (await drawn('chuipaopao2')) === 0)),
    'drawn=' + (await drawn('chuipaopao')) + '/' + (await drawn('chuipaopao2')))
}

// (6) 同样的机制管着右手的手机：掏出手机 -> 无 必须把手放下来。
//     phone 由待机循环驱动，所以帧外基线会自己回 0；这里断言的仍然是画面值。
await clickSlot('rhand', '掏出手机')
const phoneUp = await until(async () => ((await drawn('phone')) ?? 0) > 0.5)
check('掏出手机能把手机举起来', phoneUp === true, 'drawn=' + (await drawn('phone')))
check('切回无之后右手放下手机', (await clickSlot('rhand', null)) === 'OK')
const phoneDown = await until(async () => ((await drawn('phone')) ?? 1) <= 0.05)
check('画面里的手机回到 0', phoneDown === true, 'drawn=' + (await drawn('phone')))

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
