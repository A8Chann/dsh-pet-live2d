// 验证「吹泡泡糖不出来」的假设：`desired` 是**扫描全部槽位、取第一个带 motion 的选中项**，
// 而右手（掏出手机）在嘴部（吹泡泡糖）之前 —— 所以右手拿着手机时点吹泡泡糖会被静默忽略。
//
//   node drivers/probe-bubble-order.mjs
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, HERE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9394
const SERVER_PORT = 8896
const PROFILE = join(PROFILES, '_probe-bubble-order')
const server = spawn(process.execPath, [join(HERE, 'server.mjs'), String(SERVER_PORT)], { stdio: 'ignore', cwd: HERE })
process.env.PET_BASE = 'http://127.0.0.1:' + SERVER_PORT
rmSync(PROFILE, { recursive: true, force: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: process.env.PET_BASE + '/' })
for (let i = 0; i < 240; i += 1) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)
await sleep(1200)

await ev(`(() => { const h = document.querySelector("[data-dsh-live2d-pet] [data-hit]")
  || document.querySelector("[data-dsh-live2d-pet] [data-stage]");
  h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true })()`)
await sleep(800)
await ev(`(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));
  const b = bs.find((x) => x.textContent.trim().startsWith("装扮")); if (b) b.click(); return !!b })()`)
await sleep(700)

const pick = async (slotId, label) => {
  const ok = await ev('(() => { const g = document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-panel] [data-slot="' + slotId + '"]')
    + '); if (!g) return "no-slot"; const b = Array.from(g.querySelectorAll("[data-chips] button")).find((x) => x.textContent === '
    + JSON.stringify(label) + '); if (!b) return "no-chip"; b.click(); return "OK" })()')
  await sleep(1500)
  return ok
}
const state = async (tag) => {
  const s = JSON.parse(await ev('JSON.stringify({'
    + ' motion: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion"),'
    + ' slots: window.__dshLive2dPet.slotSelections(),'
    + ' bubble: window.__dshLive2dPet.drawn("chuipaopao") })'))
  console.log(tag.padEnd(30), '| data-motion=' + String(s.motion).padEnd(10),
    '| chuipaopao=' + s.bubble, '| 右手=' + (s.slots.rhand ?? '无'), '| 嘴部=' + (s.slots.mouth ?? '闭嘴'))
  return s
}

console.log('A) 只点吹泡泡糖')
console.log('   点嘴部 =', await pick('mouth', '吹泡泡糖'))
await state('   → 期望 BubbleGum')

console.log('')
console.log('B) 先点掏出手机，再点吹泡泡糖（右手槽位在嘴部之前）')
console.log('   点右手 =', await pick('rhand', '掏出手机'))
await state('   右手拿着手机时')
console.log('   点嘴部 =', await pick('mouth', '吹泡泡糖'))
await state('   → 期望 BubbleGum，实际？')
await sleep(1500)
await state('   +1.5s')
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
