// 声音库与气泡：数据形状、路由、CRUD、迁移 —— 纯 node，DSH_HOME 指向临时目录。
//
// 盯的是四类"只在真机上才看得出来"的问题：
//
//   1. 形状：`bubbles` 是"文本 + 声音 id"的卡片表；`voices` 是随包声音；
//      `soundLibrary` 是随包 + 用户的合并列表。三者形状错一处，面板就少一块。
//   2. 取字节：`/sound-file/<pet>/<id>` 对随包与用户声音都要给对 `audio/*`。
//      octet-stream 在 Chromium 靠嗅探能播、在 WebKit 不播。
//   3. CRUD：新增 / 替换 / 改名 / 删除；随包声音**不可删**（升级会重写宠物目录）。
//   4. 迁移：旧接口留下的 `<pet>--<phase>.audio` 要变成 `legacy-<phase>` 条目，
//      删文件后条目也要跟着消失。
//
//   node --test dsh-live2d-pet-desktop/tools/sound-library.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'pet-sound-library-'))
process.env.DSH_HOME = root

const { buildCatalog, buildRoutes } = await import('../../dsh-live2d-pet/lib/index.js')

/** 一帧合法的 MPEG1 Layer III（128 kbps / 44.1 kHz），够 `soundMime` 判真。 */
function mp3Bytes(tag) {
  const bytes = Buffer.alloc(600, 0)
  bytes[0] = 0xff
  bytes[1] = 0xfb
  bytes[2] = 0x90
  bytes[3] = 0x64
  bytes.write(String(tag ?? '').slice(0, 16), 8, 'latin1')
  return bytes
}

const VOICE_ONE = mp3Bytes('voice-one')
const LEGACY_DONE = mp3Bytes('legacy-done')

let petDir
let server
let base

