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
import { waitReady, openPanel, panelFooter } from './ready.mjs'
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

/**
 * 采样若干参数在一小段时间里的变化幅度。
 *
 * "待机还在驱动身体"这件事必须**跟动作发生之前比**：ParamAngleZ 这类参数
 * 在待机里本来就可能一动不动，光看绝对跨度会把"这个参数不呼吸"误判成
 * "被还原钉死了"。
 */
const spreadOf = async (ids, n = 12) => {
  const series = ids.map(() => [])
  for (let i = 0; i < n; i += 1) {
    await sleep(120)
    for (let k = 0; k < ids.length; k += 1) series[k].push((await drawn(ids[k])) ?? 0)
  }
  return series.map((s) => Math.max(...s) - Math.min(...s))
}
// 先问模型自己：待机此刻真的在动哪几个参数？
// 不能写死 ParamAngleX/Y/Z —— 实测这只模型的待机在 1.4 秒里根本不碰它们，
// 拿它们当探针只会得到 0.000->0.000 的假红。帧外基线在这里正好合用：
// 待机自己的输出没有被任何图层覆盖，基线里看到的就是它在动。
const rawAll = async () => JSON.parse(await ev('JSON.stringify((() => {'
  + ' const p = window.__PET_DBG.core._model.parameters;'
  + ' return { ids: Array.from(p.ids), values: Array.from(p.values) } })())'))
/** 帧外基线里此刻动得最凶的几个参数（[名字, 跨度]），用来判断"引擎还在不在驱动身体"。 */
const movers = async (top = 3) => {
  const a = await rawAll()
  await sleep(900)
  const b = await rawAll()
  return a.ids
    .map((id, i) => [id, Math.abs((b.values[i] ?? 0) - (a.values[i] ?? 0))])
    .sort((x, y) => y[1] - x[1])
    .slice(0, top)
}
const idleWatch = (await movers()).map((pair) => pair[0])
const idleBefore = await spreadOf(idleWatch)
console.log('  待机在动的参数 ' + idleWatch.map((id, i) => id + '=' + idleBefore[i].toFixed(3)).join(' '))

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
// 而且必须**留在** 0。交叉淡出期间旧动作还在写 phone，还原如果因为
// "这个值在变，所以交还给你" 而放手，手机就会被淡出的动作慢慢带回去。
const phoneTail = []
for (let i = 0; i < 20; i += 1) { await sleep(150); phoneTail.push((await drawn('phone')) ?? 0) }
check('放下手机之后 phone 稳定在 0，没有被淡出的动作带回去',
  Math.max(...phoneTail.slice(5)) < 0.05, phoneTail.map((v) => v.toFixed(2)).join(' '))

// (7) 挤番茄酱：动作状态的第三个样本，也是结构上最"混"的一个——
//     它既带动作（Ketchup 写了 danbaofan / ji / keyboard / point…），
//     又带表情（挤番茄酱.exp3.json），还要先选中左手的蛋包饭当前提。
//     它的参数里有 8 个是待机循环也在驱动的（ParamAngle*/Mouth*/Eye*），
//     所以"还原"必须在待机接回身体时把那些参数**交还**出去，
//     同时又不能把仍然选中的蛋包饭表情一起抹掉。
await clickSlot('lhand', '蛋包饭')
await sleep(900)
const riceBefore = await drawn('danbaofan')
check('先选中左手的蛋包饭（挤番茄酱的前提）', (riceBefore ?? 0) > 0.5, 'drawn(danbaofan)=' + riceBefore)
check('有蛋包饭时才让播挤番茄酱', (await ev('window.__dshLive2dPet.canPlay("Ketchup")')) === true)
check('右手能选上挤番茄酱', (await clickSlot('rhand', '挤番茄酱')) === 'OK')
const ketchupUp = await until(async () => ((await drawn('ji')) ?? 0) > 0.5)
check('画面里挤出番茄酱了', ketchupUp === true, 'drawn(ji)=' + (await drawn('ji')))
check('切回无之后番茄酱收回去', (await clickSlot('rhand', null)) === 'OK')
const ketchupGone = await until(async () => ((await drawn('ji')) ?? 1) < 0.05)
check('画面里的番茄酱回到 0', ketchupGone === true,
  'drawn(ji)=' + (await drawn('ji')) + ' drawn(danbaofan)=' + (await drawn('danbaofan')))
