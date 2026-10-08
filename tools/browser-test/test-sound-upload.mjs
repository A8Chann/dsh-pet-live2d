// 上传音频宿主路由：用私有 HOME + 随机回环端口验证路径、类型、大小和恢复默认。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { once } from 'node:events'
import { buildRoutes } from '../../dsh-live2d-pet/lib/index.js'
import { PLUGIN } from './paths.mjs'

const home = mkdtempSync(join(tmpdir(), 'pet-sound-upload-'))
const root = realpathSync(home)
assert(root.startsWith(realpathSync(tmpdir()) + sep), '只清理由本探针创建的临时 HOME')
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const routes = buildRoutes(undefined, undefined, home)
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const route = routes.find((item) => item.kind === 'exact' ? pathname === item.path
    : pathname.startsWith(item.path + '/'))
  if (route) void route.handler(request, response)
  else { response.writeHead(404); response.end() }
})
const wav = Buffer.alloc(46)
wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(2, 40)
const soundPath = '/api/live2d-pet/sound/ds-whale-girl/done'

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, options) => fetch(base + path, options)
  const post = (path, value, headers = {}) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  })

  const initial = await (await request('/api/live2d-pet/sound/ds-whale-girl')).json()
  assert.deepEqual(initial.sounds, {}, '未上传时只使用宠物默认音符')
  const saved = await post(soundPath, { base64: wav.toString('base64') })
  assert.equal(saved.status, 200, '有效 WAV 可上传')
  const status = await (await request('/api/live2d-pet/sound/ds-whale-girl')).json()
  assert.equal(status.sounds.done.mime, 'audio/wav')
  assert.equal(status.sounds.done.bytes, wav.length)
  assert.match(status.sounds.done.token, /^[a-f0-9]{64}$/)
  const audio = await request(status.sounds.done.url)
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  assert.equal(audio.headers.get('cache-control'), 'no-store')
  assert.equal(audio.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav)
  const failedPath = '/api/live2d-pet/sound/ds-whale-girl/failed'
  assert.equal((await post(failedPath, { base64: wav.toString('base64') })).status, 200)
  assert.equal((await post(failedPath, { action: 'reset' })).status, 200)
  assert.ok((await (await request('/api/live2d-pet/sound/ds-whale-girl')).json()).sounds.done,
    '移除 failed 不会删掉同一宠物的 done')
  const other = await (await request('/api/live2d-pet/sound/not-installed')).json()
  assert.equal(other.error, 'not-found', '未知宠物没有音频')
  assert.equal((await request('/api/live2d-pet/sound/ds-whale-girl/failed/extra')).status, 404,
    '不接受额外路径片段')
  assert.equal((await post(soundPath, { base64: Buffer.from('not audio').toString('base64') })).status, 400,
    '不是音频的字节不能覆盖已有音频')
  assert.equal((await post(soundPath, { base64: Buffer.alloc(1024 * 1024 + 1, 1).toString('base64') })).status, 400,
    '文件超过 1 MB 不接受')
  assert.equal((await post(soundPath, { base64: 'A'.repeat(2 * 1024 * 1024 + 1) })).status, 413,
    '请求体超过上限明确回 413')
  assert.equal((await post(soundPath, { base64: wav.toString('base64') }, { origin: 'https://evil.example' })).status, 403,
    '跨源页面不能写本地音频')
  assert.equal((await post(soundPath, { base64: wav.toString('base64') }, {
    host: `evil.example:${server.address().port}`, origin: `http://evil.example:${server.address().port}`,
  })).status, 403, 'Host 和 Origin 都伪装成重绑定域名仍被拒绝')
  assert.equal((await request(soundPath, { method: 'POST', body: JSON.stringify({ base64: wav.toString('base64') }) })).status, 415,
    '上传要求 JSON 请求头')
  assert.deepEqual(Buffer.from(await (await request(soundPath)).arrayBuffer()), wav,
    '上传失败不会覆盖已有文件')
  assert.equal((await post(soundPath, { action: 'reset' })).status, 200)
  assert.equal((await request(soundPath)).status, 404, '移除后恢复宠物音符')
  assert.equal((await (await request('/api/live2d-pet/sound/ds-whale-girl')).json()).sounds.done, undefined)
  // 目录软链不许成为任意文件的读写通道。
  const soundDir = join(home, 'pet-sounds')
  assert.equal(realpathSync(soundDir), join(root, 'pet-sounds'), '只替换本测试的空音频目录')
  rmdirSync(soundDir)
  symlinkSync(PLUGIN, soundDir, 'dir')
  assert.equal((await post(soundPath, { base64: wav.toString('base64') })).status, 500)
  assert.equal((await request(soundPath)).status, 404)
  console.log('PASS: audio upload, read, per-pet status, reset, rejection, symlink fence')
} finally {
  await new Promise((done) => server.close(done))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  assert.equal(realpathSync(home), root, '只清理当前测试持有的 HOME')
  rmSync(root, { recursive: true, force: true })
}
