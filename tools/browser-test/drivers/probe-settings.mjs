// 看一眼「会话相位 / 摸鱼」两张条目表在 DSH 设置页里长什么样。
//
// 一次性诊断脚本（不在套件内）：起一个测试服，把设置页那一节挂到页面里，加一个相位
// 再改两条，然后截图。改 CSS 或表格结构之后跑它，比读断言快。
//
//   node drivers/probe-settings.mjs
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, HERE, SHOTS, BASE } from '../paths.mjs'
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE_URL + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(4000)

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

const pick = (selector, value) => ev('(() => {'
  + ' const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false;'
  + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;'
  + ' setter.call(el, ' + JSON.stringify(value) + '); el.dispatchEvent(new Event("change", { bubbles: true })); return true })()')

// 加两个相位，并往其中一个池子里塞两条不同的东西，把关系行也带出来。
await pick('#dsh-settings-probe [data-phase-add]', 'tool')
await sleep(400)
await pick('#dsh-settings-probe [data-phase-add]', 'waiting')
await sleep(400)
await pick('#dsh-settings-probe [data-phase-pool-add="tool:rhand"]', '掏出手机')
await sleep(400)
await pick('#dsh-settings-probe [data-phase-pool-add="tool:rhand"]', '挤番茄酱')
await sleep(600)
// 折叠掉前半部分，让这两张表在截图里占主要位置。
await ev('document.querySelectorAll("#dsh-settings-probe [data-setting]")[0].style.display="none"')
await ev('document.querySelectorAll("#dsh-settings-probe [data-setting]")[1].style.display="none"')
await sleep(400)
const s = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOTS, '_settings-pools.png'), Buffer.from(s.result.data, 'base64'))
console.log('rows:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-phase-pool-row]")).map((el) => el.getAttribute("data-phase-pool-row")))'))
console.log('relations:', await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-relation]")).map((el) => el.textContent))'))
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
