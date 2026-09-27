// 一次性诊断：独立二进制服务的页面里，Cubism Core 那个脚本到底加载成什么样了。
//   node tools/probe-core.mjs --url http://127.0.0.1:8796
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from '../sidecar/paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const URL_BASE = argOf('--url', 'http://127.0.0.1:8796')
const CDP_PORT = Number(argOf('--cdp-port', '8897'))
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((c) => existsSync(c))
const profile = join(DESKTOP, '.run', 'probe-core-profile')
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const child = spawn(browser, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', URL_BASE + '/',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
for (let i = 0; i < 60 && ws === undefined; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
    ws = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* retry */ }
  if (ws === undefined) await sleep(250)
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
  return result.result?.result?.value
}

await send('Runtime.enable')
await send('Network.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await sleep(12000)

console.log('--- 网络请求（只看 runtime / core / vendor / client）')
for (const event of events) {
  if (event.method === 'Network.responseReceived') {
    const url = event.params.response.url
    if (/runtime|core|vendor|client\.js/.test(url)) {
      console.log('  ' + event.params.response.status + '  ' + url)
    }
  }
  if (event.method === 'Network.loadingFailed') {
    console.log('  FAILED  ' + event.params.errorText + '  ' + (event.params.requestId ?? ''))
  }
}
console.log('--- 控制台/异常')
for (const event of events) {
  if (event.method === 'Log.entryAdded') console.log('  LOG[' + event.params.entry.level + '] ' + event.params.entry.text + ' @ ' + (event.params.entry.url ?? ''))
  if (event.method === 'Runtime.exceptionThrown') {
    const d = event.params.exceptionDetails
    console.log('  EXC ' + d.text + ' @ ' + (d.url ?? '') + ':' + (d.lineNumber + 1))
    if (d.exception?.description) console.log('      ' + String(d.exception.description).split('\n').slice(0, 4).join('\n      '))
  }
  if (event.method === 'Runtime.consoleAPICalled') {
    const args = event.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    console.log('  CONSOLE[' + event.params.types + '] ' + String(args).slice(0, 240))
  }
}
console.log('--- 页面状态')
console.log('  Live2DCubismCore = ' + await evaluate('typeof window.Live2DCubismCore'))
console.log('  vendor = ' + await evaluate('typeof window.__dshLive2dPetVendor'))
console.log('  canvas = ' + await evaluate('String(!!document.querySelector("[data-dsh-live2d-pet] canvas"))'))
console.log('  已注入的 script = ' + await evaluate('JSON.stringify([...document.scripts].map(s => s.src).filter(Boolean))'))
console.log('  hint = ' + await evaluate('document.querySelector("[data-dsh-live2d-pet] [data-hint]")?.textContent ?? "(无)"'))
console.log('  errors = ' + await evaluate('JSON.stringify(window.__errors ?? [])'))

socket.close()
child.kill()
