// 探针：新 api 读口到底有没有挂上，以及页面里有没有未捕获异常。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, HERE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9396
const SERVER_PORT = 8898
const PROFILE = join(PROFILES, '_probe-api')
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
console.log('waitReady:', await waitReady(ev))
await sleep(1200)

console.log('未捕获异常:', await ev('JSON.stringify(window.__errors ?? [])'))
console.log('api 键:', await ev('JSON.stringify(Object.keys(window.__dshLive2dPet ?? {}).sort())'))
console.log('lineFields 类型:', await ev('typeof window.__dshLive2dPet?.lineFields'))
console.log('lineFields():', await ev('JSON.stringify(window.__dshLive2dPet?.lineFields?.() ?? null)'))
console.log('effectiveLines().pat:', await ev('JSON.stringify(window.__dshLive2dPet?.effectiveLines?.().pat ?? null)'))
console.log('__pluginSections:', await ev('JSON.stringify(Object.keys(window.__pluginSections ?? {}))'))
console.log('drawable 表字段:', await ev('JSON.stringify(window.__dshLive2dPet.partTables().drawableKeys)'))
// 逐部件：透明度 / 包围盒 / drawable 数 —— "隐藏的配件是不是还留着几何"，一看便知。
console.log('partsDebug 类型:', await ev('typeof window.__dshLive2dPet.partsDebug'))
console.log('调用结果:', await ev(`(() => {
  try { return JSON.stringify(window.__dshLive2dPet.partsDebug("tail")).slice(0, 200) }
  catch (error) { return 'THREW: ' + String(error && error.message || error) }
})()`))
const tail = JSON.parse((await ev(`(() => {
  try { return JSON.stringify(window.__dshLive2dPet.partsDebug("tail")) }
  catch { return '[]' }
})()`)) ?? '[]')
console.log('--- 尾巴/翅膀部件（' + tail.length + ' 个）---')
for (const p of tail) {
  console.log('  ' + String(p.id).padEnd(24) + ' opacity=' + String(p.opacity).padEnd(7)
    + ' drawables=' + String(p.drawables).padEnd(3) + ' box=' + JSON.stringify(p.box))
}
// 头部与尾巴的重叠：有多少采样点**同时**命中两边 —— >0 就是"摸头出摸尾效果"的根因。
const overlap = JSON.parse(await ev(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let both = 0, head = 0, tail = 0
  for (let iy = 0; iy < 60; iy++) {
    for (let ix = 0; ix < 60; ix++) {
      const lx = r.width * (ix + 0.5) / 60, ly = r.height * (iy + 0.5) / 60
      const h = c.hitsHead(lx, ly), t = c.hitsTail(lx, ly)
      if (h) head += 1
      if (t) tail += 1
      if (h && t) both += 1
    }
  }
  return JSON.stringify({ both, head, tail })
})()`))
console.log('重叠统计:', JSON.stringify(overlap))
// 逐部件：它在判定网格里贡献了多少命中点（过滤前 / 过滤后）+ drawable 透明度范围。
const perPart = JSON.parse((await ev(`(() => {
  try { return JSON.stringify(window.__dshLive2dPet.partHitCounts('tail')) } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }) }
})()`)) ?? '[]')
console.log('--- 每个尾巴部件（模型空间采样）---')
for (const p of (Array.isArray(perPart) ? perPart : [perPart])) {
  console.log('  ' + String(p.id).padEnd(22) + ' part=' + String(p.partIndex).padEnd(5)
    + ' draw=' + String(p.drawables).padEnd(3) + ' opa=' + String(p.opacityMin) + '..' + String(p.opacityMax)
    + ' hitsAll=' + String(p.hitsAll).padEnd(5) + ' hitsVisible=' + String(p.hitsVisible)
    + ' box=' + JSON.stringify(p.box))
}
// "判定是不是静态的"：等两秒半再采一次，区域变了才说明它跟着动画走。
const sample = () => ev(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let sig = ""
  for (let iy = 0; iy < 24; iy++) for (let ix = 0; ix < 24; ix++) {
    sig += c.hitsHead(r.width * (ix + 0.5) / 24, r.height * (iy + 0.5) / 24) ? "1" : "0"
  }
  return sig
})()`)
const s1 = await sample()
await sleep(2500)
const s2 = await sample()
let diff = 0
for (let i = 0; i < Math.min(s1.length, s2.length); i += 1) if (s1[i] !== s2[i]) diff += 1
console.log('头部判定区域 2.5 秒内变化的格子数:', diff, '/', s1.length)
// 对每个 drawable 单测三角面判定：头部那几个应该中，尾巴那几个应该也中。
for (const id of ['Face_line', 'lianhong', 'ArtMesh75', 'ArtMesh36', 'ArtMesh38', 'ArtMesh253']) {
  console.log('  probe ' + id.padEnd(14) + ' -> ' + await ev(`(() => {
    try { return JSON.stringify(window.__dshLive2dPet.drawableProbe(${JSON.stringify(id)})) }
    catch (e) { return 'THREW: ' + String(e && e.message || e) }
  })()`))
}
// 全部 drawable：所属部件名 + 包围盒。找"她身上真正在画尾巴的那一个"。
const all = JSON.parse((await ev(`(() => {
  try { return JSON.stringify(window.__dshLive2dPet.drawableTable()) } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }) }
})()`)) ?? '[]')
console.log('--- 全部 drawable（' + (Array.isArray(all) ? all.length : '?') + ' 个，按 v 坐标（越大越高）倒序）---')
if (Array.isArray(all)) {
  const rows = all.slice().sort((a, b) => (b.box ? b.box.maxY : -1e9) - (a.box ? a.box.maxY : -1e9))
  for (const r of rows) {
    console.log('  ' + String(r.id).padEnd(22) + ' part=' + String(r.partName).padEnd(14)
      + ' v=' + String(r.vertexCount).padEnd(5) + ' box=' + JSON.stringify(r.box))
  }
}
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
