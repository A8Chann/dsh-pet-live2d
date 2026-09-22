// 看一眼「会话相位 / 摸鱼」两张条目表在 DSH 设置页里长什么样。
//
// 一次性诊断脚本（不在套件内）：起一个测试服，把设置页那一节挂到页面里，加一个相位
// 再改两条，然后截图。改 CSS 或表格结构之后跑它，比读断言快。
//
//   node drivers/probe-settings.mjs
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, HERE, SHOTS, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9387
const SERVER_PORT = 8891
const PROFILE = join(PROFILES, '_probe-settings')
const server = spawn(process.execPath, [join(HERE, 'server.mjs'), String(SERVER_PORT)], { stdio: 'ignore', cwd: HERE })
process.env.PET_BASE = 'http://127.0.0.1:' + SERVER_PORT
const BASE_URL = process.env.PET_BASE
rmSync(PROFILE, { recursive: true, force: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1500,1100', 'about:blank'], { stdio: 'ignore' })
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 500))
  }
}
const send = (a, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE_URL + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
// 必须等挡脸的剪影**就绪**：轮廓没好之前 [data-hit] 是没有 onContextMenu 的
// （那一层还不接受点击），对着它派发事件什么都不会发生 —— 面板看起来"打不开"。
await waitReady(ev)
await sleep(1500)

// 把那一节挂进页面（和 cdp-gaze 里那段探针一样）。
await ev(`(() => {
  const slot = (window.__pluginSections ?? {})["pet-settings"];
  if (!slot) return "NO_SLOT";
  const host = document.createElement("div");
  host.id = "dsh-settings-probe";
  host.style.cssText = "position:fixed;left:0;top:0;width:760px;max-height:1080px;overflow:auto;background:#fff;color:#111;padding:10px;z-index:9";
  document.body.appendChild(host);
  window.ReactDOM.createRoot(host).render(slot.render());
  return slot.meta.label();
})()`)
await sleep(900)

// 滑杆的几种"量法"对照：getComputedStyle 对伪元素到底返回什么。
// 一次跑清楚，免得在断言里瞎猜（上一版断言读到的是 input 本身的高度/宽度）。
console.log('slider:', await ev('(() => {'
  + ' const el = document.querySelector("#dsh-settings-probe [data-input=\'gazeDeadzone\']");'
  + ' if (!el) return "no-el";'
  + ' const own = getComputedStyle(el);'
  + ' const t1 = getComputedStyle(el, "::-webkit-slider-runnable-track");'
  + ' const h1 = getComputedStyle(el, "::-webkit-slider-thumb");'
  + ' const t2 = getComputedStyle(el, "-webkit-slider-runnable-track");'
  + ' return JSON.stringify({'
  + ' own: { w: own.width, h: own.height, app: own.webkitAppearance ?? own.appearance },'
  + ' pseudoDoubleDash: { track: t1.height, trackBg: t1.backgroundColor, thumb: h1.width + "x" + h1.height },'
  + ' pseudoSingleDash: { track: t2.height },'
  + ' fill: el.style.getPropertyValue("--fill"),'
  + ' matched: el.matches("#dsh-settings-probe input[type=range]")'
  + ' }); })()'))

const click = (selector) => ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false;'
  + ' el.click(); return true })()')

// 加两个相位，并往其中一个池子里塞几条不同的东西，把关系药丸也带出来。
await click('#dsh-settings-probe [data-phase-add="tool"]')
await sleep(400)
await click('#dsh-settings-probe [data-phase-add="waiting"]')
await sleep(400)
await click('#dsh-settings-probe [data-phase-pool-add="tool:rhand"][data-add-option="掏出手机"]')
await sleep(400)
await click('#dsh-settings-probe [data-phase-pool-add="tool:rhand"][data-add-option="挤番茄酱"]')
await sleep(400)
await click('#dsh-settings-probe [data-phase-pool-add="tool:rhand"][data-add-option="喵喵手"]')
await sleep(600)
const shot = async (name, clip) => {
  const s = await send('Page.captureScreenshot', clip === undefined ? { format: 'png' } : { format: 'png', clip })
  writeFileSync(join(SHOTS, name), Buffer.from(s.result.data, 'base64'))
}
// 第零张：先看「手感」那排滑杆（细轨道 + 小圆钮 + 填充）。
await shot('_settings-tuning.png')
// 折叠掉前半部分，让这两张表在截图里占主要位置。
const hide = (sel, on) => ev('(() => { document.querySelectorAll(' + JSON.stringify(sel) + ').forEach((el) => { el.style.display = '
  + JSON.stringify(on ? "none" : "") + ' }); return true })()')
