import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { browserPath, PROFILES, SHOTS } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9382
const URL_TO_OPEN = process.argv[2]
const PROFILE = join(PROFILES, '_cdp-shot')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 140; i++) { await sleep(500); if (await ev('document.querySelectorAll("[data-dsh-live2d-pet] canvas").length') > 0) break }
await sleep(4500)
// Enlarge the pet and open the expressions tab for a representative shot.
await ev(`(() => {
  const bs = Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-bar] button'))
  const plus = bs[bs.length - 1]
  plus.click(); plus.click()
  return true
})()`)
await sleep(1200)
await ev('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
await sleep(600)
await ev('(()=>{const t=document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button")[1];if(t)t.click();return true})()')
await sleep(800)
const s = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOTS, 'final-gui.png'), Buffer.from(s.result.data, 'base64'))
console.log('motion:', await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")'))
console.log('gaze:', await ev('document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-gaze")'))
console.log('size:', await ev('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})())'))
ws.close(); edge.kill(); process.exit(0)
