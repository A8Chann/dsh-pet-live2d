import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = Number(process.argv[3] ?? 9411)
const DPR = Number(process.argv[2] ?? 1)
const PROFILE = join(PROFILES, '_cdp-sharp')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', '--force-device-scale-factor=' + DPR, 'about:blank'], { stdio: 'ignore' })
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

const out = { requestedDpr: DPR, cases: [] }
for (const size of [160, 300, 500, 760]) {
  await send('Page.navigate', { url: BASE + '/blank' })
  await sleep(300)
  await ev('window.localStorage.setItem("dsh-live2d-pet.state.v1", ' + JSON.stringify(JSON.stringify({ size, right: 24, bottom: 0 })) + ')')
  await send('Page.navigate', { url: BASE + '/' })
  for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
  await sleep(2500)
  const g = JSON.parse(await ev('JSON.stringify((()=>{const c=document.querySelector("[data-dsh-live2d-pet] canvas");const r=document.querySelector("[data-dsh-live2d-pet]").getBoundingClientRect();return {backing:[c.width,c.height],css:[Math.round(r.width),Math.round(r.height)],dpr:window.devicePixelRatio}})())'))
  const expected = Math.round(size * Math.min(3, Math.max(2, g.dpr)))
  out.cases.push({ size, dpr: g.dpr, css: g.css, backing: g.backing, supersampled: g.backing[0] / g.css[0], minimumMet: g.backing[0] === expected })
}
out.allMinimumMet = out.cases.every((c) => c.minimumMet)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
