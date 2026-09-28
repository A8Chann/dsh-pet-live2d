// 先验证试验台的**基本机制**：写参数 → update() → drawable 顶点真的变了吗？
//
// 我上一轮的 sweep 里"所有参数推满量程都没动"，可能是我的机制没生效（而不是真没动）。
// 这一版把中间量都打出来：参数表前后的值、某几块 drawable 的顶点坐标、以及顶点总数。
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
await new Promise((resolve) => server.listen(8739, '127.0.0.1', resolve))
const profile = join(DESKTOP, '.run', 'edge-lab-mech')
mkdirSync(profile, { recursive: true })
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9409', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 60 && target === undefined; i += 1) {
  await sleep(300)
  try {
    const list = await (await fetch('http://127.0.0.1:9409/json/list')).json()
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

await send('Page.navigate', { url: 'http://127.0.0.1:8739/' })
for (let i = 0; i < 40; i += 1) {
  const state = await json('JSON.stringify({ ready: !!window.__lab.ready, error: window.__lab.error || null })')
  if (state.error !== null) { console.error('试验台报错：' + state.error); process.exit(2) }
  if (state.ready === true) break
  await sleep(300)
}

// Core 上有哪些方法
console.log('Core Model 的方法：' + JSON.stringify(await json('JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(window.__lab.model)))')))
console.log('参数数量：' + await json('JSON.stringify(Array.from(window.__lab.model.parameters.ids).length)'))
console.log('drawable 数量：' + await json('JSON.stringify(Array.from(window.__lab.model.drawables.ids).length)'))

/** 取"某块 drawable 的顶点前 6 个数" + 全模型的顶点校验和（用来判断几何有没有变）。 */
const geom = async () => json(`JSON.stringify((() => {
  const m = window.__lab.model;
  const ids = Array.from(m.drawables.ids).map(String);
  const pos = m.drawables.vertexPositions;
  let sum = 0, count = 0;
  const samples = {};
  for (let i = 0; i < ids.length; i += 1) {
    const verts = pos[i];
    if (!verts) continue;
    for (let k = 0; k < verts.length; k += 1) { sum += verts[k]; count += 1; }
    if (ids[i] === 'ArtMesh26' || ids[i] === 'ArtMesh27' || ids[i] === 'ArtMesh804') {
      samples[ids[i]] = Array.from(verts).slice(0, 6);
    }
  }
  return { checksum: Number(sum.toFixed(2)), count: count, samples: samples };
})())`)

console.log('')
console.log('=== 基线（默认参数）')
await ev('window.__lab.stop()')
const g0 = await geom()
console.log('  校验和 ' + g0.checksum + '  顶点数 ' + g0.count)
console.log('  样本 ' + JSON.stringify(g0.samples))

// 试几个"应该明显改变画面"的参数：眼角/嘴巴/身体角度
const TRIES = [
  { id: 'ParamAngleZ', value: 30, why: '头部倾斜（应该整头都动）' },
  { id: 'ParamMouthOpenY', value: 1, why: '张嘴' },
  { id: 'phone2', value: 1, why: '手机盖（用户说的）' },
  { id: 'phone5', value: 10, why: '自拍的抬手候选' },
  { id: 'ParamBodyAngleZ', value: 10, why: '身体倾斜' },
]
for (const item of TRIES) {
  await ev('window.__lab.setParams(' + JSON.stringify({ [item.id]: item.value }) + ')')
  const g = await geom()
  console.log('')
  console.log('=== ' + item.id + ' = ' + item.value + '  （' + item.why + '）')
  console.log('  校验和 ' + g.checksum + '  → 与基线差 ' + Number((g.checksum - g0.checksum).toFixed(2)))
  console.log('  样本 ' + JSON.stringify(g.samples))
  // 参数表读回的值
  const back = await json('JSON.stringify(window.__lab.params()[' + JSON.stringify(item.id) + '])')
  console.log('  参数表读回：' + back)
  await ev('window.__lab.stop()')
}

socket.close()
try { child.kill() } catch { /* ignore */ }
server.close()
