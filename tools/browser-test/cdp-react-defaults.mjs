// 互动反应候选的**内置默认值**：宠物没声明那三组也得演得出来。
//
// 契约：`interactionReactions()` 的兜底顺序是 **用户覆盖 <- 宠物声明 <- 内置默认**。
// 三层里的后两层以前是空的 —— 代码侧一个默认值都没有（`HEAD_PAT_REACTIONS` 是死常量），
// 于是"最小 pet.json"（没有 patReactions / tailReactions / spinReactions 的那份）上：
//
//   摸头 → 只有台词，**不演重锤出击**；摸尾巴 → 只有台词；转圈 → 连台词都不弹。
//
// 这个 driver 就是那条路径：起一个**临时的 DSH_HOME**，把宠物复制进去、从 pet.json 里
// 删掉那三个键，然后断"有效候选 = 内置默认"（而不是空数组）。
//
// 为什么必须换一个 DSH_HOME：仓库里那只宠物三组都声明了（走的是 pet 那一层），
// 在它身上测永远测不到 builtin 这一层 —— 这正是这个 bug 能活到现在的原因。
//
//   node run-suite.mjs react-defaults        # 由 suite 拉起（有自己的 server）
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, HERE, PLUGIN } from './paths.mjs'
import { waitReady, openPanel, pageErrors, killBrowser } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

/** 用户那份 Cubism Core（插件不内置它，本机没有就只能退回官方 CDN）。 */
const CORE_SRC = join(process.env.USERPROFILE ?? '', '.dsh', 'pets', '.runtime')

const EDGE = browserPath()
const PET_ID = 'ds-whale-girl'
const PORT = 9399
const SERVER_PORT = 8899
const PROFILE = join(PROFILES, '_cdp-react-defaults')
const HOME = join(PROFILES, '_react-defaults-home')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 一份"没声明反应候选"的 DSH_HOME --------------------------------------
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'pets'), { recursive: true })
// 宠物本体：复制而不是 junction。junction 会让 realpath 落到仓库里，
// 资产路由的包含性检查（contained()）绕一圈才成立，测的东西就不止这一条了。
cpSync(join(PLUGIN, 'pets', PET_ID), join(HOME, 'pets', PET_ID), { recursive: true })
// Core 运行时照搬用户那份（插件不内置它；没有它模型起不来，waitReady 会假红）。
// 本机没有就跳过 —— 插件会去 Live2D 官方 CDN 兜底，这一条不该让 driver 挂。
if (existsSync(CORE_SRC)) cpSync(CORE_SRC, join(HOME, 'pets', '.runtime'), { recursive: true })
else console.log('  note: 本机没有 ' + CORE_SRC + '，这条 Core 走 CDN 兜底')
const manifestPath = join(HOME, 'pets', PET_ID, 'pet.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const DECLARED = ['patReactions', 'tailReactions', 'spinReactions']
const dropped = []
for (const key of DECLARED) {
  if (manifest.live2d?.[key] !== undefined) { delete manifest.live2d[key]; dropped.push(key) }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
// 前提自检：这份 pet.json 真的没有那三个键了。否则下面测的还是 pet 那一层 ——
// 一个"看着在测兜底、其实在测声明"的空洞 driver 比没有更糟。
const reread = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (DECLARED.some((key) => reread.live2d?.[key] !== undefined)) {
  console.error('FAIL  夹具没做对：pet.json 里还留着 ' + DECLARED.join('/'))
  process.exit(1)
}

// ---- server + headless Edge -------------------------------------------------
process.env.DSH_HOME = HOME
const server = spawn(process.execPath, [join(HERE, 'server.mjs'), String(SERVER_PORT)], { stdio: 'ignore', cwd: HERE })
const BASE = 'http://127.0.0.1:' + SERVER_PORT
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })

