// **动作试验台的用法**：起干净环境，量"每个动作/每个参数驱动画面上哪块几何"。
//
//   node tools/lab.mjs actions                每个动作：phone 参数随时间 + 位移最大的 drawable
//   node tools/lab.mjs param <id> [from] [to]  把某参数从 from 推到 to，看哪些 drawable 动
//   node tools/lab.mjs seek <group> <sec>     把某动作推进到某时刻，打印 phone 参数与最大位移块
//   node tools/lab.mjs raw <js>               在页面里跑一段 JS（返回 JSON 字符串）
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { DESKTOP, ROOT } from './paths.mjs'

const ORIGINAL = 'P:/DSH/live2d原始'
const CORE = join(process.env.USERPROFILE ?? '.', '.dsh', 'pets', '.runtime', 'live2dcubismcore.min.js')
const LAB = join(DESKTOP, 'tools', 'motion-lab')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = createServer((request, response) => {
  const url = decodeURIComponent((request.url ?? '/').split('?')[0])
  const send = (path) => {
    if (!existsSync(path)) { response.writeHead(404); response.end('404'); return }
    response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
    response.end(readFileSync(path))
  }
  if (url === '/' || url === '/index.html') return send(join(LAB, 'index.html'))
  if (url === '/core/live2dcubismcore.min.js') return send(CORE)
  if (url.startsWith('/model/motions/')) return send(join(ORIGINAL, 'motions', url.slice('/model/motions/'.length)))
  if (url.startsWith('/model/')) return send(join(ORIGINAL, url.slice('/model/'.length)))
  response.writeHead(404); response.end('nope')
})

let serving = 8735
let debugging = 9405
await new Promise((resolve) => server.listen(serving, '127.0.0.1', resolve))

