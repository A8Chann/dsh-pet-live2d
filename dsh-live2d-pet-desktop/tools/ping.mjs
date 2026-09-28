// 桌面端的自检工具：一次把"壳能不能连上 sidecar、宠物发没发现、页面判定函数在不在"
// 问清楚。不依赖 Tauri，也不依赖窗口——排查时能先把 half 摘出来单独看。
//
//   node tools/ping.mjs [http://127.0.0.1:8791]
const base = (process.argv[2] ?? process.env.PET_DESKTOP_URL ?? 'http://127.0.0.1:8791').replace(/\/$/, '')

const get = async (path) => {
  const response = await fetch(base + path)
  return { status: response.status, body: await response.text() }
}

const ping = await get('/__desktop/ping')
console.log('GET /__desktop/ping -> ' + ping.status)
console.log(ping.body)

const catalog = await get('/api/live2d-pet/catalog')
let pets = []
try {
  pets = JSON.parse(catalog.body).pets ?? []
} catch { /* 下面统一报 */ }
console.log('GET /api/live2d-pet/catalog -> ' + catalog.status + '，宠物 ' + pets.length + ' 只：' + pets.map((p) => p.id).join(', '))

const runtime = await get('/api/live2d-pet/runtime/live2dcubismcore.min.js')
console.log('GET Cubism Core -> ' + runtime.status + '（' + runtime.body.length + ' 字节）')

const first = pets[0]
if (first !== undefined) {
  // 目录里给的 modelUrl 已经是资产路由的绝对路径，直接拿它当路径用。
  const modelPath = new URL(first.modelUrl, base).pathname
  const model = await get(modelPath)
  console.log('GET ' + modelPath + ' -> ' + model.status + '（' + model.body.length + ' 字节）')
}

const probe = await fetch(base + '/__desktop/probe', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 5, y: 5 }),
})
console.log('POST /__desktop/probe -> ' + probe.status + ' ' + (await probe.text()))