/** 收摊：任何一条退出路径（含抛异常）都要走到，否则残留进程会占住端口到下一次运行。 */
let ws = null
const killAll = () => {
  try { ws?.close() } catch { /* already gone */ }
  try { killBrowser(edge) } catch { /* already gone */ }
  try { server.kill() } catch { /* already gone */ }
}
try {

let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
if (page === undefined) throw new Error('headless browser never came up on port ' + PORT)
ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const json = async (expr) => {
  const raw = await ev(expr)
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
/**
 * 比的是**集合**，不是顺序：chips 按 catalog 里声明的顺序渲染，而候选的
 * 抽取本来就是随机的（`pick()`），顺序没有语义 —— 按数组比会为一件不重要的事假红。
 */
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.slice().sort().join('\u0000') === b.slice().sort().join('\u0000')

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
await waitForBoot(ev)
check('页面真的加载出来了（夹具 DSH_HOME 有服务）', (await ev('!!window.__dshLive2dPet')) === true, 'DSH_HOME=' + HOME)
check('这只宠物的 pet.json 里确实没有那三个键（下面断的才是 builtin 那一层）', dropped.length === 3, '删掉: ' + JSON.stringify(dropped))
check('模型与点击遮罩就绪', (await waitReady(ev)) === true)

const diag = await json('JSON.stringify(window.__dshLive2dPet.reactionDiagnostics())')
check('三组候选的来历都是 builtin（不是 none、也不是 pet）',
  diag !== null && DECLARED.every((key) => diag.source?.[key] === 'builtin'),
  JSON.stringify(diag?.source))
check('内置默认值读得到，和代码里的那份一致',
  sameSet(diag?.builtin?.patReactions, ['重锤出击', '问号', '星星眼'])
  && sameSet(diag?.builtin?.tailReactions, ['吐魂', '问号'])
  && sameSet(diag?.builtin?.spinReactions, ['晕晕']),
  JSON.stringify(diag?.builtin))
// 这条是这个 bug 的正面断言：有效候选**不为空**。修之前三组全是 `[]`。
check('有效候选 = 内置默认，而不是空数组（修之前这里全是 []）',
  DECLARED.every((key) => (diag?.effective?.[key] ?? []).length > 0)
  && sameSet(diag?.effective?.patReactions, ['重锤出击', '问号', '星星眼'])
  && sameSet(diag?.effective?.tailReactions, ['吐魂', '问号'])
  && sameSet(diag?.effective?.spinReactions, ['晕晕']),
  JSON.stringify(diag?.effective))

// 设置界面显示的也必须是这一组：界面上没勾的选项运行时根本不会演。
await openPanel(ev)
const probe = await ev('(() => {'
  + ' const slot = (window.__pluginSections ?? {})["pet-settings"];'
  + ' if (!slot) return "NO_SLOT";'
  + ' const host = document.createElement("div"); host.id = "dsh-settings-probe"; document.body.appendChild(host);'
  + ' window.ReactDOM.createRoot(host).render(slot.render());'
  + ' return "OK" })()')
check('设置正文能挂出来', probe === 'OK', String(probe))
await sleep(900)
const chips = await json(`JSON.stringify({
  pat: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="patReactions"] [data-on]').length,
  tail: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="tailReactions"] [data-on]').length,
  spin: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="spinReactions"] [data-on]').length,
  builtinMarked: Array.from(document.querySelectorAll('#dsh-settings-probe [data-reaction-builtin]'))
    .map((n) => n.getAttribute('data-reaction-set')),
  labels: Array.from(document.querySelectorAll('#dsh-settings-probe [data-reaction-set="patReactions"] [data-on]'))
    .map((n) => n.textContent),
})`)
check('三组 chips 各有一组默认勾选（界面显示 = 运行时会演的）',
  (chips?.pat ?? 0) === 3 && (chips?.tail ?? 0) === 2 && (chips?.spin ?? 0) === 1, JSON.stringify(chips))
check('摸头那组勾的正是内置三个', sameSet(chips?.labels, ['重锤出击', '问号', '星星眼']), JSON.stringify(chips?.labels))
check('三组都标了「内置默认」（宠物没声明的来源要说清楚）',
  JSON.stringify(chips?.builtinMarked) === JSON.stringify(DECLARED), JSON.stringify(chips?.builtinMarked))

// 勾选仍然可写：builtin 只是**兜底值**，不是"改不动"。
// （PHASE_OVERRIDES 少 interactions 这个键时，这条路径会静默写丢。）
const toggled = await ev('(() => {'
  + ' const b = document.querySelector(\'#dsh-settings-probe [data-reaction-chip="patReactions:重锤出击"]\');'
  + ' if (!b) return "NO_CHIP"; b.click(); return "OK" })()')
await sleep(500)
const after = await json('JSON.stringify(window.__dshLive2dPet.reactionDiagnostics())')
check('取消一个候选之后真的有覆盖落盘（来源从 builtin 变 user）',
  toggled === 'OK' && after?.source?.patReactions === 'user'
  && sameSet(after?.effective?.patReactions, ['问号', '星星眼']),
  'toggle=' + String(toggled) + ' ' + JSON.stringify(after?.effective?.patReactions) + ' source=' + JSON.stringify(after?.source))
check('覆盖进了同一份设置存档',
  String(await ev('JSON.stringify(window.__dshLive2dPet.settingsOverrides().interactions)')).includes('patReactions'),
  await ev('JSON.stringify(window.__dshLive2dPet.settingsOverrides().interactions)'))
const restored = await ev('(() => {'
  + ' const b = document.querySelector(\'#dsh-settings-probe [data-reaction-chip="patReactions:重锤出击"]\');'
  + ' if (!b) return "NO_CHIP"; b.click(); return "OK" })()')
await sleep(500)
check('勾回来又回到 user 覆盖（覆盖是显式的，不会因为"等于默认"被抹掉）',
  restored === 'OK' && (await ev('window.__dshLive2dPet.effectiveReactions("patReactions").length')) === 3,
  'pat=' + await ev('JSON.stringify(window.__dshLive2dPet.effectiveReactions("patReactions"))'))

const errors = await pageErrors(ev)
check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 240))

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
killAll()
await sleep(300)
rmSync(HOME, { recursive: true, force: true })
process.exit(bad.length === 0 ? 0 : 1)

} catch (error) {
  console.error('FAIL  driver crashed: ' + (error?.stack ?? error))
  killAll()
  process.exit(1)
}
