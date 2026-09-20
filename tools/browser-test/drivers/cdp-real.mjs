// Probe the REAL DSH GUI: load the app, wait, and report whether the
// Live2D pet mounted and is rendering.
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { browserPath, PROFILES, SHOTS } from './paths.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9336
const URL_TO_OPEN = process.argv[2]
const OUT = process.argv[3] ?? join(SHOTS, 'real-gui.png')
const PROFILE = join(PROFILES, '_cdp-real')
rmSync(PROFILE, { recursive: true, force: true })

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page
for (let i = 0; i < 100 && page === undefined; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    page = list.find((t) => t.type === 'page')
  } catch { /* not up */ }
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let nextId = 0
const pending = new Map()
const logs = []
const netFails = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined) { const s = pending.get(msg.id); if (s) { pending.delete(msg.id); s(msg) } return }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200))
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 400))
  if (msg.method === 'Network.loadingFailed') netFails.push(msg.params.errorText + ' (' + msg.params.type + ')')
}
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
await sleep(20000)

const probe = await evaluate(`JSON.stringify((() => {
  const roots = document.querySelectorAll('[data-dsh-live2d-pet]')
  const root = roots[0]
  const canvas = root && root.querySelector('canvas')
  return {
    url: location.href.split('?')[0],
    pluginContainers: document.querySelectorAll('[data-dsh-live2d-pet-root]').length,
    petRoots: roots.length,
    canvas: canvas ? [canvas.width, canvas.height] : null,
    hint: (document.querySelector('[data-dsh-live2d-pet] [data-hint]')||{}).textContent || null,
    bubble: (document.querySelector('[data-dsh-live2d-pet] [data-bubble]')||{}).textContent || null,
    core: typeof window.Live2DCubismCore,
    vendor: typeof window.__dshLive2dPetVendor,
    rootRect: root ? (()=>{const r=root.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})() : null,
    shellMounted: document.querySelectorAll('[data-pane]').length,
  }
})())`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))

console.log('PROBE: ' + probe)
console.log('LOGS: ' + JSON.stringify(logs.slice(0, 20), null, 1))
console.log('NETFAIL: ' + JSON.stringify(netFails.slice(0, 12)))
ws.close(); edge.kill(); process.exit(0)
