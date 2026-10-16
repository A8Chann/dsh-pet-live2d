// Issue #3 回归：**打开右键面板不该让面板和宠物每秒重画**。
//
// 症状（用户 2026-10 报的）：页面内宠物平时正常，一打开右键面板，「面板本体和宠物一起
// 持续闪烁」。设置页那一节正常。
//
// 根因不在面板：`layerStore` 的去重拿 `===` 比了 `binary` / `download` —— 而它们是
// **每次轮询新解出来的 JSON 对象**，引用永远不相等。于是去重等于没有去重，
// 每秒通知一次订阅者，三个界面（宠物本体 / 右键面板的 LayerControls / 设置页与「插件」页
// 那一节）**每秒全部重渲染**。面板关着时也在抖，只是画面里没有面板，看不出来；
// 打开面板之后（那是一块带 `backdrop-filter` 的大表面）就非常显眼。
//
// 判据是**真实的重渲染次数**（注入计数器），不是 DOM 变更次数 —— React 对没变的内容
// 不写 DOM，我第一版数 DOM 变更得到 0，差点把这条判成"没问题"。
//
//   node cdp-rendercount.mjs
import { spawn, execFileSync } from 'node:child_process'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, HERE, PLUGIN } from './paths.mjs'
import { waitReady, openPanel, pageErrors } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

const EDGE = browserPath()
const CDP_PORT = 9412
const SRV_PORT = 8845
const PROFILE = join(PROFILES, '_cdp-rendercount')
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

// 注入版客户端：在几个组件的函数体开头 + store 通知处埋计数器。改的是**内存里的源码
// 文本**，不碰仓库文件（和服务器那个 DBG variant 同一套思路）。
const VARIANTS = join(HERE, 'variants')
mkdirSync(VARIANTS, { recursive: true })
const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')

const COUNTER = '  if (typeof window !== "undefined" && window.__rc) window.__rc._BUMP_ += 1;\n'
const anchors = [
  ['  function Pet() {\n', 'Pet'],
  ['  function LayerControls() {\n', 'layer'],
  ['  function PetPluginConfig() {\n', 'pluginPage'],
]
let patched = source
for (const [anchor, key] of anchors) {
  if (!patched.includes(anchor)) {
    console.log('RENDERCOUNT FAIL —— 注入锚点没找到：' + key + '（client.js 结构变了？）')
    process.exit(1)
  }
  patched = patched.replace(anchor, anchor + COUNTER.replace('_BUMP_', key))
}
const notifyAnchor = '    layerStore.value = merged;\n'
if (!patched.includes(notifyAnchor)) {
  console.log('RENDERCOUNT FAIL —— store 通知锚点没找到（client.js 结构变了？）')
  process.exit(1)
}
patched = patched.replace(notifyAnchor, notifyAnchor + COUNTER.replace('_BUMP_', 'storeNotify'))
// 计数器本体：必须在插件模块求值之前就存在，所以喂给页面时前置一段初始化。
const INIT = 'window.__rc = { Pet: 0, layer: 0, pluginPage: 0, storeNotify: 0 };\n'
patched = INIT + patched
writeFileSync(join(VARIANTS, 'client-RENDERCOUNT.js'), patched)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === '' ? '' : '  ← ' + detail))
  if (!ok) failures.push(label)
}

