// 显示层：**拉起 / 收掉子进程**那半区的回归（真 spawn、真子进程；不需要 DSH、不需要窗口）。
//
// 与 `display.test.mjs` 的分工：那份钉的是纯函数（与 Rust 侧同一张真值表），
// 这份钉的是"进程真的起不来"时会发生什么 —— 那种事只有真起一个进程才验得到。
//
//   node --test tools/display-spawn.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
