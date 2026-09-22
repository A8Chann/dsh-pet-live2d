// 复现「掏出手机之后冒爱心没了」。
//
// 怀疑对象是摸鱼：氛围槽的池子里「默认」权重最大，一掷到它就走
// chooseSlotOption(ambient, null) 把槽位清掉 —— 而冒爱心是**爱心眼的配对**点亮的，
// 清掉之后没有任何东西会把它补回来（配平只是一次性副作用）。
//
//   node drivers/probe-heart.mjs
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, HERE, BASE } from '../paths.mjs'
import { waitReady, openPanel } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9391
const SERVER_PORT = 8893
const PROFILE = join(PROFILES, '_probe-heart')
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
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)
await sleep(1200)

const state = async () => JSON.parse(await ev('JSON.stringify({ pins: window.__dshLive2dPet.expressions(),'
  + ' slots: window.__dshLive2dPet.slotSelections(),'
  + ' love: window.__dshLive2dPet.drawn("love"), cheek26: window.__dshLive2dPet.drawn("ParamCheek26"),'
  + ' cheek73: window.__dshLive2dPet.drawn("ParamCheek73") })'))

await openPanel(ev)
await sleep(600)
await ev(`(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button"));
  const b = bs.find((x) => x.textContent.trim().startsWith("装扮")); if (b) b.click(); return !!b })()`)
await sleep(600)

const pick = async (slotId, label) => {
  const ok = await ev('(() => { const g = document.querySelector(' + JSON.stringify('[data-dsh-live2d-pet] [data-panel] [data-slot="' + slotId + '"]')
    + '); if (!g) return "no-slot"; const b = Array.from(g.querySelectorAll("[data-chips] button")).find((x) => x.textContent === '
    + JSON.stringify(label) + '); if (!b) return "no-chip"; b.click(); return "OK" })()')
  await sleep(900)
  return ok
}

console.log('1) 先点爱心眼：', await pick('eyes', '爱心眼'))
console.log('   ->', JSON.stringify(await state()))
console.log('2) 连做 5 次摸鱼，看冒爱心还在不在（「默认」= 这次不动，不该再被擦掉）：')
for (let i = 1; i <= 5; i += 1) {
  await ev('window.__dshLive2dPet.fidgetNow()')
  await sleep(900)
  const s = await state()
  console.log('   第' + i + '次 -> 冒爱心=' + (s.pins.includes('冒爱心') ? '在' : '没了')
    + ' 爱心眼=' + (s.pins.includes('爱心眼') ? '在' : '没了')
    + '  love=' + s.love + ' 爱心氛围槽=' + JSON.stringify(s.slots.heart ?? null)
    + ' 眼部槽=' + JSON.stringify(s.slots.eyes ?? null))
}
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
