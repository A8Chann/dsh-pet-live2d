import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { join } from 'node:path'
const EDGE = browserPath()
const PORT = 9363
const PROFILE = join(PROFILES, '_cdp-phase')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map(); const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } return }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 250))
}
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await sleep(1500)

// Log every SSE frame the page receives.
await ev(`(() => {
  window.__frames = [];
  const ES = window.EventSource;
  window.EventSource = function (url) {
    const s = new ES(url);
    s.addEventListener('message', (e) => { window.__frames.push(e.data) });
    return s;
  };
  window.__frames.push('patched');
  return true;
})()`)
// Force the plugin to resubscribe by reloading after the patch is impossible,
// so instead read the phase the client currently reports and drive new nudges.
const read = async () => JSON.parse(await ev('JSON.stringify({phase: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-phase"), motion: document.querySelector("[data-dsh-live2d-pet]").getAttribute("data-motion")})'))
const nudge = async (p) => { await fetch(BASE + '/__nudge?phase=' + p) }

console.log('initial:', JSON.stringify(await read()))
for (const p of ['thinking', 'tool', 'failed', 'done']) {
  await nudge('idle'); await sleep(600)
  const seq = []
  await nudge(p)
  for (let i = 0; i < 14; i++) { seq.push(await read()); await sleep(150) }
  const phases = [...new Set(seq.map(s => s.phase))]
  const motions = [...new Set(seq.map(s => s.motion))]
  console.log(p, '-> phases', JSON.stringify(phases), 'motions', JSON.stringify(motions))
}
await nudge('idle'); await sleep(600)
console.log('final:', JSON.stringify(await read()))
console.log('logs:', JSON.stringify(logs.slice(0, 6)))
ws.close(); edge.kill(); process.exit(0)