const profile = join(DESKTOP, '.run', 'edge-lab')
mkdirSync(profile, { recursive: true })
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + debugging, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let target
for (let i = 0; i < 60 && target === undefined; i += 1) {
  await sleep(300)
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugging + '/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 等它起来 */ }
}
if (target === undefined) { console.error('无头浏览器没起来'); process.exit(2) }
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result))
  socket.send(JSON.stringify({ id, method, params }))
})
/** 求值并取回字符串（CDP 的返回是 {result:{type,value}}）。 */
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails !== undefined) return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
  return result?.result?.value
}
const json = async (expression) => {
  const raw = await ev(expression)
  if (raw !== null && typeof raw === 'object' && typeof raw.__error === 'string') throw new Error(raw.__error)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

await send('Page.navigate', { url: 'http://127.0.0.1:' + serving + '/' })
// 等一下页面把脚本跑起来：导航刚回来那一帧 `window.__lab` 还不存在，
// 直接读 `.ready` 会抛 TypeError（而这个错会被 json() 原样抛出来，看着像"页面坏了"）。
for (let i = 0; i < 60; i += 1) {
  const state = await json('JSON.stringify({ hasLab: typeof window.__lab !== "undefined", ready: typeof window.__lab !== "undefined" && !!window.__lab.ready, error: typeof window.__lab !== "undefined" ? (window.__lab.error || null) : null })')
  if (state.error !== null) { console.error('试验台报错：' + state.error); process.exit(2) }
  if (state.hasLab && state.ready === true) break
  await sleep(300)
}
console.log('试验台就绪（组：' + JSON.stringify(await json('JSON.stringify(window.__lab.groups())')) + '）')

/** 位移最大的 drawable（相对"清空参数"的基线，取每块中位 y 的位移极值）。 */
async function movers(measure) {
  await ev('window.__lab.stop()')
  const base = await json('JSON.stringify(window.__lab.drawables())')
  const baseMap = new Map(base.map((row) => [row.id, (row.box.minY + row.box.maxY) / 2]))
  const peak = new Map()
  await measure(async () => {
    const rows = await json('JSON.stringify(window.__lab.drawables())')
    for (const row of rows) {
      const mid = (row.box.minY + row.box.maxY) / 2
      const delta = mid - baseMap.get(row.id)
      const was = peak.get(row.id)
      if (was === undefined || Math.abs(delta) > Math.abs(was)) peak.set(row.id, delta)
    }
  })
  return Array.from(peak.entries())
    .map(([id, d]) => ({ id, d: Number(d.toFixed(1)) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
}

const mode = process.argv[2] ?? 'actions'

if (mode === 'actions') {
  const groups = await json('JSON.stringify(window.__lab.groups())')
  for (const group of groups) {
    const duration = await json('JSON.stringify(window.__lab.durationOf(' + JSON.stringify(group) + '))')
    console.log('')
    console.log('=== ' + group + '  时长 ' + Number(duration).toFixed(2) + 's  曲线参数=' + JSON.stringify(await json('JSON.stringify(window.__lab.curveIds(' + JSON.stringify(group) + '))')))
    if (!(duration > 0)) { console.log('  （没有时长，跳过）'); continue }
    const seen = {}
    const top = await movers(async (sample) => {
      for (let step = 0; step <= 16; step += 1) {
        const t = (duration * step) / 16
        await ev('window.__lab.seek(' + JSON.stringify(group) + ', ' + t + ')')
        const params = await json('JSON.stringify(window.__lab.params())')
        for (const [id, value] of Object.entries(params)) {
          if (!/^phone\d*$/.test(id)) continue
          if (typeof value !== 'number') continue
          if (seen[id] === undefined) seen[id] = []
          seen[id].push(Number(value.toFixed(2)))
        }
        await sample()
      }
    })
    console.log('  phone 参数随时间：' + JSON.stringify(seen))
    console.log('  位移最大的 drawable：')
    for (const row of top.slice(0, 8)) console.log('    ' + row.id.padEnd(16) + 'Δ中位y ' + String(row.d).padStart(6))
  }
} else if (mode === 'param') {
  const id = process.argv[3]
  const from = Number(process.argv[4] ?? 0)
  const to = Number(process.argv[5] ?? 1)
  const range = await json('JSON.stringify(window.__lab.paramRange(' + JSON.stringify(id) + '))')
  console.log('参数 ' + id + ' 量程=' + JSON.stringify(range) + '，本次 ' + from + ' → ' + to)
  const top = await movers(async (sample) => {
    await ev('window.__lab.setParams(' + JSON.stringify({ [id]: from }) + ')')
    await sample()
    await ev('window.__lab.setParams(' + JSON.stringify({ [id]: to }) + ')')
    await sample()
  })
  console.log('位移最大的 drawable：')
  for (const row of top.slice(0, 12)) console.log('  ' + row.id.padEnd(16) + 'Δ中位y ' + String(row.d).padStart(6))
  console.log('位移 |Δ|>30 的块数：' + top.filter((row) => Math.abs(row.d) > 30).length + ' / ' + top.length)
} else if (mode === 'seek') {
  const group = process.argv[3]
  const seconds = Number(process.argv[4] ?? 0)
  await ev('window.__lab.stop()')
  await ev('window.__lab.seek(' + JSON.stringify(group) + ', ' + seconds + ')')
  const params = await json('JSON.stringify(window.__lab.params())')
  const phone = {}
  for (const [id, value] of Object.entries(params)) {
    if (!/^phone\d*$/.test(id)) continue
    phone[id] = typeof value === 'number' ? Number(value.toFixed(3)) : value
  }
  const rows = await json('JSON.stringify(window.__lab.drawables())')
  const hand = rows.find((row) => row.id === 'ArtMesh26') ?? null
  const phoneProp = rows.find((row) => row.id === 'ArtMesh27') ?? null
  console.log(group + ' @ ' + seconds + 's')
  console.log('  phone 参数：' + JSON.stringify(phone))
  console.log('  ArtMesh26（看手机/手）盒：' + JSON.stringify(hand?.box ?? null))
  console.log('  ArtMesh27（手机）盒：' + JSON.stringify(phoneProp?.box ?? null))
} else if (mode === 'shot') {
  // 把参数推到给定值后**出图**：`node tools/lab.mjs shot <out.png> [参数=值 …]`
  // 这是"某条参数到底让画面变成什么样"的最终判据 —— 读顶点变化量会被噪声骗（踩过）。
  const out = process.argv[3]
  const assignments = process.argv.slice(4)
  await ev('window.__lab.stop()')
  if (assignments.length > 0) {
    const map = {}
    for (const item of assignments) {
      // `@<组>@<秒>`：把**动作**推进到那一刻（比手写一堆参数值准 —— 那才是真实姿势）。
      if (item.startsWith('@')) {
        const parts = item.slice(1).split('@')
        const seconds = Number(parts[1] === undefined ? 0 : parts[1])
        await ev('window.__lab.seek(' + JSON.stringify(parts[0]) + ', ' + seconds + ')')
        continue
      }
      const [id, raw] = item.split('=')
      map[id] = Number(raw)
    }
    if (Object.keys(map).length > 0) {
      await ev('window.__lab.setParams(' + JSON.stringify(map) + ')')
    }
  }
  const shot = await json('JSON.stringify(window.__lab.snapshot())')
  if (shot.error !== undefined) { console.error('出图失败：' + shot.error); process.exit(2) }
  const base64 = String(shot.url).replace(/^data:image\/png;base64,/, '')
  writeFileSync(out, Buffer.from(base64, 'base64'))
  console.log('已存 ' + out + '（画了 ' + shot.drawn + ' 块）  参数=' + JSON.stringify(assignments))} else if (mode === 'raw') {
  const result = await ev('(function () { ' + process.argv[3] + ' })()')
  console.log(typeof result === 'string' ? result : JSON.stringify(result))
}

socket.close()
try { child.kill() } catch { /* ignore */ }
server.close()
