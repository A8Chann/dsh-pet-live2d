import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9397
const PROFILE = join(PROFILES, '_cdp-lod')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' })
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
const BOOT = `(() => {
  window.__lod = []
  const proto = CanvasRenderingContext2D.prototype
  const od = proto.drawImage
  proto.drawImage = function (src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (window.__lod.length < 200) {
      window.__lod.push({ args: arguments.length, src: (src && src.width) + 'x' + (src && src.height), sw: sw, sh: sh, dw: dw, dh: dh, t: Date.now() })
    }
    return od.apply(this, arguments)
  }
  window.__lod0 = () => (window.__lod = [])
  return 'ok'
})()`
await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT })
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(6000)
console.log('BOOT LOD:', await ev('JSON.stringify(window.__lod)'))
const info = () => ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]");const c=r.querySelector("canvas");return {rootW:r.style.width,backing:[c.width,c.height]}})())')
const out = []
for (const target of [160, 300, 460, 620, 760]) {
  const cur = JSON.parse(await info())
  const steps = Math.round((target - parseInt(cur.rootW, 10)) / 40)
  if (steps !== 0) {
    await ev(`(()=>{const bs=Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-bar] button'));const b=bs[${steps > 0 ? 'bs.length-1' : '0'}];for(let i=0;i<${Math.abs(steps)};i++)b.click();return true})()`)
    await sleep(2000)
  }
  await ev('window.__lod = []')
  await sleep(2500)
  out.push({ target, info: JSON.parse(await info()), lod: JSON.parse(await ev('JSON.stringify(window.__lod.slice(0,6))')) })
}
console.log('SIZES:', JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
