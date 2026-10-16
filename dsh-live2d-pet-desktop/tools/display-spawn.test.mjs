// 显示层：**拉起 / 收掉子进程**那半区的回归（真 spawn、真子进程；不需要 DSH、不需要窗口）。
//
// 与 `display.test.mjs` 的分工：那份钉的是纯函数（与 Rust 侧同一张真值表），
// 这份钉的是"真起一个进程"才验得到的事：进程起不来会怎样、地址变了会不会重拉。
//
//   node --test tools/display-spawn.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'
import { createDisplayLayer, writePreference } from '../../dsh-live2d-pet/lib/display.js'

const tempHome = (tag) => {
  const path = join(DESKTOP, '.run', 'display-spawn-test-' + tag + '-' + process.pid)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  return path
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等某个条件成立；超时就返回 false，让断言去报（比在这里抛更好读）。 */
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(25)
  }
  return check()
}

/**
 * 造一只"壳"：记下自己被用哪个地址拉起来，然后像真壳那样刷心跳，直到被收掉。
 *
 * 用 `sh` 而不是自己实现一个假模块：`start()` 走的就是 `spawn(binary.path, …)`，
 * 这条路上"被拉起来的到底是不是可执行文件""杀掉之后心跳还刷不刷"都是被测行为的一部分。
 * 所以只在类 Unix 上跑（Windows 那边既没有 Unix 执行位，也没有 `sh`）。
 */
function writeFakeShell(dir) {
  const seen = join(dir, 'seen-argv.txt')
  const heartbeat = join(dir, 'pet-desktop.json')
  const path = join(dir, 'fake-desktop.sh')
  writeFileSync(path, [
    '#!/bin/sh',
    'printf "%s\\n" "$2" >> ' + JSON.stringify(seen),
    'while true; do',
    '  printf \'{"mode":"desktop","desktopPid":%s,"at":%s}\' "$$" "$(date +%s)000" > ' + JSON.stringify(heartbeat),
    '  sleep 0.2',
    'done',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return {
    path,
    heartbeat,
    urls: () => (existsSync(seen) ? readFileSync(seen, 'utf8').split('\n').filter((line) => line !== '') : []),
  }
}

test('spawn 起不来不会掀翻宿主 —— 它只是"这次没起来"', async () => {
  const home = tempHome('spawn-enoent')
  const notes = []
  const layer = createDisplayLayer({
    home,
    // 二进制不在（ENOENT）。没有 `'error'` 监听者时，这一条会让**整个 node --test
    // 进程**当场退出（未捕获异常）—— 那正是 DSH 里的"宿主没了"。
    resolveBinary: () => ({ path: join(home, '没有这个二进制'), source: 'test', size: 9 * 1024 * 1024 }),
    log: (message) => notes.push(message),
  })
  writePreference(home, { mode: 'desktop' })

  assert.equal(layer.reconcile().mode, 'desktop')
  assert.equal(await until(() => notes.some((m) => m.includes('spawn error'))), true,
    '应记下 spawn 失败：' + JSON.stringify(notes))
  assert.equal(layer.status().desktopRunning, false, '没起来就是没起来，不能报"在跑"')
  rmSync(home, { recursive: true, force: true })
})

test('缺执行位（EACCES）也只是提示，不再扳倒宿主', {
  skip: process.platform === 'win32' ? 'Windows 没有 Unix 执行位，这条没有意义' : false,
}, async () => {
  const home = tempHome('spawn-eacces')
  const binary = join(home, 'not-executable')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o644) // ← 发布物里那个 644 的等价物
  const notes = []
  const layer = createDisplayLayer({
    home,
    resolveBinary: () => ({ path: binary, source: 'test', size: 9 * 1024 * 1024 }),
    log: (message) => notes.push(message),
  })
  writePreference(home, { mode: 'desktop' })

  layer.reconcile()
  assert.equal(await until(() => notes.some((m) => m.includes('spawn error') && m.includes('EACCES'))), true,
    '应记下 EACCES：' + JSON.stringify(notes))
  assert.equal(layer.status().desktopRunning, false)
  rmSync(home, { recursive: true, force: true })
})

test('DSH 地址报上来之后，挂错地址的那只壳会被收掉并按新地址重拉', {
  skip: process.platform === 'win32' ? '假壳是 sh 脚本' : false,
}, async () => {
  const home = tempHome('reattach')
  const shell = writeFakeShell(home)
  const layer = createDisplayLayer({
    home,
    resolveBinary: () => ({ path: shell.path, source: 'test', size: 9 * 1024 * 1024 }),
    log: () => {},
  })

  // `lib/index.js` 里那个每秒一次的 tick；这里拨快一点，省测试时间。
  layer.setMode('desktop')
  // 页面还没报过地址 —— 只能拿兜底值起来。
  const timer = setInterval(() => layer.reconcile(), 100)
  try {
    assert.equal(await until(() => shell.urls().length >= 1), true, '壳应该被拉起来了')
    assert.deepEqual(shell.urls(), ['http://127.0.0.1:3080'], '页面还没报过之前，用兜底地址')

    layer.setDshUrl('http://127.0.0.1:43129') // ← `/layer` 那条路把真实地址报上来
    assert.equal(await until(() => shell.urls().includes('http://127.0.0.1:43129'), 10000), true,
      '地址变了之后应该重拉，实际只见到：' + JSON.stringify(shell.urls()))
    assert.deepEqual(shell.urls(), ['http://127.0.0.1:3080', 'http://127.0.0.1:43129'],
      '收掉旧的、按新地址重拉一只，不能拉成风暴')
  } finally {
    clearInterval(timer)
    layer.stop()
    await sleep(300)
    rmSync(home, { recursive: true, force: true })
  }
})