// 蛋包饭是左手的**表情**选择，不是这个动作的一部分：收掉番茄酱不能把它一起收掉。
check('收掉番茄酱没有波及仍然选中的蛋包饭', ((await drawn('danbaofan')) ?? 0) > 0.5,
  'drawn(danbaofan)=' + (await drawn('danbaofan')))
// 待机应该把身体接回去：被 Ketchup 写过的头部参数必须重新呼吸，而不是被钉死。
// 对照动作发生之前的同一组跨度——绝对跨度小不代表被钉死（有些参数待机本来就不动）。
// 直接盯着"动作写过的、同时待机也在驱动的"参数：ParamAngleX/Y 既在 Ketchup 的
// 曲线里，也在待机的 89 个参数里。还原表如果在待机接回身体之后还留着它们，它们
// 就会被钉死不动 —— 这一条就是"把身体交还出去"的直接证据。
//
// 不拿"最活跃的 N 个参数"做前后对比：刚加载完模型还在做入场/物理的大幅摆动
// （实测有 291 的跨度），等到稳定下来那些参数本来就停在 0，前后根本不是同一件事。
const idleAfter = await spreadOf(idleWatch)
const detail = idleWatch.map((id, i) => id + ' ' + idleBefore[i].toFixed(3) + '->' + idleAfter[i].toFixed(3)).join('  ')
const handed = await spreadOf(['ParamAngleX', 'ParamAngleY'])
check('还原之后动作写过的头部参数被待机接回去（不再被钉死）',
  handed.every((v) => v > 0.0005), 'ParamAngleX/Y 跨度=' + handed.map((v) => v.toFixed(4)).join('/'))
