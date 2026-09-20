// Verification server: mounts the plugin's REAL route table on a plain node
// http server, plus a minimal page that stands in for the DSH shell (React UMD
// + a fake __ModuleLoader__). Nothing here ships; it exists so the plugin can
// be driven end-to-end from a headless browser.
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HERE, PLUGIN } from './paths.mjs'

const PORT = Number(process.argv[2] ?? 8793)

// Load the plugin's host half straight from source, so the server always tests
// the working tree rather than a copy.
const host = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
const { buildRoutes, ActivityHub, attachActivityEvents } = host

// The harness stands in for the DSH host, so it owns the activity hub too.
//
// It supplies a REAL (if tiny) event bus rather than a no-op ctx. That matters:
// with a stub, attachActivityEvents registered nothing and every phase test had
// to drive the hub through /__nudge, so the plugin's actual host-event wiring
// was never exercised — which is how a subscription to the non-existent
// 'tool/call' event survived a green suite while the pet ignored tool activity
// in the real DSH. The bus below lets /__emit fire the genuine event names.
const listeners = new Map()
const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
    return () => {
      const list = listeners.get(event) ?? []
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    }
  },
}
const emit = async (event, ...args) => {
  const out = []
  for (const handler of listeners.get(event) ?? []) out.push(await handler(...args))
  return out
}

const hub = new ActivityHub()
attachActivityEvents(bus, hub)

const routes = buildRoutes(hub)
const byPath = new Map(routes.filter((r) => r.kind === 'exact').map((r) => [r.path, r]))
const prefixes = routes.filter((r) => r.kind === 'prefix').sort((a, b) => b.path.length - a.path.length)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const pathname = url.pathname

  // A/B/C renderer comparison: ?variant=X swaps which client bundle the page
  // loads, so one checkout can exercise several builds.
  if (pathname === '/' || pathname === '/blank') {
    const variant = url.searchParams.get('variant')
    let page = readFileSync(join(HERE, 'index.html'), 'utf8')
    if (variant) page = page.replace('/plugins/dsh-live2d-pet/client.js', '/variants/client-' + variant + '.js')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  if (pathname === '/harness.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(join(HERE, 'harness.js')))
    return
  }
  if (pathname === '/react.js' || pathname === '/react-dom.js') {
    // Served from the harness' own dependencies, so no UMD copy is vendored.
    const rel = pathname === '/react.js'
      ? join('react', 'umd', 'react.development.js')
      : join('react-dom', 'umd', 'react-dom.development.js')
    const file = join(HERE, 'node_modules', rel)
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('missing ' + file + ' -- run npm install in tools/browser-test first.')
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(file))
    return
  }
  if (pathname === '/plugins/dsh-live2d-pet/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
    res.end(readFileSync(join(PLUGIN, 'lib', 'client.js')))
    return
  }
  if (pathname === '/index-before.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(join(HERE, 'index-before.html')))
    return
  }
  if (pathname.startsWith('/variants/')) {
    // The DBG variant is generated HERE, from the live client source, on every
    // request.
    //
    // It used to be a file on disk rebuilt by the suite runner, which meant any
    // driver run directly (or before the runner got to it) loaded a copy from
    // whenever it was last generated — and silently tested yesterday's code.
    // That trap has now cost two debugging sessions; generating it removes the
    // possibility rather than documenting it.
    if (pathname === '/variants/client-DBG.js') {
      const ANCHOR = '        model = loaded;\n        modelRef.current = loaded;'
      const HOOK = [
        '',
        '        if (typeof window !== "undefined") {',
        '          window.__PET_DBG = {',
        '            app,',
        '            get model() { return app.stage.children.find((c) => c.internalModel !== undefined) ?? null; },',
        '            get core() { const m = app.stage.children.find((c) => c.internalModel !== undefined); return m ? m.internalModel.coreModel : null; },',
        '          };',
        '        }',
      ].join('\n')
      const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
      if (!source.includes(ANCHOR)) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('client.js: variant anchor not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
      res.end(source.replace(ANCHOR, ANCHOR + HOOK))
      return
    }
    const file = join(HERE, pathname.slice(1))
    if (!existsSync(file)) { res.writeHead(404); res.end('missing ' + file); return }
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(readFileSync(file))
    return
  }
  if (pathname === '/__nudge') {
    const phase = url.searchParams.get('phase') || 'idle'
    if (phase === 'done') hub.celebrate()
    else hub.set(phase, '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(hub.snapshot().phase)
    return
  }

  // Fire a REAL DSH lifecycle event through the bus, so the plugin's own
  // subscriptions are what the assertions observe. Waterfall events get a
  // trailing next() so a handler that resumes the chain can be detected.
  if (pathname === '/__emit') {
    const event = url.searchParams.get('event') || ''
    const name = url.searchParams.get('name') || ''
    let resumed = false
    const next = async () => { resumed = true; return { kind: 'accept' } }
    const payload = event.startsWith('tools/')
      ? { name, callId: 'test-call', parent: undefined }
      : { status: name, agent: {} }
    const seen = listeners.get(event)
    const handlers = seen ?? []
    for (const handler of handlers) {
      try { await handler(payload, next) } catch (error) { console.error('emit ' + event + ': ' + error) }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ event, handlers: handlers.length, resumed, phase: hub.snapshot().phase }))
    return
  }

  const exact = byPath.get(pathname)
  if (exact !== undefined) { exact.handler(req, res); return }
  for (const route of prefixes) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) { route.handler(req, res); return }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('no route: ' + pathname)
})

server.listen(PORT, '127.0.0.1', () => console.log('test server on http://127.0.0.1:' + PORT))
