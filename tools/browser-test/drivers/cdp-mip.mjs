import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9399
const PROFILE = join(PROFILES, '_cdp-mip')
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
  window.__gl = { upload: [], minFilters: [], genmip: 0, aniso: [] }
  const patch = (proto) => {
    if (!proto) return
    const ot = proto.texImage2D, og = proto.generateMipmap, op = proto.texParameteri
    if (ot) proto.texImage2D = function (t, lvl, ifmt, w, h) {
      if (window.__gl.upload.length < 30) window.__gl.upload.push('L' + lvl + ' ' + w + 'x' + h)
      return ot.apply(this, arguments)
    }
    if (og) proto.generateMipmap = function () { window.__gl.genmip += 1; return og.apply(this, arguments) }
    if (op) proto.texParameteri = function (t, p, v) {
      const c = this
      if (p === c.TEXTURE_MIN_FILTER && window.__gl.minFilters.length < 30) {
        window.__gl.minFilters.push(v === c.LINEAR ? 'LINEAR' : v === c.LINEAR_MIPMAP_LINEAR ? 'LINEAR_MIPMAP_LINEAR'
          : v === c.NEAREST_MIPMAP_LINEAR ? 'NEAREST_MIPMAP_LINEAR' : v === c.LINEAR_MIPMAP_NEAREST ? 'LINEAR_MIPMAP_NEAREST' : String(v))
      }
      if (p === 0x84FE && window.__gl.aniso.length < 6) window.__gl.aniso.push('TEXTURE_MAX_ANISOTROPY_EXT=' + v)
      return op.apply(this, arguments)
    }
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype)
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype)
  return 'ok'
})()`
await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT })
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(6000)
console.log('BOOT GL:', await ev('JSON.stringify(window.__gl)'))

const info = () => ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]");const c=r.querySelector("canvas");const cr=c.getBoundingClientRect();const st=r.querySelector("[data-stage]").getBoundingClientRect();return {rootW:r.style.width,backing:[c.width,c.height],css:[Math.round(cr.width),Math.round(cr.height)],stage:[Math.round(st.width),Math.round(st.height)]}})())')
const shots = []
for (const target of [160, 300, 620]) {
  const cur = JSON.parse(await info())
  const steps = Math.round((target - parseInt(cur.rootW, 10)) / 40)
  if (steps !== 0) {
    await ev(`(()=>{const bs=Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-bar] button'));const b=bs[${steps > 0 ? 'bs.length-1' : '0'}];for(let i=0;i<${Math.abs(steps)};i++)b.click();return true})()`)
    await sleep(2500)
  }
  const now = JSON.parse(await info())
  const rootBox = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})())'))
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: rootBox.height, scale: 1 } })
  const file = join(SHOTS, 'mip-') + target + '.png'
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  shots.push({ target, info: now, file })
}
console.log('SHOTS:', JSON.stringify(shots, null, 1))
console.log('GL AFTER:', await ev('JSON.stringify({genmip: window.__gl.genmip, minFilters: window.__gl.minFilters.slice(0,8), upload: window.__gl.upload})'))
ws.close(); edge.kill(); process.exit(0)
