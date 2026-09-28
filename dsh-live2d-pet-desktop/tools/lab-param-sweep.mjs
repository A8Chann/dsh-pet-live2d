// 按**每个参数自己的满量程**逐个推，看它驱动画面上哪块几何。
//
// 教训：先读 `paramRange()` 再取极值 —— 我上一轮拿 0→1 去试 `phone4`（量程 -10…10），
// 只走了 5% 量程，量到"什么都没动"。（这个坑在这个项目里已经踩过多次。）
//
//   node tools/lab-param-sweep.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { DESKTOP } from './paths.mjs'

const ORIGINAL = 'P:/DSH/live2d原始'
const CORE = join(process.env.USERPROFILE ?? '.', '.dsh', 'pets', '.runtime', 'live2dcubismcore.min.js')
const LAB = join(DESKTOP, 'tools', 'motion-lab')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }
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
await new Promise((resolve) => server.listen(8737, '127.0.0.1', resolve))
const profile = join(DESKTOP, '.run', 'edge-lab-sweep')
mkdirSync(profile, { recursive: true })
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9407', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

let target
for (let i = 0; i < 60 && target === undefined; i += 1) {
  await sleep(300)
  try {
    const list = await (await fetch('http://127.0.0.1:9407/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 等 */ }
}
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

await send('Page.navigate', { url: 'http://127.0.0.1:8737/' })
for (let i = 0; i < 40; i += 1) {
  const state = await json('JSON.stringify({ ready: !!window.__lab.ready, error: window.__lab.error || null })')
  if (state.error !== null) { console.error('试验台报错：' + state.error); process.exit(2) }
  if (state.ready === true) break
  await sleep(300)
}
console.log('试验台就绪')

const CANDIDATES = ['phone', 'phone2', 'phone3', 'phone4', 'phone5', 'phone6', 'phone7', 'phone8']
await ev('window.__lab.stop()')
const base = await json('JSON.stringify(window.__lab.drawables())')
const baseMap = new Map(base.map((row) => [row.id, (row.box.minY + row.box.maxY) / 2]))

for (const id of CANDIDATES) {
  const range = await json('JSON.stringify(window.__lab.paramRange(' + JSON.stringify(id) + '))')
  if (range === null) { console.log(''); console.log('=== ' + id + ' 不存在'); continue }
  // 从 min 推到 max（满量程）
  const samples = []
  const steps = 6
  for (let step = 0; step <= steps; step += 1) {
    const value = range.min + ((range.max - range.min) * step) / steps
    await ev('window.__lab.setParams(' + JSON.stringify({ [id]: value }) + ')')
    samples.push(await json('JSON.stringify(window.__lab.drawables())'))
  }
  const peak = new Map()
  for (const rows of samples) {
    for (const row of rows) {
      const mid = (row.box.minY + row.box.maxY) / 2
      const delta = mid - baseMap.get(row.id)
      const was = peak.get(row.id)
      if (was === undefined || Math.abs(delta) > Math.abs(was)) peak.set(row.id, delta)
    }
  }
  const top = Array.from(peak.entries())
    .map(([drawable, d]) => ({ id: drawable, d: Number(d.toFixed(1)) }))
    .filter((row) => Math.abs(row.d) > 2)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  console.log('')
  console.log('=== ' + id + '  量程 ' + range.min + ' … ' + range.max + '（默认 ' + range.default + '）')
  if (top.length === 0) { console.log('  （推满量程也没有任何几何移动 > 2 单位）'); continue }
  for (const row of top.slice(0, 10)) console.log('    ' + row.id.padEnd(16) + 'Δ中位y ' + String(row.d).padStart(7))
  console.log('    移动 > 2 的块数：' + top.length)
}

await ev('window.__lab.stop()')
socket.close()
try { child.kill() } catch { /* ignore */ }
server.close()
