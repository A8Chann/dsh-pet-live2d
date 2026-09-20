// CDP driver: load the pet, then verify animation, mouse tracking, the
// control panel, expressions and dragging — each from an observable signal.
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { browserPath, PROFILES, SHOTS } from './paths.mjs'
import { join } from 'node:path'

const EDGE = browserPath()
const PORT = 9335
const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:8791/'
const PREFIX = join(SHOTS, 'v')
const PROFILE = join(PROFILES, '_cdp-profile3')
rmSync(PROFILE, { recursive: true, force: true })

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + PROFILE,
  '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page
for (let i = 0; i < 80 && page === undefined; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    page = list.find((t) => t.type === 'page')
  } catch { /* not up */ }
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let nextId = 0
const pending = new Map()
const logs = []
const netFails = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined) { const s = pending.get(msg.id); if (s) { pending.delete(msg.id); s(msg) } return }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200))
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 400))
  if (msg.method === 'Network.loadingFailed') netFails.push(msg.params.errorText + ' (' + msg.params.type + ')')
}
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
const grab = async (name) => {
  const reply = await send('Page.captureScreenshot', { format: 'png' })
  const buffer = Buffer.from(reply.result.data, 'base64')
  writeFileSync(PREFIX + '-' + name + '.png', buffer)
  return { hash: createHash('sha1').update(buffer).digest('hex').slice(0, 10), bytes: buffer.length }
}
const rectOf = (selector) => evaluate('JSON.stringify((()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})())')

await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 240; i++) { await sleep(500); if (await evaluate('document.title') === 'done') break }

const out = {}
out.loaded = await evaluate(`JSON.stringify({
  petRoot: document.querySelectorAll('[data-dsh-live2d-pet]').length,
  container: document.querySelectorAll('[data-dsh-live2d-pet-root]').length,
  canvas: document.querySelectorAll('[data-dsh-live2d-pet] canvas').length,
  hint: (document.querySelector('[data-dsh-live2d-pet] [data-hint]')||{}).textContent || null,
  rootRect: (()=>{const e=document.querySelector('[data-dsh-live2d-pet]');if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})(),
})`)

// 1. idle animation: two screenshots a second apart must differ.
const a1 = await grab('a1'); await sleep(1100); const a2 = await grab('a2')
out.animating = a1.hash !== a2.hash

// 2. mouse tracking: park the pointer on opposite corners and compare frames.
const centre = JSON.parse(await evaluate('JSON.stringify((()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})())'))
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0] - 420, y: centre[1] - 260 })
await sleep(700)
const g1 = await grab('gaze-left')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0] + 420, y: centre[1] + 260 })
await sleep(700)
const g2 = await grab('gaze-right')
out.mouseTracking = g1.hash !== g2.hash

// 3. control panel
await evaluate('(()=>{const b=document.querySelector("[data-dsh-live2d-pet] [data-bar] button");if(b)b.click();return true})()')
await sleep(600)
out.panel = await evaluate(`JSON.stringify((()=>{
  const p = document.querySelector('[data-dsh-live2d-pet] [data-panel]')
  if (!p) return { open: false }
  const groups = Array.from(p.querySelectorAll('[data-group]'))
  return { open: true,
    tabs: Array.from(p.querySelectorAll('[data-tabs] button')).map(b=>b.textContent),
    groups: groups.length,
    motionLabels: groups.map(g=>g.querySelector('span').textContent),
    chips: p.querySelectorAll('[data-chips] button').length,
    panelRect: (()=>{const r=p.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})() }
})())`)
// panel must not run off the left edge of the viewport
out.panelOnScreen = await evaluate('(()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-panel]").getBoundingClientRect();return r.left >= 0})()')

// 4. motion chips
const beforeMotion = await grab('motion-before')
out.motionTools = await evaluate(`JSON.stringify((()=>{
  const chips = Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-panel] [data-chips] button'))
  const hammer = chips.find(c => false) // index-based below
  chips[1].click()
  return { total: chips.length, clicked: chips[1].textContent }
})())`)
await sleep(900)
const duringMotion = await grab('motion-during')
out.motionChangesFrame = beforeMotion.hash !== duringMotion.hash

// 5. expressions
await evaluate('(()=>{const t=document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button")[1];if(t)t.click();return true})()')
await sleep(500)
out.expressionPanel = await evaluate(`JSON.stringify((()=>{
  const p = document.querySelector('[data-dsh-live2d-pet] [data-panel]')
  const groups = Array.from(p.querySelectorAll('[data-group]'))
  return { groups: groups.length, categories: groups.map(g=>g.querySelector('span').textContent), chips: p.querySelectorAll('[data-chips] button').length }
})())`)
const beforeExpr = await grab('expr-before')
out.expressionClick = await evaluate(`JSON.stringify((()=>{
  const chips = Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-panel] [data-chips] button'))
  const target = chips.find(c => c.textContent === '爱心眼') || chips[0]
  target.click()
  return { clicked: target.textContent, total: chips.length }
})())`)
await sleep(1200)
const afterExpr = await grab('expr-after')
out.expressionChangesFrame = beforeExpr.hash !== afterExpr.hash
out.expressionState = await evaluate(`JSON.stringify({
  active: Array.from(document.querySelectorAll('[data-dsh-live2d-pet] [data-chips] button[data-on]')).map(b=>b.textContent),
  bubble: (document.querySelector('[data-dsh-live2d-pet] [data-bubble]')||{}).textContent || null,
})`)

// 6. drag
const dragStart = await rectOf('[data-dsh-live2d-pet]')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre[0], y: centre[1], button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 10; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0] - i * 30, y: centre[1] - i * 10, button: 'left', buttons: 1 })
  await sleep(50)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre[0] - 300, y: centre[1] - 100, button: 'left', buttons: 0, clickCount: 1 })
await sleep(600)
out.drag = { before: JSON.parse(dragStart), after: JSON.parse(await rectOf('[data-dsh-live2d-pet]')) }
out.dragMoved = out.drag.before[0] !== out.drag.after[0] || out.drag.before[1] !== out.drag.after[1]
out.stored = await evaluate('window.localStorage.getItem("dsh-live2d-pet.state.v1")')
await grab('dragged')

// 7. resize via the bar
await evaluate('(()=>{const bs=Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-bar] button"));const plus=bs[bs.length-1];plus.click();plus.click();return true})()')
await sleep(900)
out.resized = await rectOf('[data-dsh-live2d-pet]')
await grab('resized')

// 8. reload persistence
await send('Page.navigate', { url: URL_TO_OPEN })
for (let i = 0; i < 240; i++) { await sleep(500); if (await evaluate('document.title') === 'done') break }
out.afterReload = await rectOf('[data-dsh-live2d-pet]')

out.logs = logs.slice(-6)
out.netFails = netFails.slice(0, 8)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); process.exit(0)
