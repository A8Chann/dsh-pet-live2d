import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9403
const PROFILE = join(PROFILES, '_cdp-ab')
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

const variants = [
  { key: 'before', url: BASE + '/index-before.html' },
  { key: 'after', url: BASE + '/' },
]
const out = {}
for (const v of variants) {
  const per = {}
  for (const size of [160, 220, 300, 420, 620]) {
    // Seed the persisted layout so both runs start at the identical size and
    // position (the pet is not interactive until we clear this).
    await send('Page.navigate', { url: BASE + '/blank' })
    await sleep(300)
    await ev('window.localStorage.setItem("dsh-live2d-pet.state.v1", ' + JSON.stringify(JSON.stringify({ size, right: 24, bottom: 0 })) + ')')
    await send('Page.navigate', { url: v.url })
    for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
    await sleep(3500)
    // Freeze animation so the two captures show the same pose.
    await ev('window.requestAnimationFrame = function () { return 0 }')
    await sleep(800)
    const box = await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();const c=document.querySelector("[data-dsh-live2d-pet] canvas");return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),backing:[c.width,c.height]}})())')
    if (box === undefined) { per[size] = 'MISSING'; continue }
    const parsed = JSON.parse(box)
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height, scale: 1 } })
    const file = join(SHOTS, 'ab-') + v.key + '-' + size + '.png'
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    per[size] = { file, backing: parsed.backing, css: parsed.width }
  }
  out[v.key] = per
}
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
