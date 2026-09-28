// 惰性下载链路：tar 解析 → 落盘 → 解析器找得到。
//
// 为什么要有这个测试：这段代码**只在"用户没带上那份二进制"时才跑**，平时永远不会执行 ——
// 正是那种"写完就没再跑过、坏了也没人知道"的代码。而它一旦坏了，用户看到的又是
// "点了没反应"（那次投诉的形态）。
//
// 不联网：拿本地 `npm pack` 出来的**真 tarball**，用一个只认这一个路径的本地 http 服务器
// 喂给它（`registry` 可以覆盖，所以能指到本地）。
//
//   node tools/desktop-download.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DESKTOP } from './paths.mjs'
import {
  downloadDesktopBinary,
  readFileFromTar,
  resolveDesktopBinary,
} from '../../dsh-live2d-pet/lib/desktop.js'

const WORK = join(DESKTOP, '.run', 'desktop-download-test')
const SUB = join(DESKTOP, 'npm', 'desktop-win32-x64')

/**
 * 自己拼一个 tar.gz，**不依赖 npm**。
 *
 * 起初这里调 `npm pack`，但 `npm_execpath` 只有"由 npm 起的进程"才有 —— 直接
 * `node --test` 跑时它是 undefined，于是那条测试在本地永远失败（而它本该是随时可跑的）。
 * tar 的头格式很稳（512 字节块 + 八进制长度），自己写 30 行比引依赖划算，也让这个测试
 * 能在任何环境跑。
 */
function makeTarGz(entries) {
  const blocks = []
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')                       // name
    header.write('0000644\0', 100, 'utf8')              // mode
    header.write('0000000\0', 108, 'utf8')              // uid
    header.write('0000000\0', 116, 'utf8')              // gid
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8') // size
    header.write('00000000000\0', 136, 'utf8')          // mtime
    header.write('        ', 148, 'utf8')               // checksum 占位（空格）
    header.write('0', 156, 'utf8')                      // typeflag = 常规文件
    header.write('ustar\0', 257, 'utf8')                // magic
    header.write('00', 263, 'utf8')                     // version
    // 校验和：把整个头按字节求和（校验和字段本身当空格算）。
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024)) // 归档结束：两块全零
  return gzipSync(Buffer.concat(blocks))
}

/** 拿真 exe 的前 1MB 当内容：不用 9MB 全塞进内存，PE 头与长度校验都还在。 */
function fakeExeBody() {
  const real = join(SUB, 'bin', 'dsh-pet-live2d-desktop.exe')
  if (existsSync(real)) return readFileSync(real).subarray(0, 1024 * 1024)
  const stub = Buffer.alloc(256 * 1024, 7)
  stub.write('MZ', 0, 'latin1')
  return stub
}

const EXE_INNER_PATH = 'package/bin/dsh-pet-live2d-desktop.exe'
const VERSION = '0.0.0-test'


test('tar 解析器能从 tar.gz 里取出那个 exe（且不多取一个字节）', async () => {
  const body = fakeExeBody()
  const tgz = makeTarGz([
    ['package/package.json', Buffer.from(JSON.stringify({ name: 'x', version: VERSION }))],
    [EXE_INNER_PATH, body],
    ['package/README.md', Buffer.from('# 占位\n')],
  ])
  const { gunzipSync } = await import('node:zlib')
  const tar = gunzipSync(tgz)
  const exe = readFileFromTar(tar, EXE_INNER_PATH)
  assert.notEqual(exe, undefined, '没找到 exe —— 解析器或 tarball 结构变了')
  assert.equal(exe.subarray(0, 2).toString('latin1'), 'MZ', '取出来的不是 PE 可执行文件')
  assert.equal(exe.length, body.length, '取出来的长度和塞进去的不一致（切多了或切少了）')
  assert.ok(exe.equals(body), '取出来的内容与塞进去的不一致')
  // 找不存在的路径必须给 undefined，不能瞎给一块数据。
  assert.equal(readFileFromTar(tar, 'package/bin/nope.exe'), undefined)
  // 后面的条目不会被误当成 exe（名字匹配要精确）。
  assert.equal(readFileFromTar(tar, 'package/README.md').toString('utf8'), '# 占位\n')
})

test('downloadDesktopBinary 会把 exe 落到"我们自己管的那份"路径，且解析器随后找得到', async () => {
  const body = fakeExeBody()
  const tgz = makeTarGz([['package/package.json', Buffer.from('{}')], [EXE_INNER_PATH, body]])
  // 只认两件事：注册表元数据、以及任何 `.tgz`（**宽松匹配** —— 代码在元数据里找不到
  // 版本时会回落到"自己拼的 URL"，那时路径里带的是**真版本号**而不是夹具的假版本号）。
  let registry = ''
  const server = createServer((request, response) => {
    if (request.url.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tgz.length) })
      response.end(tgz)
      return
    }
    if (request.url.startsWith('/dsh-pet-live2d-desktop')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ versions: { [VERSION]: { dist: { tarball: registry + '/fake/-/x.tgz' } } } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = 'http://127.0.0.1:' + server.address().port

  const home = join(WORK, 'home')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })

  try {
    const result = await downloadDesktopBinary({ home, registry })
    assert.equal(result.ok, true, '下载失败：' + JSON.stringify(result))
    assert.ok(existsSync(result.path), '报了成功但文件不在：' + result.path)
    assert.equal(readFileSync(result.path).subarray(0, 2).toString('latin1'), 'MZ')
    assert.equal(result.bytes, body.length, '落盘的长度不对')

    // 解析器必须**不用重启**就找得到（它把 managedBinPath 排在子包之后）。
    const found = resolveDesktopBinary({ home })
    assert.notEqual(found, undefined, '下完了解析器还是找不到')
    assert.equal(found.source, 'managed', '来源应当是 managed，而不是别的路径')
  } finally {
    server.close()
  }
})

test('未压缩的 tar 也能吃（别赌响应头，按魔数认）', async () => {
  const body = fakeExeBody()
  // 同样的内容，去掉 gzip 那一层。
  const bare = gunzipSync(makeTarGz([
    ['package/package.json', Buffer.from('{}')],
    [EXE_INNER_PATH, body],
  ]))
  let registry = ''
  const server = createServer((request, response) => {
    if (request.url.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bare.length) })
      response.end(bare)
      return
    }
    if (request.url.startsWith('/dsh-pet-live2d-desktop')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ versions: { [VERSION]: { dist: { tarball: registry + '/x.tgz' } } } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = 'http://127.0.0.1:' + server.address().port
  const home = join(WORK, 'home-bare')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  try {
    const result = await downloadDesktopBinary({ home, registry })
    assert.equal(result.ok, true, '裸 tar 应当也能装：' + JSON.stringify(result))
    assert.equal(result.bytes, body.length)
  } finally {
    server.close()
  }
})

test('下载失败要如实报错，不能假装成功', async () => {  const server = createServer((request, response) => {
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const registry = 'http://127.0.0.1:' + server.address().port
  const home = join(WORK, 'home-fail')
  mkdirSync(home, { recursive: true })
  try {
    const result = await downloadDesktopBinary({ home, registry })
    assert.equal(result.ok, false, '404 必须报失败')
    assert.ok(['download-failed', 'extract-failed', 'binary-not-in-tarball'].includes(result.reason),
      '失败原因要说清楚，实际是：' + result.reason)
  } finally {
    server.close()
  }
})