const server = spawn(process.execPath, [join(HERE, 'server.mjs'), String(SRV_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))
let up = false
for (let i = 0; i < 200 && !up; i += 1) {
  try { up = (await fetch('http://127.0.0.1:' + SRV_PORT + '/api/live2d-pet/catalog')).ok } catch { /* retry */ }
  if (!up) await sleep(100)
}
if (!up) { console.log('harness 服务器没起来'); server.kill(); process.exit(1) }

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const cleanup = () => {
  try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  try { server.kill() } catch { /* gone */ }
}

let page
for (let i = 0; i < 120 && page === undefined; i += 1) {
  try { page = (await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()).find((t) => t.type === 'page') } catch { /* retry */ }
  if (page === undefined) await sleep(250)
}
if (page === undefined) { console.log('拿不到 CDP 页面'); cleanup(); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/?variant=RENDERCOUNT' })
await waitForBoot(ev)
if (await waitReady(ev) !== true) { console.log('宠物没就绪'); ws.close(); cleanup(); process.exit(1) }
console.log('宠物已就绪（注入版：数真实重渲染）\n')

const sample = async (label, ms) => {
  await ev('window.__rc.Pet = 0; window.__rc.layer = 0; window.__rc.pluginPage = 0; window.__rc.storeNotify = 0')
  // 顺带盯住共享设置的 rev：issue #3 的第三条线索是"写→广播→再写"的死循环。
  // rev 在采样窗口里每涨一次，就说明有人在反复写 —— 那会让**所有**订阅者重渲染。
  const revBefore = await ev('fetch("/api/live2d-pet/settings", { cache: "no-store" }).then((r) => r.json()).then((p) => p.rev)')
  await sleep(ms)
  const revAfter = await ev('fetch("/api/live2d-pet/settings", { cache: "no-store" }).then((r) => r.json()).then((p) => p.rev)')
  const parsed = JSON.parse(await ev('JSON.stringify(window.__rc)'))
  parsed.revBefore = revBefore
  parsed.revAfter = revAfter
  console.log('[' + label + '] ' + (ms / 1000) + ' 秒：' + JSON.stringify(parsed))
  return parsed
}

console.log('=== 阶段一：面板关着 ===')
const before = await sample('面板关闭', 4000)
console.log('=== 打开右键面板 ===')
check(await openPanel(ev) === true, '右键面板打开了')
await sleep(600)
console.log('=== 阶段二：面板开着 ===')
const after = await sample('面板打开', 5000)

const perSec = (value, ms) => value / (ms / 1000)
console.log('')
console.log('每秒 store 通知：关着 ' + perSec(before.storeNotify, 4000).toFixed(2) + ' → 开着 ' + perSec(after.storeNotify, 5000).toFixed(2))
console.log('每秒 Pet 重渲染：关着 ' + perSec(before.Pet, 4000).toFixed(2) + ' → 开着 ' + perSec(after.Pet, 5000).toFixed(2))
// 说明：这里**不**断言 `layer`（LayerControls）的次数 —— 它在网页端只有当面板切到「设置」
// 页签时才渲染，不切就恒为 0，那种断言是空洞的。它订阅的是同一个 store，
// 所以上面那条 store 通知的断言已经覆盖了它。

// 阈值 0.5 次/秒：`/layer` 每秒轮询一次，但**内容没变就不该通知**。
// 修之前这里是 1.00（每秒一次，稳定复现）。
check(perSec(after.storeNotify, 5000) < 0.5, '显示层状态没变就不通知订阅者', perSec(after.storeNotify, 5000).toFixed(2) + ' 次/秒')
check(perSec(after.Pet, 5000) < 0.5, '面板开着时宠物不再每秒重渲染', perSec(after.Pet, 5000).toFixed(2) + ' 次/秒')
// 共享设置的 rev 也必须纹丝不动 —— 它每涨一次，两个界面的**每一行**都要重渲染。
// （issue #3 的第三条线索就是这个"写→广播→再写"的循环；实测没有，把它钉住防回归。）
check(after.revAfter === after.revBefore, '共享设置的 rev 不自己涨（没有写→广播→再写的循环）',
  'rev ' + after.revBefore + ' → ' + after.revAfter)

const errors = await pageErrors(ev)
check(errors.length === 0, '页面没有未捕获异常', JSON.stringify(errors).slice(0, 200))

ws.close()
cleanup()
console.log('')
if (failures.length > 0) { console.log('RENDERCOUNT FAIL —— ' + JSON.stringify(failures)); process.exit(1) }
console.log('RENDERCOUNT OK —— 面板开着时没有每秒重渲染（issue #3）')
