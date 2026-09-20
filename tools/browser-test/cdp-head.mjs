// Items #1 and #2 — 重锤出击 belongs to the head, and neither it nor 鲸鱼喷水
// may be picked as a random idle "摸鱼" animation.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady } from './ready.mjs'

const EDGE = browserPath()
const PORT = 9379
const PROFILE = join(PROFILES, '_cdp-head')
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
let nextId = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
await waitReady(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const attr = (n) => ev('(document.querySelector("[data-dsh-live2d-pet]")||{}).getAttribute?.(' + JSON.stringify(n) + ')')

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

// --- locate one head point and one non-head point on the character ---------
const probe = JSON.parse(await ev(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let head = null, body = null
  for (let iy = 0; iy < 64 && (head === null || body === null); iy++) {
    for (let ix = 0; ix < 64; ix++) {
      const lx = r.width * (ix + 0.5) / 64, ly = r.height * (iy + 0.5) / 64
      if (!c.hitsMask(lx, ly, r.width, r.height)) continue
      const isHead = c.hitsHead(lx, ly)
      if (isHead && head === null) head = { lx, ly }
      if (!isHead && body === null && iy > 40) body = { lx, ly }
    }
  }
  return JSON.stringify({ head, body, rect: { x: r.x, y: r.y, w: r.width, h: r.height } })
})()`))
check('the model yields a measurable head region', probe.head !== null, JSON.stringify(probe.head))
check('part of the character is NOT head', probe.body !== null, JSON.stringify(probe.body))

// --- tapping the head swings the hammer ------------------------------------
await ev('window.__dshLive2dPet.playIdle()')
await sleep(900)
await clickAt(probe.rect.x + probe.head.lx, probe.rect.y + probe.head.ly)
await sleep(1200)
check('a head tap plays 重锤出击', (await attr('data-motion')) === 'Hammer', 'data-motion=' + await attr('data-motion'))
check('a head tap blushes', (await ev('window.__dshLive2dPet.expressions().length')) > 0,
  'expressions=' + JSON.stringify(await ev('window.__dshLive2dPet.expressions()')))

// --- tapping the body must NOT swing the hammer ----------------------------
await ev('window.__dshLive2dPet.resetToRest()')
await sleep(1600)
await clickAt(probe.rect.x + probe.body.lx, probe.rect.y + probe.body.ly)
await sleep(1200)
const bodyMotion = await attr('data-motion')
check('a body tap does NOT play 重锤出击', bodyMotion !== 'Hammer', 'data-motion=' + bodyMotion)

// --- the fidget must never pick the interaction verbs ----------------------
const allowed = JSON.parse(await ev(`JSON.stringify((() => {
  const c = window.__dshLive2dPet
  const groups = Object.keys(c.groups())
  const out = {}
  for (const g of groups) out[g] = c.fidgetAllowed(g)
  return out
})())`))
check('摸鱼 may not play 重锤出击', allowed.Hammer === false, 'Hammer=' + allowed.Hammer)
check('摸鱼 may not play 鲸鱼喷水', allowed.SprayWater === false, 'SprayWater=' + allowed.SprayWater)
const idle = await ev('window.__dshLive2dPet.idleName()')
check('the idle loop itself is never a fidget', (await ev('window.__dshLive2dPet.fidgetAllowed(window.__dshLive2dPet.idleName())')) === true)
const pool = Object.keys(allowed).filter((g) => g !== idle && allowed[g])
check('a non-empty fidget pool remains', pool.length > 0, 'pool=' + JSON.stringify(pool))
check('the fidget pool excludes both verbs', !pool.includes('Hammer') && !pool.includes('SprayWater'), 'pool=' + JSON.stringify(pool))

const bad = results.filter(r => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
edge.kill()
// Give the socket a moment to finish closing. Calling process.exit() while it
// is mid-close trips a libuv assertion on Windows, and the suite keys off the
// exit code, so that teardown noise would be reported as a test failure.
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
