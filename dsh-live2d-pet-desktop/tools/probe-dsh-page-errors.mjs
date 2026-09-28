// 去 DSH 页面里把报错抓出来（设置页打不开时用）。
//
// 需要 DSH 跑在一个可接管的浏览器里：`dsh web --remote-debugging-port=9222`，或者
// 用工具起一个带调试端口的无头 Edge 打开它。
//
//   node tools/probe-dsh-page-errors.mjs [--port 9222] [--url http://127.0.0.1:3080]
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const PORT = Number(argOf('--port', '9222'))
const URL_BASE = argOf('--url', 'http://127.0.0.1:3080')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 端口上已经有浏览器就直接用；没有就起一个无头 Edge（带独立 profile，不动用户的）。 */
async function ensureCdp() {
  try {
    const response = await fetch('http://127.0.0.1:' + PORT + '/json/version')
    if (response.ok) return { owned: false }
  } catch { /* 需要自己起 */ }
  const browser = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((path) => existsSync(path))
  if (browser === undefined) throw new Error('找不到 Edge')
  const profile = join(DESKTOP, '.run', 'dsh-page-probe')
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', URL_BASE + '/',
  ], { stdio: 'ignore' })
  await sleep(4000)
  return { owned: true, child }
}

const { owned, child } = await ensureCdp()
let ws
for (let i = 0; i < 60 && ws === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    ws = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')?.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
  if (ws === undefined) await sleep(300)
}
if (ws === undefined) {
  console.error('CDP 上没有页面')
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
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails) return 'THREW: ' + JSON.stringify(result.result.exceptionDetails).slice(0, 300)
  return result.result?.result?.value
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await sleep(9000)

console.log('--- 异常 / 控制台')
for (const event of events) {
  if (event.method === 'Runtime.exceptionThrown') {
    const d = event.params.exceptionDetails
    console.log('  EXC ' + d.text + ' @ ' + (d.url ?? '') + ':' + (d.lineNumber + 1))
    const desc = d.exception?.description
    if (desc) console.log('      ' + String(desc).split('\n').slice(0, 6).join('\n      '))
  }
  if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
    console.log('  LOG ' + event.params.entry.text + ' @ ' + (event.params.entry.url ?? ''))
  }
  if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
    const args = event.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    console.log('  CONSOLE ' + String(args).slice(0, 400))
  }
}

console.log('--- 插件在页面里挂上了吗')
console.log('  __pluginSections:', await evaluate('JSON.stringify(Object.keys(window.__pluginSections ?? {}))'))
console.log('  设置页那一节:', await evaluate('JSON.stringify(Object.keys(window.__pluginSections?.["pet-settings"] ?? {}))'))
console.log('  pet 根节点:', await evaluate('String(!!document.querySelector("[data-dsh-live2d-pet]"))'))
console.log('  display.js 那段报错:', await evaluate('JSON.stringify(window.__errors ?? [])'))

// DSH 客户端自己的模块表长什么样、我们那个 bundle 有没有进去。
console.log('--- DSH 客户端的模块表 / 插件清单')
const exploration = await evaluate(`JSON.stringify({
  globals: Object.keys(window).filter((k) => /plugin|module|dsh/i.test(k)).slice(0, 40),
  moduleLoader: typeof window.__ModuleLoader__,
  registry: (() => {
    try { return Object.keys(window.__DSH__ ?? {}).slice(0, 20) } catch { return null }
  })(),
  scripts: [...document.scripts].map((s) => s.src).filter((src) => src !== '').slice(0, 40),
})`)
console.log('  ' + exploration)

// 直接渲染一次那一节，把 React 的报错逼出来 —— 设置页打不开就是这个组件抛了。
console.log('--- 直接在探针容器里渲染「桌宠」那一节')
console.log(await evaluate(`(() => {
  const section = window.__pluginSections?.['pet-settings'];
  if (section === undefined) return '没有注册这一节';
  let host = document.getElementById('__probe_host');
  if (host === null) {
    host = document.createElement('div');
    host.id = '__probe_host';
    document.body.appendChild(host);
  }
  try {
    const React = window.React ?? window.__REACT__;
    const ReactDOM = window.ReactDOM;
    if (React === undefined || ReactDOM === undefined) return '页面上拿不到 React 全局（DSH 自己打包了）';
    ReactDOM.createRoot(host).render(React.createElement(section.render));
    return 'render 已调用';
  } catch (error) {
    return 'THREW: ' + String(error && error.stack || error).slice(0, 500);
  }
})()`))
await sleep(1500)
console.log('--- 渲染之后容器里有什么')
console.log(await evaluate('String(document.getElementById("__probe_host")?.innerHTML ?? "").slice(0, 400) || "(空)"'))
console.log('--- 渲染期间的新异常')
for (const event of events.slice(-40)) {
  if (event.method === 'Runtime.exceptionThrown') {
    const desc = event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text
    console.log('  ' + String(desc).split('\n').slice(0, 8).join('\n  '))
  }
}

socket.close()
if (owned) child?.kill()
