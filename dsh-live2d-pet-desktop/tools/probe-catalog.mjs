// **对拍驱动**：把 JS 版宿主半区与 Rust 版宿主半区放在一起，逐字段比 catalog、
// 逐字节比资产。
//
// 这条驱动是"翻实现"这个决定的前提：两份实现必然有分叉的风险，唯一的解药是**一个能自动
// 发现分叉的判据**。它跑两份真实的宿主：
//
//   * JS 版：node 直接跑 `dsh-live2d-pet/lib/index.js` 的 `buildRoutes()`（就是网页端
//     在用的那一份，一行没改），挂在临时端口上；
//   * Rust 版：当前壳里正在跑的那个宿主（端口从壳的进程上找）。
//
// 比什么：
//   1. catalog 的**每一个字段**（数组按下标比 —— 顺序会影响界面排序与抽签）；
//   2. 引用闭包里**每一个资产**的响应体（逐字节）；
//   3. 不在闭包里的路径必须被拒（安全边界，不能只有一边严）。
//
//   node tools/probe-catalog.mjs [--rust-port 57308] [--js-port 8811]
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PLUGIN } from './paths.mjs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const JS_PORT = Number(argOf('--js-port', '8811'))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

/** 找出壳正在监听的回环端口（Rust 版宿主）。 */
function findRustPort() {
  const explicit = argOf('--rust-port')
  if (explicit !== undefined) return Number(explicit)
  // 进程名按**产品名**找：便携 exe 与 cargo 产物名字不一样（`DSH桌宠` / `dsh-pet-live2d-desktop`）。
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$p = Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Select-Object -First 1;"
    + "if ($p) { (Get-NetTCPConnection -OwningProcess $p.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort }",
  ], { encoding: 'utf8' })
  const port = Number(String(output).trim())
  if (!Number.isFinite(port) || port === 0) {
    console.error('找不到壳的监听端口 —— 壳起来了吗？（进程名 DSH桌宠 或 dsh-pet-live2d-desktop）')
    process.exit(2)
  }
  return port
}

const RUST_PORT = findRustPort()
console.log('--- Rust 宿主端口 ' + RUST_PORT + '，JS 参照端口 ' + JS_PORT)

// ---------------------------------------------------------------- JS 参照宿主
const hostModule = await import('file:///' + join(PLUGIN, 'lib', 'index.js').replace(/\\/g, '/'))
const jsHub = new hostModule.ActivityHub()
hostModule.attachActivityEvents({ on() { throw new Error('no bus') } }, jsHub)
const jsRoutes = hostModule.buildRoutes(jsHub)
const jsExact = new Map(jsRoutes.filter((r) => r.kind === 'exact').map((r) => [r.path, r]))
const jsPrefix = jsRoutes.filter((r) => r.kind === 'prefix').sort((a, b) => b.path.length - a.path.length)
const jsServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://x').pathname
  for (const route of jsPrefix) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) {
      route.handler(request, response)
      return
    }
  }
  const route = jsExact.get(pathname)
  if (route !== undefined) {
    route.handler(request, response)
    return
  }
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => jsServer.listen(JS_PORT, '127.0.0.1', resolve))

const jsBase = 'http://127.0.0.1:' + JS_PORT
const rustBase = 'http://127.0.0.1:' + RUST_PORT

const getJson = async (base, path) => {
  const response = await fetch(base + path)
  return { status: response.status, body: await response.json().catch(() => null) }
}
const getBytes = async (base, path) => {
  const response = await fetch(base + path)
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
}

// ---------------------------------------------------------------- 1. catalog
const jsCatalog = await getJson(jsBase, '/api/live2d-pet/catalog')
const rustCatalog = await getJson(rustBase, '/api/live2d-pet/catalog')
check('两侧 catalog 都能取到', jsCatalog.status === 200 && rustCatalog.status === 200,
  'js=' + jsCatalog.status + ' rust=' + rustCatalog.status)

