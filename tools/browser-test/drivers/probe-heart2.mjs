// 量清楚"动作一播，冒爱心就失效"到底死在哪一环。
//
// 三个要区分的结果：
//   pins 里还有冒爱心 + love≈1  → 是画面之外的事（图层顺序）
//   pins 里有冒爱心 + love≈0    → pin 在、写不进模型
//   pins 里没有冒爱心           → 上游把 pin 弄丢了
//
//   node drivers/probe-heart2.mjs
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, HERE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9392
const SERVER_PORT = 8894
const PROFILE = join(PROFILES, '_probe-heart2')
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

const snap = async (tag) => {
  const s = JSON.parse(await ev('JSON.stringify({'
    + ' pins: window.__dshLive2dPet.expressions(),'
    + ' love: window.__dshLive2dPet.drawn("love"),'
    + ' loveRaw: window.__dshLive2dPet.readParameter ? window.__dshLive2dPet.readParameter("love") : null,'
    + ' layers: window.__dshLive2dPet.expressionLayerCount(),'
    + ' fade: window.__dshLive2dPet.expressionFade().filter((p) => p[0] === "love"),'
    + ' motion: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")'
    + ' })'))
  console.log(tag.padEnd(22),
    '| 冒爱心pin=' + (s.pins.includes('冒爱心') ? '有' : '无'),
    '| love drawn=' + (s.love === null || s.love === undefined ? 'null' : Number(s.love).toFixed(3)),
    '| raw=' + (s.loveRaw === null || s.loveRaw === undefined ? 'null' : Number(s.loveRaw).toFixed(3)),
    '| layers=' + s.layers, '| fade=' + JSON.stringify(s.fade), '| motion=' + s.motion)
  return s
}

// 用 **槽位选项**重现用户的路（不是 playOnce 裸播）：掏出手机 / 吹泡泡糖 / 自拍
// 都是槽位选项，走的是 `kind:"slot", hold+persist` 那条路。
await ev('window.__dshLive2dPet.setExpressions([])')
await sleep(400)
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
  await sleep(1200)
  return ok
}

console.log('点爱心眼：', await pick('eyes', '爱心眼'))
await sleep(600)
await snap('静止（爱心眼已选）')

for (const [slotId, label, name] of [['rhand', '掏出手机', '掏出手机'], ['mouth', '吹泡泡糖', '吹泡泡糖'], ['selfie', '自拍', '自拍']]) {
  console.log('点 ' + name + '：', await pick(slotId, label))
  await snap('刚选 ' + name)
  await sleep(1000)
  await snap('  +1.0s')
  await sleep(2500)
  await snap('  +3.5s')
  await sleep(2500)
  await snap('  +6.0s')
  await pick(slotId, slotId === 'mouth' ? '闭嘴' : '无')
  await sleep(1200)
  await snap('  清回默认')
}
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
