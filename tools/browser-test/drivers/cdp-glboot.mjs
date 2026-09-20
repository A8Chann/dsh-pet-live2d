import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9393
const PROFILE = join(PROFILES, '_cdp-glboot')
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
  window.__gl = { upload: [], texParam: [], genmip: 0, alloc: [] }
  const NAME = {}
  const patch = (proto) => {
    if (!proto) return
    const names = ['NEAREST','LINEAR','NEAREST_MIPMAP_NEAREST','LINEAR_MIPMAP_NEAREST','NEAREST_MIPMAP_LINEAR','LINEAR_MIPMAP_LINEAR','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','TEXTURE_WRAP_S','TEXTURE_WRAP_T']
    const it = proto
    const ot = it.texImage2D
    const og = it.generateMipmap
    const op = it.texParameteri
    if (ot) it.texImage2D = function (t, lvl, ifmt, w, h) { if (window.__gl.upload.length < 40) window.__gl.upload.push('L' + lvl + ' ' + w + 'x' + h); return ot.apply(this, arguments) }
    if (og) it.generateMipmap = function () {
      window.__gl.genmip += 1
      const t = arguments[0]
      const min = this.getTexParameter ? this.getTexParameter(t, this.TEXTURE_MIN_FILTER) : null
      if (window.__gl.alloc.length < 40) window.__gl.alloc.push('genmip min=' + min)
      return og.apply(this, arguments)
    }
    if (op) it.texParameteri = function (t, p, v) {
      if (window.__gl.texParam.length < 60) {
        let label = String(p)
        const c = this
        if (p === c.TEXTURE_MIN_FILTER) label = 'MIN_FILTER'
        else if (p === c.TEXTURE_MAG_FILTER) label = 'MAG_FILTER'
        else if (p === c.TEXTURE_WRAP_S) label = 'WRAP_S'
        else if (p === c.TEXTURE_WRAP_T) label = 'WRAP_T'
        let vv = String(v)
        if (p === c.TEXTURE_MIN_FILTER || p === c.TEXTURE_MAG_FILTER) {
          vv = v === c.LINEAR ? 'LINEAR' : v === c.NEAREST ? 'NEAREST'
            : v === c.LINEAR_MIPMAP_LINEAR ? 'LINEAR_MIPMAP_LINEAR'
            : v === c.LINEAR_MIPMAP_NEAREST ? 'LINEAR_MIPMAP_NEAREST'
            : v === c.NEAREST_MIPMAP_LINEAR ? 'NEAREST_MIPMAP_LINEAR'
            : v === c.NEAREST_MIPMAP_NEAREST ? 'NEAREST_MIPMAP_NEAREST' : String(v)
        }
        window.__gl.texParam.push(label + '=' + vv)
      }
      return op.apply(this, arguments)
    }
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype)
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype)
  return 'patched'
})()`
await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT })
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(4000)
console.log('BOOT GL:', await ev('JSON.stringify(window.__gl)'))
// Model-level LOD state: how many LOD textures were created?
console.log('model:', await ev(`JSON.stringify((()=>{
  const stage = document.querySelector('[data-dsh-live2d-pet] [data-stage]')
  const canvas = stage.querySelector('canvas')
  const r = canvas.getBoundingClientRect()
  return { canvas: [canvas.width, canvas.height], css: [Math.round(r.width), Math.round(r.height)] }
})())`))
ws.close(); edge.kill(); process.exit(0)