await hide('#dsh-settings-probe [data-card="tune-feel"], #dsh-settings-probe [data-card="tune-fidget"], #dsh-settings-probe [data-setting="fidget"]', true)
await sleep(400)
await shot('_settings-pools.png')
// 第二张：整个设置区（这一节才是"默认就该看到"的样子）。
// 先把刚才 hide 掉的**内层**元素也恢复回来 —— 只恢复卡片是不够的，
// 那张池子卡会显示成一张空壳。
await ev('(() => { document.querySelectorAll("#dsh-settings-probe [data-card], #dsh-settings-probe [data-setting]")'
  + '.forEach((el) => { el.style.display = "" }); return true })()')
await sleep(500)
await shot('_settings-full.png')
// 第三张：摸鱼那一节（含"可加的槽位"那一排）—— 单独加一个槽位再看，
// 这样才能同时看到「加进来的槽位」和它右上角那个"整个拿掉"的 ×。
await click('#dsh-settings-probe [data-fidget-slot-add="symbol"]')
await sleep(400)
await click('#dsh-settings-probe [data-fidget-add="symbol"][data-add-option="感叹号"]')
await sleep(400)
await hide('#dsh-settings-probe [data-card="phases"], #dsh-settings-probe [data-card="tune-feel"], #dsh-settings-probe [data-card="tune-fidget"]', true)
await sleep(400)
await shot('_settings-fidget.png')
await ev('(() => { document.querySelectorAll("#dsh-settings-probe [data-card], #dsh-settings-probe [data-setting]")'
  + '.forEach((el) => { el.style.display = "" }); return true })()')
await sleep(300)
// 第四张：右键面板里那一份（深色、更窄）—— 同一个正文，不能只在设置页好看。
console.log('pet root:', await ev('!!document.querySelector("[data-dsh-live2d-pet]")'))
console.log('stage:', await ev('JSON.stringify((() => { const s = document.querySelector("[data-dsh-live2d-pet] [data-stage]");'
  + ' if (!s) return null; const hit = document.querySelector("[data-dsh-live2d-pet] [data-hit]");'
  + ' return { stage: true, nomask: s.hasAttribute("data-nomask"), hit: hit !== null, hitOff: hit !== null && hit.hasAttribute("data-off"),'
  + ' mask: window.__dshLive2dPet.maskInfo ? window.__dshLive2dPet.maskInfo().present : "no-api" } })())'))
console.log('errors:', await ev('JSON.stringify((window.__errors ?? []).slice(0, 4))'))
const openPanel = () => ev('(() => { const h = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");'
  + ' if (!h) return "no-hit"; h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return "sent" })()')
for (let i = 0; i < 5; i += 1) {
  const sent = await openPanel()
  await sleep(600)
  const open = await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-panel]")')
  console.log('open attempt', i, sent, open, 'errors:', await ev('JSON.stringify((window.__errors ?? []).slice(-2))'))
  if (open === true) break
}
await ev('(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));'
  + ' const b = bs.find((x) => x.textContent.trim() === "设置"); if (b) b.click(); return !!b })()')
await sleep(900)
console.log('panel:', await ev('!!document.querySelector("[data-dsh-live2d-pet] [data-panel]")'))
console.log('pet still mounted:', await ev('document.querySelector("[data-dsh-live2d-pet]").children.length'))
console.log('logs:', JSON.stringify(logs.slice(-4)))
const box = JSON.parse(await ev('JSON.stringify((() => { const el = document.querySelector("[data-dsh-live2d-pet] [data-panel]");'
  + ' if (!el) return null; const r = el.getBoundingClientRect();'
  + ' return { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: Math.min(r.height + 12, 1000), scale: 1 } })())') ?? 'null')
if (box !== null) await shot('_panel-settings.png', box)
console.log('panel box:', JSON.stringify(box))
console.log('rows:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-phase-pool-row]")).map((el) => el.getAttribute("data-phase-pool-row")))'))
console.log('relations:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-relation]")).map((el) => el.textContent))'))
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