console.log('  动作之后：data-motion=' + await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
  + ' 引擎在飞的动作数=' + await ev('window.__dshLive2dPet.blending()')
  + ' 还原表=' + JSON.stringify(JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.releaseDebug())')).release))
console.log('  动作之后还在动的参数 ' + (await movers(5)).map((p) => p[0] + '=' + p[1].toFixed(3)).join(' '))
// 上方 idleBefore/idleAfter 只作参考打印：加载完模型还在做入场/物理的大幅摆动，
// 拿那一刻"最活跃的参数"当探针，和稳定之后根本不是同一件事（实测 291 -> 0）。
// 真正的判据是上面那条 ParamAngleX/Y。

// (8) **同时**选两个动作 —— 用户报的那一条。
//     一次只有一个动作在播（desired 只认第一个带 motion 的槽位），但两个槽位都
//     还选着，两个动作都"停在那里"各自钉着一批参数。收掉第二个时如果还原表被
//     整张替换，第一个的还原就没了 —— 泡泡会挂回脸上。
await clickSlot('mouth', '吹泡泡糖')
check('两个一起测：先吹起泡泡', (await until(async () => (await drawn('chuipaopao')) === 1)) === true,
  'drawn=' + (await drawn('chuipaopao')))
await clickSlot('rhand', '掏出手机')
const phoneTogether = await until(async () => ((await drawn('phone')) ?? 0) > 0.5)
// 两个槽位各选一个动作时，**两个姿势同时存在**（身体只播一个，但姿势不冲突：
// phone* 和 chuipaopao* 两组参数不相交）。这条原先是"泡泡被还原按住 = 0"，那是
// "拍手机就把泡泡顶掉"的旧行为 —— 用户报过"掏出手机跟吹泡泡糖又冲突起来了"。
check('再掏出手机 → 手机在手里，泡泡也还在（两个姿势共存）',
  phoneTogether === true && (await drawn('chuipaopao')) === 1,
  'phone=' + (await drawn('phone')) + ' chuipaopao=' + (await drawn('chuipaopao')))
await clickSlot('rhand', null)
await sleep(1200)
check('收掉手机：嘴部槽位还选着吹泡泡糖，泡泡该回来',
  (await until(async () => (await drawn('chuipaopao')) === 1)) === true,
  'drawn=' + (await drawn('chuipaopao')) + ' phone=' + (await drawn('phone')))
await clickSlot('mouth', null)
check('再把嘴部切回无：两个动作都收得回去（还原表不能被整张替换）',
  (await until(async () => (await drawn('chuipaopao')) === 0 && ((await drawn('phone')) ?? 1) <= 0.05)) === true,
  'chuipaopao=' + (await drawn('chuipaopao')) + ' phone=' + (await drawn('phone')))

// (9) 用户报的路径：掏出手机 -> 切到**爱心眼**（带 pairs 配对的表情）。
await clickSlot('rhand', '掏出手机')
check('掏出手机举起来', (await until(async () => ((await drawn('phone')) ?? 0) > 0.5)) === true,
  'phone=' + (await drawn('phone')))
await clickSlot('eyes', '爱心眼')
await sleep(1500)
console.log('  切爱心眼后：phone=' + (await drawn('phone')) + ' 爱心眼=' + (await drawn('ParamEyeLOpen'))
  + ' data-motion=' + await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
  + ' blending=' + await ev('window.__dshLive2dPet.blending()')
  + ' 还原表=' + JSON.stringify(JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.releaseDebug())'))))
await clickSlot('rhand', null)
const phoneAfterLove = await until(async () => ((await drawn('phone')) ?? 1) <= 0.05)
check('切回无之后手机放下（爱心眼不该挡住这一步）', phoneAfterLove === true,
  'phone=' + (await drawn('phone')))

// (10) 挤番茄酱会把嘴撑开；收回去之后嘴必须**闭上**（动作停在最后一帧，
//      只有还原表能把它带回来）。
const mouthRest = await drawn('ParamMouthOpenY')
await clickSlot('lhand', '蛋包饭')
await sleep(600)
await clickSlot('rhand', '挤番茄酱')
await until(async () => ((await drawn('ji')) ?? 0) > 0.5, 20, 200)
const mouthOpen = await drawn('ParamMouthOpenY')
await clickSlot('rhand', null)
await until(async () => ((await drawn('ji')) ?? 1) < 0.05)
const mouthClosed = await drawn('ParamMouthOpenY')
check('挤番茄酱收回之后嘴闭上（动作写过的 ParamMouthOpenY 必须被还原）',
  (mouthClosed ?? 0) < 0.3 && (mouthOpen ?? 0) > (mouthClosed ?? 0) + 0.1,
  '起始 ' + mouthRest + ' 挤的时候 ' + mouthOpen + ' 收回后 ' + mouthClosed)

// ⚠️ 上面那段（11）重载了页面 —— 面板是关着的，后面要用面板必须先重新打开，
// 而且要**等到它真的挂上**：重载后第一次 contextmenu 可能落在一个还没准备好代理层的
// DOM 上，点完什么都没发生（这次就是 click=NOSLOT 才发现的）。
for (let i = 0; i < 20; i += 1) {
  if ((await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-panel]")')) === true) break
  await openPanel(ev)
  await sleep(300)
}

// (12) 自拍的前置动作就是掏出手机。手机已经在手里时再播自拍，
//      前置链会**重播**掏出手机并重新快照 —— 而这时 phone 正被动作举着（=1），
//      于是"动作前的状态"被记成 1，从此手机再也放不下来。
const clickedPhone = await clickSlot('rhand', '掏出手机')
const slotsAfterClick = await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())')
check('自拍前先掏出手机', (await until(async () => ((await drawn('phone')) ?? 0) > 0.5)) === true,
  'click=' + clickedPhone + ' slots=' + slotsAfterClick + ' phone=' + (await drawn('phone'))
  + ' canPlay=' + (await ev('window.__dshLive2dPet.canPlay("OpenCase")')))
await ev('window.__dshLive2dPet.playOnce("Selfie", 0, { kind: "probe" })')
await sleep(3000)
check('播过自拍之后手机还能放下', (await clickSlot('rhand', null)) === 'OK')
check('画面里的手机回到 0（快照没被"举着的值"污染）',
  (await until(async () => ((await drawn('phone')) ?? 1) <= 0.05)) === true,
  'phone=' + (await drawn('phone')))

// (11) 装扮要"存档"：会话相位不动它、归位不清它、重载页面还在。
await clickSlot('glasses', '墨镜')
await clickSlot('cloth', '黑色')
await sleep(900)
check('先把装扮穿上（墨镜 = ParamCheek71）', (await drawn('ParamCheek71')) === 1,
  'Cheek71=' + (await drawn('ParamCheek71')))
await panelFooter(ev, '归位')
await sleep(900)
check('归位之后装扮还在（归位不清装扮）', (await drawn('ParamCheek71')) === 1,
  'Cheek71=' + (await drawn('ParamCheek71')))
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i += 1) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)
await sleep(800)
const kept = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.slotSelections())'))
check('重载之后装扮选择从存档恢复', kept.glasses === '墨镜' && kept.cloth === '黑色', JSON.stringify(kept))
check('重载之后装扮真的画出来了', (await drawn('ParamCheek71')) === 1, 'Cheek71=' + (await drawn('ParamCheek71')))
const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