test.before(async () => {
  petDir = join(root, 'pets', 'demo')
  mkdirSync(join(petDir, 'voice'), { recursive: true })
  mkdirSync(join(petDir, 'locale'), { recursive: true })
  writeFileSync(join(petDir, 'demo.model3.json'), JSON.stringify({
    FileReferences: { Moc: 'demo.moc3', Textures: ['textures/tex.png'] },
  }))
  writeFileSync(join(petDir, 'voice', 'a.mp3'), VOICE_ONE)
  writeFileSync(join(petDir, 'pet.json'), JSON.stringify({
    petManifestVersion: 2,
    id: 'demo',
    displayName: '测试宠物',
    renderer: 'live2d',
    live2d: {
      model: 'demo.model3.json',
      // 老字段还在：缺省的 bubbles 键应当由它派生。
      lines: { greet: ['你好', '在的'], click: ['点我'], phase: { done: '搞定' } },
      voices: [
        { id: 'v-one', name: '问候一', file: 'voice/a.mp3' },
        { id: 'v-missing', name: '缺文件', file: 'voice/missing.mp3' },
      ],
      bubbles: {
        greet: [{ text: '你好呀', sound: 'v-one' }],
        phase: { done: { text: '', sound: null } },
      },
    },
  }))
  // 旧接口留下的相位音频：读库时应当被收编成 legacy-done。
  mkdirSync(join(root, 'pet-sounds'), { recursive: true })
  writeFileSync(join(root, 'pet-sounds', 'demo--done.audio'), LEGACY_DONE)

  const routes = buildRoutes({ snapshot: () => ({}) }, undefined, root)
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://pet.local').pathname
    const hit = routes.find((route) => route.kind === 'prefix'
      ? pathname === route.path || pathname.startsWith(route.path + '/')
      : pathname === route.path)
    if (hit === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    hit.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
})

test.after(() => {
  server?.close()
  rmSync(root, { recursive: true, force: true })
})

const json = async (path, init) => {
  const response = await fetch(base + path, init)
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}
const post = (path, body) => json(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const del = (path) => json(path, { method: 'DELETE' })

test('catalog：bubbles / voices / soundLibrary 三种形状都对', () => {
  const pet = buildCatalog().find((candidate) => candidate.id === 'demo')
  assert.ok(pet, '宠物没被扫到')
  // 显式 bubbles 覆盖 lines；没写的键由 lines 派生。
  assert.deepEqual(pet.bubbles.greet, [{ text: '你好呀', sound: 'v-one' }])
  assert.deepEqual(pet.bubbles.click, [{ text: '点我' }], '没写 bubbles 的键要由 lines 派生')
  assert.deepEqual(pet.bubbles.phase.done, { text: '', sound: null }, '相位可以只有声音/显式无声')
  // 随包声音只收真实存在的文件。
  assert.deepEqual(pet.voices, [{ id: 'v-one', name: '问候一', file: 'voice/a.mp3' }])
  const ids = pet.soundLibrary.map((sound) => sound.id)
  assert.deepEqual(ids, ['v-one', 'legacy-done'], '随包在前，旧上传被收编在后')
  assert.equal(pet.soundLibrary[0].builtin, true)
  assert.equal(pet.soundLibrary[1].builtin, false)
  assert.equal(pet.soundLibrary[1].phase, 'done')
})

test('随包声音与旧上传都能取到字节，且 content-type 是音频', async () => {
  for (const [id, bytes] of [['v-one', VOICE_ONE], ['legacy-done', LEGACY_DONE]]) {
    const response = await fetch(base + '/api/live2d-pet/sound-file/demo/' + id)
    assert.equal(response.status, 200, id)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg', id)
    assert.equal(Buffer.from(await response.arrayBuffer()).length, bytes.length, id)
  }
})

test('POST 新增 → 列表里出现 → 取字节一致 → 改名', async () => {
  const bytes = mp3Bytes('added')
  const created = await post('/api/live2d-pet/sounds/demo', {
    base64: bytes.toString('base64'),
    name: '我的音效',
  })
  assert.equal(created.status, 200)
  const added = created.payload.sounds.find((sound) => sound.name === '我的音效')
  assert.ok(added, '新增的声音没进列表')
  assert.equal(added.builtin, false)

  const fetched = await fetch(base + '/api/live2d-pet/sound-file/demo/' + added.id)
  assert.equal(fetched.status, 200)
  assert.equal(Buffer.from(await fetched.arrayBuffer()).length, bytes.length)
  assert.ok(existsSync(join(root, 'pet-sounds', 'demo--' + added.id + '.audio')))

  const renamed = await post('/api/live2d-pet/sounds/demo/' + added.id, { name: '改过名' })
  assert.equal(renamed.status, 200)
  assert.ok(renamed.payload.sounds.some((sound) => sound.id === added.id && sound.name === '改过名'))
})

test('POST 替换内容；DELETE 删除；随包声音不可删', async () => {
  const created = await post('/api/live2d-pet/sounds/demo', {
    base64: mp3Bytes('first').toString('base64'),
    name: '待替换',
  })
  const id = created.payload.sounds.find((sound) => sound.name === '待替换').id
  const replaced = await post('/api/live2d-pet/sounds/demo/' + id, {
    base64: mp3Bytes('second').toString('base64'),
  })
  assert.equal(replaced.status, 200)
  const bytes = Buffer.from(await (await fetch(base + '/api/live2d-pet/sound-file/demo/' + id)).arrayBuffer())
  assert.equal(bytes.subarray(8, 14).toString('latin1'), 'second', '替换后应当是新的内容')
  assert.equal(bytes.length, 600)

  const removed = await del('/api/live2d-pet/sounds/demo/' + id)
  assert.equal(removed.status, 200)
  assert.ok(!removed.payload.sounds.some((sound) => sound.id === id))
  assert.equal((await fetch(base + '/api/live2d-pet/sound-file/demo/' + id)).status, 404)
  assert.ok(!existsSync(join(root, 'pet-sounds', 'demo--' + id + '.audio')))

  assert.equal((await del('/api/live2d-pet/sounds/demo/v-one')).status, 403, '随包声音不能删')
})

test('非法容器、未知宠物、穿越路径都被拒', async () => {
  assert.equal((await post('/api/live2d-pet/sounds/demo', { base64: Buffer.from('not audio').toString('base64') })).status, 400)
  assert.equal((await post('/api/live2d-pet/sounds/ghost', { base64: mp3Bytes('x').toString('base64') })).status, 404)
  assert.equal((await fetch(base + '/api/live2d-pet/sound-file/demo/unknown.mp3')).status, 404)
  assert.equal((await fetch(base + '/api/live2d-pet/sound-file/demo/..%2Fpet.json')).status, 404)
  assert.equal((await post('/api/live2d-pet/sounds/demo', {})).status, 400)
})