/**
 * 递归 diff：返回一串"路径 → 两侧的值"。数组按**下标**比（顺序会影响界面排序与抽签）。
 *
 * 浮点给**相对容差**：Node 与 Rust 把同一个十进制小数读成 f64 时可能差 1 ULP
 * （实测 `0.20000004768371582` vs `…85`）。这些值最终写进 Live2D 参数，1e-9 的差别没有
 * 任何可观察后果，但断言不能因此松掉整数字段 —— 所以容差**只对非整数**开。
 */
const FLOAT_TOLERANCE = 1e-9
function diff(a, b, path = '', out = [], limit = 40) {
  if (out.length >= limit) return out
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path, js: a, rust: b })
      return out
    }
    if (a.length !== b.length) out.push({ path: path + '.length', js: a.length, rust: b.length })
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff(a[i], b[i], path + '[' + i + ']', out, limit)
    return out
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    for (const key of keys) {
      if (!(key in a)) out.push({ path: path + '.' + key, js: '(缺失)', rust: b[key] })
      else if (!(key in b)) out.push({ path: path + '.' + key, js: a[key], rust: '(缺失)' })
      else diff(a[key], b[key], path + '.' + key, out, limit)
      if (out.length >= limit) break
    }
    return out
  }
  if (typeof a === 'number' && typeof b === 'number' && !Number.isInteger(a) && !Number.isInteger(b)) {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1)
    if (Math.abs(a - b) / scale <= FLOAT_TOLERANCE) return out
    out.push({ path, js: a, rust: b })
    return out
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, js: a, rust: b })
  return out
}

const catalogDiff = diff(jsCatalog.body, rustCatalog.body)
check('catalog 逐字段相同', catalogDiff.length === 0,
  catalogDiff.length === 0 ? undefined : catalogDiff.length + ' 处不同，前几处：' + JSON.stringify(catalogDiff.slice(0, 6)))

// 形状摘要（红了的时候先看这个，比翻 diff 快）
const shape = (catalog) => (catalog?.pets ?? []).map((pet) => ({
  id: pet.id,
  slots: pet.expressionSlots?.length ?? 0,
  options: (pet.expressionSlots ?? []).reduce((sum, slot) => sum + slot.options.length, 0),
  motionGroups: pet.motions?.length ?? 0,
  motionItems: (pet.motions ?? []).reduce((sum, group) => sum + group.items.length, 0),
  expressions: pet.expressions?.length ?? 0,
  headParts: pet.headParts?.length ?? 0,
  tailParts: pet.tailParts?.length ?? 0,
  fidgetSlots: pet.fidgetSlots?.length ?? 0,
  lines: Object.keys(pet.lines ?? {}).length,
  phases: Object.keys(pet.looksByPhase ?? {}).length,
}))
console.log('  JS   形状：' + JSON.stringify(shape(jsCatalog.body)))
console.log('  Rust 形状：' + JSON.stringify(shape(rustCatalog.body)))

