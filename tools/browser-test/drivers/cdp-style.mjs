import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9401
const PROFILE = join(PROFILES, '_cdp-style')
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
await sleep(6000)
console.log(await ev(`JSON.stringify((()=>{
  const c = document.querySelector('[data-dsh-live2d-pet] canvas')
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  // Reach the renderer through the vendor vendor: the model is on the stage.
  const v = window.__dshLive2dPetVendor
  const roots = v && v.Application && v.Application.__dshApp ? null : null
  return {
    ext: (() => { try { return !!gl.getExtension('EXT_texture_filter_anisotropic') } catch (e) { return 'err:' + e.message } })(),
    maxAniso: (() => { try { const e = gl.getExtension('EXT_texture_filter_anisotropic'); return e ? gl.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0 } catch (err) { return 'err' } })(),
  }
})())`))
// Find the app through the canvas' owner: pixi stores nothing on the canvas, so
// go through the model the plugin published.
console.log('model textures:', await ev(`JSON.stringify((()=>{
  const ctl = window.__dshLive2dPet
  const out = { hasCtl: !!ctl, keys: ctl ? Object.keys(ctl) : [] }
  return out
})())`))
ws.close(); edge.kill(); process.exit(0)
