// 共享设置存档（`dsh-live2d-pet/lib/settings.js`）的单元测试。
//
// 这是"桌面端的设置与 DSH 里的设置没有同步"的落点：两端不是同一个 origin，localStorage
// 互不可见，所以共享状态必须放在一个两端都能读写的文件里。这里钉住它的规则：
//   * **合并写**：只动传进来的那几项（否则一个窗口保存调参会把另一个窗口的装扮擦掉）；
//   * `rev` 单调递增（页面靠它判断"我这份是不是旧的"）；
//   * 手改坏的存档**不传染**给页面（非对象项直接忽略）。
//
//   node tools/settings.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = join(import.meta.dirname, '..', '..', 'dsh-live2d-pet')
const { readSettings, writeSettings, settingsPath, SETTINGS_KEYS } =
  await import(pathToFileURL(join(PLUGIN, 'lib', 'settings.js')).href)

const freshHome = () => mkdtempSync(join(tmpdir(), 'pet-settings-'))

test('空目录：读出来是空的，不报错', () => {
  const home = freshHome()
  const settings = readSettings(home)
  assert.equal(settings.tuning, null)
  assert.equal(settings.overrides, null)
  assert.equal(settings.outfit, null)
  assert.equal(settings.rev, 0)
})

test('写一项只动那一项（合并写）', () => {
  const home = freshHome()
  writeSettings(home, { tuning: { gazeRangePx: 300 } })
  writeSettings(home, { outfit: { glasses: '圆眼镜' } })
  const settings = readSettings(home)
  assert.deepEqual(settings.tuning, { gazeRangePx: 300 })
  assert.deepEqual(settings.outfit, { glasses: '圆眼镜' })
  assert.equal(settings.overrides, null)
})

test('rev 每次写入 +1（页面靠它判断新旧）', () => {
  const home = freshHome()
  const first = writeSettings(home, { tuning: { a: 1 } })
  const second = writeSettings(home, { tuning: { a: 2 } })
  assert.equal(first.rev, 1)
  assert.equal(second.rev, 2)
  assert.equal(readSettings(home).rev, 2)
})

test('只带 rev 的写不会推进版本号', () => {
  const home = freshHome()
  writeSettings(home, { tuning: { a: 1 } })
  const before = readSettings(home).rev
  writeSettings(home, { rev: before })
  assert.equal(readSettings(home).rev, before)
})

test('坏存档不传染：非对象项被忽略，其余照读', () => {
  const home = freshHome()
  writeFileSync(settingsPath(home), JSON.stringify({
    tuning: 'not-an-object',
    overrides: [1, 2, 3],
    outfit: { hair: '单边马尾' },
    rev: 7,
  }))
  const settings = readSettings(home)
  assert.equal(settings.tuning, null)
  assert.equal(settings.overrides, null)
  assert.deepEqual(settings.outfit, { hair: '单边马尾' })
  assert.equal(settings.rev, 7)
})

test('整个文件是垃圾也不崩', () => {
  const home = freshHome()
  writeFileSync(settingsPath(home), '{ 这不是 JSON')
  const settings = readSettings(home)
  for (const key of SETTINGS_KEYS) assert.equal(settings[key], null)
  assert.equal(settings.rev, 0)
})

test('写出来的文件人能看懂（缩进 JSON）', () => {
  const home = freshHome()
  writeSettings(home, { tuning: { gazeRangePx: 220 } })
  const text = readFileSync(settingsPath(home), 'utf8')
  assert.ok(text.includes('\n  "tuning"'), '应该是缩进 JSON，实际：' + text.slice(0, 60))
})

test('两个"窗口"轮流写，各自的项都还在（这就是跨 origin 同步的地基）', () => {
  const home = freshHome()
  // 窗口 A（DSH 页面）：改调参
  writeSettings(home, { tuning: { gazeRangePx: 400 } })
  // 窗口 B（桌面端）：改装扮
  writeSettings(home, { outfit: { claw: '魔爪' } })
  // 窗口 A 再改开关
  writeSettings(home, { overrides: { flags: { bubbleEnabled: false } } })
  const settings = readSettings(home)
  assert.deepEqual(settings.tuning, { gazeRangePx: 400 })
  assert.deepEqual(settings.outfit, { claw: '魔爪' })
  assert.deepEqual(settings.overrides, { flags: { bubbleEnabled: false } })
  assert.equal(settings.rev, 3)
})
