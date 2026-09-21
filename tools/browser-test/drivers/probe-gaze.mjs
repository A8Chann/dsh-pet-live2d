// 探针：把指针放到若干个竖向位置，一次 eval 里同时读 gazeTarget / mouthFollow /
// mouthDebug，看"嘴的形状"到底跟什么对齐。
//
// 背景：cdp-gaze 的 lean 断言假设 fy=0.15 与 fy=0.85 对中性点是镜像的，
// 于是要求 form 对称；实测 up=+0.281 / down=-0.642。先量清楚几何。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9481
const PROFILE = join(PROFILES, '_probe-gaze')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: BASE + '/?variant=DBG' })
for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const geo = JSON.parse(await ev('JSON.stringify((() => { const el = document.querySelector("[data-dsh-live2d-pet]");'
  + ' const r = el.getBoundingClientRect();'
  + ' return { box: [r.x, r.y, r.width, r.height], vw: window.innerWidth, vh: window.innerHeight,'
  + '   canvas: (() => { const c = el.querySelector("canvas"); if (!c) return null; const q = c.getBoundingClientRect(); return [q.x, q.y, q.width, q.height] })() } })())'))
console.log('几何:', JSON.stringify(geo))

const readAll = async () => JSON.parse(await ev('JSON.stringify((() => { const p = window.__dshLive2dPet;'
  + ' return { target: p.gazeTarget(), follow: p.mouthFollow(), dbg: p.mouthDebug(),'
  + '   layers: p.expressionLayerCount(), release: p.releaseDebug().release } })())'))

const b = geo.box
for (const fy of [0.15, 0.3, 0.5, 0.7, 0.85]) {
  const x = Math.round(b[0] + b[2] * 0.5)
  const y = Math.round(b[1] + b[3] * fy)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const series = []
  for (let i = 0; i < 8; i += 1) { await sleep(250); series.push(await readAll()) }
  const last = series[series.length - 1]
  console.log('fy=' + fy.toFixed(2) + ' 像素 y=' + y + ' → ny=' + last.target.y.toFixed(3)
    + ' follow=' + last.follow.toFixed(3)
    + ' dbg=(' + last.dbg.open + ',' + last.dbg.form + ')'
    + ' | 序列 ' + series.map((s) => s.dbg.open.toFixed(2) + '/' + s.dbg.form.toFixed(2)).join(' '))
}
ws.close(); edge.kill(); await sleep(300); process.exit(0)
