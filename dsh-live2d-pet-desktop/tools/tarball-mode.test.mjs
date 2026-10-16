// `check-tarball-mode.mjs` 的回归：**权限位判据本身**对不对。
//
// 为什么要单独测它：这条判据是"发布物对不对"的唯一防线，而它读的是 tar 头里三个字节的
// 八进制 —— 写错了会**静默放行**（我们刚吃过一次：644 的 darwin 子包一路发到用户手里）。
// 所以它自己也要有测试。
//
// 夹具是**现造**的 tar（不依赖 npm、不依赖平台）：Windows 上造不出带 Unix 权限位的真
// tarball，但手写 tar 头可以 —— 这正是能在这台机器上把"755 该过、644 该拦"都钉住的原因。
//
//   node --test tools/tarball-mode.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DESKTOP } from './paths.mjs'
import { formatMode, isExecutable, listTarEntries, readTarball } from './check-tarball-mode.mjs'

const WORK = join(DESKTOP, '.run', 'tarball-mode-test')

/**
 * 造一个 tar.gz，**每个条目自己带权限位**。
 *
 * 与 `desktop-download.test.mjs` 里那份的区别：那个把所有条目的 mode 写死成 `0000644`，
 * 而这里 mode 是参数 —— 这个测试要验的恰恰是"mode 读得对不对"。
 */
function makeTarGz(entries) {
  const blocks = []
  for (const [name, content, mode] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    // mode：8 字节八进制，以 NUL 结尾（`0000755\0`）。tar 的头格式里就是这么放的。
    header.write('0000' + mode.toString(8).padStart(3, '0') + '\0', 100, 'utf8')
    header.write('0000000\0', 108, 'utf8')  // uid
    header.write('0000000\0', 116, 'utf8')  // gid
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
    header.write('00000000000\0', 136, 'utf8') // mtime
    header.write('        ', 148, 'utf8')      // checksum 占位
    header.write('0', 156, 'utf8')             // typeflag
    header.write('ustar\0', 257, 'utf8')
    header.write('00', 263, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const setup = () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  return WORK
}

/** 跑 CLI，返回退出码与输出（判据的**对外契约**就是退出码）。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [join(DESKTOP, 'tools', 'check-tarball-mode.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

test('tar 头里的权限位读得对（755 可执行 / 644 不可执行）', () => {
  const work = setup()
  const body = Buffer.alloc(64 * 1024, 7)
  const path = join(work, 'mode-fixture.tgz')
  writeFileSync(path, makeTarGz([
    ['package/bin/tool', body, 0o755],
    ['package/bin/data', body, 0o644],
  ]))

  const entries = listTarEntries(readTarball(path))
  assert.equal(entries.length, 2)
  const tool = entries.find((e) => e.name === 'package/bin/tool')
  const data = entries.find((e) => e.name === 'package/bin/data')
  assert.equal(formatMode(tool.mode), '0755', '755 该读成 0755')
  assert.equal(isExecutable(tool.mode), true)
  assert.equal(formatMode(data.mode), '0644', '644 该读成 0644')
  assert.equal(isExecutable(data.mode), false)
  // 顺带钉住内容没被读错位（mode 字段紧挨着 name，错位会连内容一起错）。
  assert.equal(tool.body.length, body.length)
  assert.ok(tool.body.equals(body))
})

test('755 的 tarball：--expect-exec 通过（退出码 0）', () => {
  const work = setup()
  const path = join(work, 'good.tgz')
  writeFileSync(path, makeTarGz([
    ['package/bin/dsh-pet-live2d-desktop', Buffer.alloc(64 * 1024, 1), 0o755],
    ['package/package.json', Buffer.from('{}'), 0o644],
  ]))
  const result = runCli([path, '--expect-exec', 'package/bin/dsh-pet-live2d-desktop'])
  assert.equal(result.code, 0, '755 该放行，实际输出：' + result.out)
  assert.match(result.out, /TARBALL-MODE OK/)
})

test('644 的 tarball：--expect-exec **拦下来**（退出码 1）—— 这就是 3.3.1 发给用户的那一份', () => {
  const work = setup()
  const path = join(work, 'bad.tgz')
  writeFileSync(path, makeTarGz([
    ['package/bin/dsh-pet-live2d-desktop', Buffer.alloc(64 * 1024, 1), 0o644],
    ['package/package.json', Buffer.from('{}'), 0o644],
  ]))
  const result = runCli([path, '--expect-exec', 'package/bin/dsh-pet-live2d-desktop'])
  assert.equal(result.code, 1, '644 必须拦住，实际输出：' + result.out)
  assert.match(result.out, /TARBALL-MODE FAIL/)
  assert.match(result.out, /没有执行位/)
})

test('要的文件不在 tarball 里也拦（别把"没找到"当成"对了"）', () => {
  const work = setup()
  const path = join(work, 'missing.tgz')
  writeFileSync(path, makeTarGz([['package/package.json', Buffer.from('{}'), 0o644]]))
  const result = runCli([path, '--expect-exec', 'package/bin/dsh-pet-live2d-desktop'])
  assert.equal(result.code, 1, '找不到也该红：' + result.out)
  assert.match(result.out, /没有 package\/bin/)
})

test('Windows 的 .exe 子包：不传 --expect-exec 时不去管执行位（Windows 没有这一位）', () => {
  const work = setup()
  const path = join(work, 'win.tgz')
  writeFileSync(path, makeTarGz([
    ['package/bin/dsh-pet-live2d-desktop.exe', Buffer.alloc(64 * 1024, 1), 0o644],
  ]))
  const result = runCli([path])
  assert.equal(result.code, 0, '.exe 的 644 是正常的：' + result.out)
})

test('--expect-nonexec 反过来能拦（防"给不该可执行的东西加了执行位"）', () => {
  const work = setup()
  const path = join(work, 'weird.tgz')
  writeFileSync(path, makeTarGz([['package/README.md', Buffer.from('# x'), 0o755]]))
  const result = runCli([path, '--expect-nonexec', 'package/README.md'])
  assert.equal(result.code, 1, 'README 不该带执行位：' + result.out)
  assert.match(result.out, /不该有执行位/)
})

test('CLI **真的会执行**（不是静默跳过 → 假绿）', () => {
  // 这条是被自己咬过一次才加的：CLI 的自检原来手拼 `'file://' + argv[1]`，在 Windows 上
  // 与 `import.meta.url` 永不相等 ⇒ 整个 CLI 分支不执行、**退出码恒 0**。CI 靠退出码判断，
  // 于是"检查通过了"其实是"检查没跑"。所以除了退出码，还要断言它**真的打印了东西**。
  const work = setup()
  const path = join(work, 'cli-runs.tgz')
  writeFileSync(path, makeTarGz([['package/bin/tool', Buffer.alloc(64 * 1024, 3), 0o755]]))
  const result = runCli([path, '--expect-exec', 'package/bin/tool'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /TARBALL-MODE OK/, 'CLI 没输出结论 = 它根本没跑（假绿）')
  // 反面对照：坏的那份也必须真的走到 FAIL（同样证明 CLI 在跑）。
  const bad = join(work, 'cli-runs-bad.tgz')
  writeFileSync(bad, makeTarGz([['package/bin/tool', Buffer.alloc(64 * 1024, 3), 0o644]]))
  assert.match(runCli([bad, '--expect-exec', 'package/bin/tool']).out, /TARBALL-MODE FAIL/)
})
