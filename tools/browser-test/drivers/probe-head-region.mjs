// 探针：把 hitsHead 的判定区域打成 ASCII 图，看看它是不是"头"。
//
//   node drivers/probe-head-region.mjs
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, HERE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9395
const SERVER_PORT = 8897
const PROFILE = join(PROFILES, '_probe-head-region')
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
await sleep(1500)

console.log('头部部件数:', await ev('window.__dshLive2dPet.headPartIDs().length'))
console.log('旧方框判定用的 headBox:', await ev('JSON.stringify(window.__dshLive2dPet.headBox())'))
console.log('判定内部状态:', await ev('JSON.stringify(window.__dshLive2dPet.headDebug())'))
// 认"头"只能靠 drawable 自己的名字（美术起的），全打出来看规律。
const names = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.drawableIDs())'))
console.log('drawable 总数:', names.length)
console.log('引擎原始表:', await ev('JSON.stringify(window.__dshLive2dPet.partTables())').then((s) => s.slice(0, 600)))

// 两张图对比：几何判定（新） vs 方框判定（旧）。有差异才说明新规则真的在起作用。
const maps = await ev(`(() => {
  const root = document.querySelector("[data-dsh-live2d-pet]");
  const rect = root.getBoundingClientRect();
  const api = window.__dshLive2dPet;
  const box = api.headBox();
  const cols = 46, rows = 32;
  const geom = [], old = [];
  let diff = 0;
  for (let r = 0; r < rows; r += 1) {
    let a = "", b = "";
    for (let c = 0; c < cols; c += 1) {
      const x = rect.width * (c + 0.5) / cols;
      const y = rect.height * (r + 0.5) / rows;
      const hit = api.hitsHead(x, y);
      a += hit ? "#" : ".";
      const boxed = api.hitsHeadBox(x, y) === true;
      b += boxed ? "#" : ".";
      if (hit !== boxed) diff += 1;
    }
    geom.push(a); old.push(b);
  }
  return JSON.stringify({ geom, old, diff, hasBox: box !== null });
})()`)
const parsed = JSON.parse(maps)
console.log('几何判定区域（46x32）：')
for (const line of parsed.geom) console.log('   ' + line)
console.log('旧方框判定区域（同一个网格）：')
for (const line of parsed.old) console.log('   ' + line)
console.log('两者不同的格子数:', parsed.diff, '| 有方框:', parsed.hasBox)
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
