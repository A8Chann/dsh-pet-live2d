// 单测：Cubism Core 缺失时必须走官方 CDN 兜底（并把结果缓存到 runtimeDir）。
// 用 DSH_HOME 指向临时目录，避免碰用户真实的那份 Core。
import { buildRoutes } from '../../../dsh-live2d-pet/lib/index.js'

const routes = buildRoutes({ snapshot: () => ({ phase: 'idle' }), on: () => {}, emit: () => {} })
const route = routes.find((r) => String(r.path).endsWith('/runtime'))
if (route === undefined) { console.log('NO ROUTE'); process.exit(1) }

const url = '/api/live2d-pet/runtime/live2dcubismcore.min.js'
const res = {
  writeHead: (code, headers) => console.log('status=' + code + ' headers=' + JSON.stringify(headers ?? {})),
  end: (body) => {
    const bytes = body === undefined ? 0 : (ArrayBuffer.isView(body) ? body.length : Buffer.byteLength(String(body)))
    console.log('bodyBytes=' + bytes)
    if (bytes > 100000) console.log('PASS: 从官方 CDN 取到了 Core')
    else console.log('FAIL: ' + String(body).slice(0, 300))
  },
}
route.handler({ method: 'GET', url }, res)
await new Promise((r) => setTimeout(r, 15000))
console.log('cacheFile=' + (await import('node:fs')).existsSync(process.env.DSH_HOME + '/pets/.runtime/live2dcubismcore.min.js'))