// ---------------------------------------------------------------- 2. 资产
const jsPets = jsCatalog.body?.pets ?? []
let assetsCompared = 0
let assetMismatch = 0
let firstMismatch = ''
for (const pet of jsPets) {
  // 闭包 = model3.json 里点名的每个文件 + 模型描述自己。JS 版不给闭包，所以这里
  // **从磁盘读一遍模型描述**（同一套规则），再逐个比响应体。
  const modelUrl = pet.modelUrl
  const modelResponse = await getBytes(jsBase, modelUrl)
  if (modelResponse.status !== 200) {
    console.log('  （JS 参照侧取不到模型描述：' + modelResponse.status + ' ' + modelUrl + '）')
    continue
  }
  const model3 = JSON.parse(modelResponse.bytes.toString('utf8'))
  const closure = new Set()
  const push = (raw) => { if (typeof raw === 'string' && raw) closure.add(raw) }
  const refs = model3.FileReferences ?? {}
  push(refs.Moc)
  for (const texture of refs.Textures ?? []) push(texture)
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) push(refs[key])
  for (const expression of refs.Expressions ?? []) push(expression.File)
  for (const list of Object.values(refs.Motions ?? {})) for (const motion of list ?? []) push(motion.File)

  const prefix = '/api/live2d-pet/asset/' + encodeURIComponent(pet.id) + '/'
  // 从 modelUrl 里取相对路径：前缀是 `/api/live2d-pet/asset/<id>/`，逐段是编码过的。
  closure.add(decodeURIComponent(modelUrl.split('/').slice(5).join('/')))
  for (const relative of closure) {
    const path = prefix + relative.split('/').map(encodeURIComponent).join('/')
    const [js, rust] = await Promise.all([getBytes(jsBase, path), getBytes(rustBase, path)])
    assetsCompared += 1
    const same = js.status === rust.status && js.bytes.equals(rust.bytes)
    if (!same) {
      assetMismatch += 1
      if (firstMismatch === '') {
        firstMismatch = relative + '（js ' + js.status + '/' + js.bytes.length + 'B vs rust ' + rust.status + '/' + rust.bytes.length + 'B）'
      }
    }
  }
}
check('引用闭包里每个资产逐字节相同', assetMismatch === 0,
  assetsCompared + ' 个文件里 ' + assetMismatch + ' 个不同' + (firstMismatch === '' ? '' : '，首个：' + firstMismatch))

// ---------------------------------------------------------------- 3. 白名单
const petId = jsPets[0]?.id ?? 'ds-whale-girl'
const outside = [
  '/api/live2d-pet/asset/' + petId + '/pet.json',
  '/api/live2d-pet/asset/' + petId + '/../../../pet.json',
  '/api/live2d-pet/asset/' + petId + '/%2e%2e/pet.json',
]
let refused = 0
for (const path of outside) {
  const [js, rust] = await Promise.all([getBytes(jsBase, path), getBytes(rustBase, path)])
  if (js.status >= 400 && rust.status >= 400) refused += 1
  else console.log('  （' + path + '：js=' + js.status + ' rust=' + rust.status + '）')
}
check('闭包外的路径两侧都拒绝', refused === outside.length, refused + '/' + outside.length)

// ---------------------------------------------------------------- 4. 运行时文件
for (const [label, path] of [
  ['vendor 分包', '/api/live2d-pet/runtime/live2d-vendor.js'],
  ['Cubism Core', '/api/live2d-pet/runtime/live2dcubismcore.min.js'],
]) {
  const rust = await getBytes(rustBase, path)
  check(label + ' 有人发（' + path + '）', rust.status === 200 && rust.bytes.length > 1000,
    rust.status + ' / ' + rust.bytes.length + 'B')
}

// ---------------------------------------------------------------- 5. 事件流
// 页面靠 `/api/live2d-pet/events` 拿相位，两边都必须是 SSE 且首帧带 snapshot。
const sseProbe = async (base) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(base + '/api/live2d-pet/events', { signal: controller.signal })
    const type = response.headers.get('content-type') ?? ''
    const reader = response.body.getReader()
    const { value } = await reader.read()
    reader.cancel().catch(() => {})
    const first = Buffer.from(value ?? []).toString('utf8')
    return { status: response.status, type, first }
  } catch {
    return { status: 0, type: '', first: '' }
  } finally {
    clearTimeout(timer)
  }
}
const [jsSse, rustSse] = await Promise.all([sseProbe(jsBase), sseProbe(rustBase)])
const sseOk = (sse) => sse.status === 200 && sse.type.includes('text/event-stream') && sse.first.startsWith('data: ') && sse.first.includes('"phase"')
check('两侧的相位流都是 SSE 且首帧带 snapshot', sseOk(jsSse) && sseOk(rustSse),
  'js=' + jsSse.status + '/' + jsSse.type + ' rust=' + rustSse.status + '/' + rustSse.type)

jsServer.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('CATALOG ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length
  + '（资产对了 ' + assetsCompared + ' 个）')
process.exit(failed.length === 0 ? 0 : 1)
