import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9395
const PROFILE = join(PROFILES, '_cdp-fit')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(4000)
console.log(await ev(`JSON.stringify((()=>{
  const root = document.querySelector('[data-dsh-live2d-pet]')
  const stage = root.querySelector('[data-stage]')
  const canvas = stage.querySelector('canvas')
  const sr = stage.getBoundingClientRect()
  const cr = canvas.getBoundingClientRect()
  const ctl = window.__dshLive2dPet
  return {
    dpr: window.devicePixelRatio,
    stage: [Math.round(sr.width), Math.round(sr.height)],
    canvasCss: [Math.round(cr.width), Math.round(cr.height)],
    canvasBacking: [canvas.width, canvas.height],
    mask: ctl && ctl.maskInfo ? ctl.maskInfo() : null,
    gaze: root.getAttribute('data-gaze'),
  }
})())`))
ws.close(); edge.kill(); process.exit(0)
