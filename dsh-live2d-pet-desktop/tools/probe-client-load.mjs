// 在**真加载器**下把 client.js 跑一遍，看它报什么错。
//
// 复刻 `tools/browser-test` 那套最小宿主：一个 node http 服务器挂插件路由 + React UMD +
// 假 `__ModuleLoader__`。这样能把"插件客户端自己坏了"和"DSH 页面环境的问题"分开 ——
// 设置页打不开时，先回答是不是我们这边的问题。
//
//   node tools/probe-client-load.mjs
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, PLUGIN, ROOT } from './paths.mjs'

const PORT = 8797
const CDP = 8899
const HARNESS = join(ROOT, 'tools', 'browser-test')
const REACT = join(HARNESS, 'node_modules')

const send = (response, file, type) => {
  try {
    const body = readFileSync(file)
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(body)
  } catch (error) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing ' + file)
  }
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://x').pathname
  if (pathname === '/') return send(response, join(HARNESS, 'index.html'), 'text/html; charset=utf-8')
  if (pathname === '/harness.js') return send(response, join(HARNESS, 'harness.js'), 'application/javascript')
  if (pathname === '/react.js') return send(response, join(REACT, 'react', 'umd', 'react.development.js'), 'application/javascript')
  if (pathname === '/react-dom.js') return send(response, join(REACT, 'react-dom', 'umd', 'react-dom.development.js'), 'application/javascript')
  if (pathname === '/plugins/dsh-pet-live2d/client.js') return send(response, join(PLUGIN, 'lib', 'client.js'), 'application/javascript; charset=utf-8')
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('no ' + pathname)
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((path) => existsSync(path))
const profile = join(DESKTOP, '.run', 'client-load-probe')
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
const child = spawn(browser, [
  '--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + profile,
  '--no-first-run', 'http://127.0.0.1:' + PORT + '/',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
for (let i = 0; i < 60 && ws === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    ws = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
  if (ws === undefined) await sleep(300)
}
if (ws === undefined) {
  console.error('CDP 没就绪')
  process.exit(2)
}

const socket = new WebSocket(ws)
await new Promise((r) => socket.addEventListener('open', r))
let seq = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const cb = pending.get(message.id)
    if (cb) { pending.delete(message.id); cb(message) }
    return
  }
  events.push(message)
})
await new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method: 'Runtime.enable' }))
  socket.send(JSON.stringify({ id: id + 1, method: 'Page.enable' }))
})
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result?.result?.value))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

await sleep(6000)
console.log('--- 加载结果')
console.log('  注册的模块 : ' + await evaluate('JSON.stringify(Object.keys(window.__pluginExports ?? {}))'))
console.log('  启动错误   : ' + String(await evaluate('String(window.__bootError ?? "(无)")')).slice(0, 800))
console.log('  页面异常   : ' + await evaluate('JSON.stringify(window.__errors ?? [])'))
console.log('  pet 根节点 : ' + await evaluate('String(!!document.querySelector("[data-dsh-live2d-pet]"))'))
console.log('  设置那一节 : ' + await evaluate('JSON.stringify(Object.keys(window.__pluginSections ?? {}))'))

// **真的把设置正文渲染一遍** —— "设置页打不开"就是这个组件抛了。只验"注册上了"是不够的，
// 这一步才是能复现用户症状的地方（和 tools/browser-test 的 openSettings() 同一个套路）。
console.log('--- 真的渲染「桌宠」那一节（探针容器）')
console.log('  ' + await evaluate(`(() => {
    const section = window.__pluginSections?.['pet-settings'];
    if (section === undefined) return '没有注册这一节';
    let host = document.getElementById('dsh-settings-probe');
    if (host === null) { host = document.createElement('div'); host.id = 'dsh-settings-probe'; document.body.appendChild(host); }
    try {
      const react = window.React, reactDom = window.ReactDOM;
      reactDom.createRoot(host).render(react.createElement(section.render));
      return 'render 已调用';
    } catch (error) {
      return 'THREW: ' + String((error && error.stack) || error).slice(0, 600);
    }
  })()`))
await sleep(2000)
console.log('  容器里有多少节点 : ' + await evaluate('String(document.getElementById("dsh-settings-probe")?.childElementCount ?? -1)'))
console.log('  卡片 : ' + await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-card]")].map((n) => n.getAttribute("data-card")))'))
console.log('  显示位置那张卡的按钮 : ' + await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-layer-options] button")].map((n) => n.textContent))'))
console.log('  状态行 : ' + await evaluate('String(document.querySelector("#dsh-settings-probe [data-layer-status]")?.textContent ?? "(没有)")'))
console.log('  渲染期间的异常 : ' + await evaluate('JSON.stringify(window.__errors ?? [])'))

console.log('--- 页面里的异常明细')
for (const event of events) {
  if (event.method !== 'Runtime.exceptionThrown') continue
  const details = event.params.exceptionDetails
  console.log('  EXC ' + details.text + ' @ ' + (details.url ?? '') + ':' + (details.lineNumber + 1))
  const description = details.exception?.description
  if (description) console.log('      ' + String(description).split('\n').slice(0, 8).join('\n      '))
}

socket.close()
child.kill()
server.close()
