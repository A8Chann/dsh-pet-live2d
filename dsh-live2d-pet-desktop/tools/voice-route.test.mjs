// 语音：台词文本 → 音频文件的索引，以及服务它的路由 —— 纯 node，不需要浏览器，
// 也不碰真实的 ~/.dsh（DSH_HOME 指向临时目录）。
//
// 盯的是三个**只会以"点了没声音"这种形式出现**的问题：
//
//   1. 文本与文件名的对应（按位置配对：`lines.greet[0]` ↔ `greet-1.mp3`）。错位的
//      后果是"摸头播了点击的台词"，而画面上一切正常，极难发现；
//   2. 路由白名单。这里做错就是任意文件读取 —— 所以同时断言 `..` 与未登记名字被拒；
//   3. 索引只登记**真实存在**的文件：缺一条音频时，客户端应该保持安静，而不是去请求
//      一个必然 404 的地址；
//   4. 语言覆盖层（`locale/<lang>.json` 的 lines）也要指向同一段音频。漏了这条，
//      非中文界面就是"页签在、按钮有、永远没声"；
//   5. `content-type` 必须是 `audio/mpeg`。octet-stream 在 Chromium 上靠嗅探还能播，
//      在 WebKit 上直接不播 —— 只断言状态码和字节数是抓不到的。
//
//   node --test dsh-live2d-pet-desktop/tools/voice-route.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// dshHome() 每次调用都读 DSH_HOME，所以必须在 import 之前落好临时根。
const root = mkdtempSync(join(tmpdir(), 'pet-voice-route-'))
process.env.DSH_HOME = root

const { buildCatalog, buildRoutes } = await import('../../dsh-live2d-pet/lib/index.js')

const LINES = {
  greet: ['你好', '在的'],
  pat: ['好舒服', '再摸一下'],
  phase: { done: '搞定', failed: '出错' },
}

// 只放 greet-1/2、pat-1、phase-done 四个文件：pat-2 与 phase-failed 故意缺失，
// 用来验证"缺音频就不登记"。
const FILES = {
  'greet-1.mp3': 'greet-one',
  'greet-2.mp3': 'greet-two',
  'pat-1.mp3': 'pat-one',
  'phase-done.mp3': 'phase-done',
}

let petDir

test.before(() => {
  petDir = join(root, 'pets', 'demo')
  mkdirSync(join(petDir, 'voice'), { recursive: true })
  mkdirSync(join(petDir, 'locale'), { recursive: true })
  writeFileSync(join(petDir, 'demo.model3.json'), JSON.stringify({
    FileReferences: { Moc: 'demo.moc3', Textures: ['textures/tex.png'] },
  }))
  writeFileSync(join(petDir, 'pet.json'), JSON.stringify({
    petManifestVersion: 2,
    id: 'demo',
    displayName: '测试宠物',
    renderer: 'live2d',
    live2d: { model: 'demo.model3.json', lines: LINES },
  }))
  // 英文覆盖层：台词按**位置**对应到同一段中文配音（气泡说英文，声音是宠物的原声）。
  writeFileSync(join(petDir, 'locale', 'en.json'), JSON.stringify({
    lines: {
      greet: ['Hi', 'Still here'],
      pat: ['Feels nice', 'Again?'],
      phase: { done: 'Done!', failed: 'Uh oh' },
    },
  }))
  for (const [name, body] of Object.entries(FILES)) {
    writeFileSync(join(petDir, 'voice', name), body)
  }
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 按 catalog 里那一只宠物取 voice 路由的响应（serveFile 是异步的，等 end 被调用）。 */
function callVoice(routes, url) {
  const route = routes.find((candidate) => candidate.path.endsWith('/voice'))
  assert.ok(route, '语音路由没有注册')
  return new Promise((resolve) => {
    const response = {
      code: null,
      bytes: 0,
      headers: {},
      writeHead(code, headers) {
        this.code = code
        this.headers = headers ?? {}
      },
      end(body) {
        this.bytes = body === undefined || body === null ? 0 : body.length
        resolve(this)
      },
    }
    route.handler({
      url,
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }, response)
  })
}

test('索引按位置把台词配到文件，缺少音频的条目不登记', () => {
  const pet = buildCatalog().find((candidate) => candidate.id === 'demo')
  assert.ok(pet, '宠物没被扫到')
  assert.deepEqual(pet.voice, {
    '你好': 'greet-1.mp3',
    '在的': 'greet-2.mp3',
    '好舒服': 'pat-1.mp3',
    '搞定': 'phase-done.mp3',
    // 语言覆盖层：条件相同（文件存在）的才登记，且指向同一段音频。
    'Hi': 'greet-1.mp3',
    'Still here': 'greet-2.mp3',
    'Feels nice': 'pat-1.mp3',
    'Done!': 'phase-done.mp3',
  }, '英文台词要按位置映射到同一段配音（缺文件的 Again? / Uh oh 不登记）')
})

test('catalog 把索引下发给客户端', async () => {
  const routes = buildRoutes({ snapshot: () => ({}) }, undefined, root)
  const route = routes.find((candidate) => candidate.path.endsWith('/catalog'))
  const payload = await new Promise((resolve) => {
    const response = {
      code: null,
      body: '',
      writeHead(code) { this.code = code },
      end(body) { this.body = body; resolve(body) },
    }
    route.handler({ url: '/api/live2d-pet/catalog', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response)
  })
  const parsed = JSON.parse(String(payload))
  const pet = parsed.pets.find((candidate) => candidate.id === 'demo')
  assert.equal(pet.voice['好舒服'], 'pat-1.mp3')
})

test('登记过的文件按原始字节返回，且 content-type 是 audio/mpeg', async () => {
  const routes = buildRoutes({ snapshot: () => ({}) }, undefined, root)
  const response = await callVoice(routes, '/api/live2d-pet/voice/demo/pat-1.mp3')
  assert.equal(response.code, 200)
  assert.equal(response.bytes, readFileSync(join(petDir, 'voice', 'pat-1.mp3')).length)
  assert.equal(response.headers['content-type'], 'audio/mpeg',
    'octet-stream 在 Chromium 靠嗅探能播、在 WebKit 不播')
})

test('未登记的文件、未知宠物、路径穿越一律 404', async () => {
  const routes = buildRoutes({ snapshot: () => ({}) }, undefined, root)
  for (const url of [
    '/api/live2d-pet/voice/demo/pat-2.mp3',      // 台词在，音频缺失 ⇒ 没登记
    '/api/live2d-pet/voice/demo/../pet.json',    // 穿越
    '/api/live2d-pet/voice/ghost/greet-1.mp3',   // 不存在的宠物
    '/api/live2d-pet/voice/demo/unknown.mp3',
  ]) {
    const response = await callVoice(routes, url)
    assert.equal(response.code, 404, url + ' 应当 404')
  }
})
