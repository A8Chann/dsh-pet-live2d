import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, BASE, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9453
const PROFILE = join(PROFILES, '_cdp-final')
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
await fetch(BASE + '/__nudge?phase=idle')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await sleep(4000)
const shotCanvas = async (name) => {
  const url = await ev('document.querySelector("[data-dsh-live2d-pet] canvas").toDataURL("image/png")')
  writeFileSync(join(SHOTS, 'done-') + name + '.png', Buffer.from(url.split(',')[1], 'base64'))
}
const st = () => ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")')
// Open the panel and the expressions tab for a full-UI capture.
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return 1})()')
await sleep(600)
await ev('(()=>{const t=document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button")[1];if(t)t.click();return 1})()')
await sleep(600)
const box = JSON.parse(await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})())'))
const s1 = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } })
writeFileSync(join(PLUGIN, 'docs', 'preview.png'), Buffer.from(s1.result.data, 'base64'))
console.log('preview captured; motion=', await st())
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return 1})()')
await sleep(500)
await ev('window.__dshLive2dPet.playOnce("OpenCase",0,{kind:"panel"})')
await sleep(2200); await shotCanvas('opencase-hold')
await ev('window.__dshLive2dPet.playOnce("SprayWater",0,{kind:"panel"})')
await sleep(350); await shotCanvas('spray')
await ev('window.__dshLive2dPet.playOnce("BubbleGum",0,{kind:"panel"})')
await sleep(1500); await shotCanvas('bubble')
for (let i=0;i<30;i++){ await sleep(500); if (await st() === 'idle') break }
await sleep(1200); await shotCanvas('bubble-restored')
console.log('done')
ws.close(); edge.kill(); process.exit(0)