import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9409
const PROFILE = join(PROFILES, '_cdp-fair')
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

for (const v of ['A', 'B', 'C']) {
  for (const size of [160, 300, 500]) {
    await send('Page.navigate', { url: BASE + '/blank' })
    await sleep(300)
    await ev('window.localStorage.setItem("dsh-live2d-pet.state.v1", ' + JSON.stringify(JSON.stringify({ size, right: 24, bottom: 0 })) + ')')
    await send('Page.navigate', { url: BASE + '/?variant=' + v })
    for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
    await sleep(3500)
    console.log('errors:', await ev('JSON.stringify(window.__errors || [])'), 'hint:', await ev('JSON.stringify((()=>{const n=document.querySelector("[data-dsh-live2d-pet] [data-hint]");return n?n.textContent:null})())'))
    await ev('window.requestAnimationFrame = function () { return 0 }')
    await sleep(600)
    const g = await ev('JSON.stringify((()=>{const c=document.querySelector("[data-dsh-live2d-pet] canvas");const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return {backing:[c.width,c.height],css:[Math.round(r.width),Math.round(r.height)],x:Math.round(r.x),y:Math.round(r.y),dpr:window.devicePixelRatio}})())')
    const box = JSON.parse(g)
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.css[0], height: box.css[1], scale: 1 } })
    writeFileSync(join(SHOTS, 'fair-') + v + '-' + size + '.png', Buffer.from(shot.result.data, 'base64'))
    console.log('wrote', v, size, JSON.stringify(box))
  }
}
ws.close(); edge.kill(); process.exit(0)
