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
ws.close(); edge.kill(); server.kill(); await sleep(300); process.exit(0)
