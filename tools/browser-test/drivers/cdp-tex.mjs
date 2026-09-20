import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9391
const PROFILE = join(PROFILES, '_cdp-tex')
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
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(3000)

console.log('patch:', await ev(`(() => {
  const c = document.querySelector('[data-dsh-live2d-pet] canvas')
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  if (!gl) return 'no gl'
  window.__texLog = { bind: 0, upload: 0, genmip: 0, filters: [] }
  const proto = Object.getPrototypeOf(gl)
  const ob = proto.bindTexture || gl.bindTexture
  const ot = proto.texImage2D || gl.texImage2D
  const og = proto.generateMipmap || gl.generateMipmap
  const op = proto.texParameteri || gl.texParameteri
  gl.bindTexture = function () { window.__texLog.bind += 1; return ob.apply(this, arguments) }
  gl.texImage2D = function () { window.__texLog.upload += 1; return ot.apply(this, arguments) }
  gl.generateMipmap = function () { window.__texLog.genmip += 1; return og.apply(this, arguments) }
  gl.texParameteri = function (target, pname, param) {
    if (pname === gl.TEXTURE_MIN_FILTER && window.__texLog.filters.length < 24) window.__texLog.filters.push(param)
    return op.apply(this, arguments)
  }
  return 'ok'
})()`))

const info = () => ev(`JSON.stringify((()=>{
  const root = document.querySelector('[data-dsh-live2d-pet]')
  const c = root.querySelector('canvas')
  const r = c.getBoundingClientRect()
  return { cssW: Math.round(r.width), backing: [c.width, c.height], rootW: root.style.width }
})())`)
const counts = () => ev('JSON.stringify(window.__texLog)')

const out = []
for (const target of [160, 240, 320, 440, 560, 700]) {
  const cur = JSON.parse(await info())
  let w = parseInt(cur.rootW, 10)
  const steps = Math.round((target - w) / 40)
  if (steps !== 0) {
    await ev(`(()=>{const bs=Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-bar] button'));const b=bs[${steps > 0 ? 'bs.length-1' : '0'}];for(let i=0;i<${Math.abs(steps)};i++)b.click();return true})()`)
    await sleep(1600)
  }
  await ev('window.__texLog = { bind: 0, upload: 0, genmip: 0, filters: [] }')
  await sleep(2500)
  out.push({ target, info: JSON.parse(await info()), counts: JSON.parse(await counts()) })
}
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
