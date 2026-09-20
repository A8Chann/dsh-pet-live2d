import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9407
const PROFILE = join(PROFILES, '_cdp-abc')
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

const variants = ['A', 'B', 'C']
for (const v of variants) {
  for (const size of [160, 300]) {
    // Serve the same page but swap which client bundle it loads by rewriting
    // the script tag through a request interception-free hook: we simply use a
    // tiny query the server maps to the variant.
    await send('Page.navigate', { url: BASE + '/blank' })
    await sleep(300)
    await ev('window.localStorage.setItem("dsh-live2d-pet.state.v1", ' + JSON.stringify(JSON.stringify({ size, right: 24, bottom: 0 })) + ')')
    await send('Page.navigate', { url: BASE + '/?variant=' + v })
    for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
    await sleep(3500)
    await ev('window.requestAnimationFrame = function () { return 0 }')
    await sleep(600)
    const url = await ev(`(() => {
      const src = document.querySelector('[data-dsh-live2d-pet] canvas')
      const c = document.createElement('canvas')
      const S = 6
      const sx = Math.round(src.width * 0.28), sy = Math.round(src.height * 0.16)
      const sw = Math.round(src.width * 0.30), sh = Math.round(src.height * 0.30)
      c.width = sw * S; c.height = sh * S
      const ctx = c.getContext('2d')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height)
      return c.toDataURL('image/png')
    })()`)
    if (typeof url !== 'string' || !url.startsWith('data:image/png')) { console.log(v, size, 'FAIL'); continue }
    writeFileSync(join(SHOTS, 'abc-') + v + '-' + size + '.png', Buffer.from(url.split(',')[1], 'base64'))
    console.log('wrote', v, size)
  }
}
ws.close(); edge.kill(); process.exit(0)
