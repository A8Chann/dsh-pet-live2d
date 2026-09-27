// 显示层：宿主半区那几个纯函数的单元测试（不需要 DSH、不需要窗口）。
//
// 与 Rust 侧 `src-tauri/src/host/display.rs` 的 `#[cfg(test)]` **同一张真值表** ——
// 判定规则是两边各有一份实现，唯一能防分叉的办法就是两边钉同样的用例。
//
//   node --test tools/display.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'
import {
  HEARTBEAT_TTL_MS,
  computeOwner,
  desktopProcessState,
  heartbeatFresh,
  normaliseMode,
  readPreference,
  writePreference,
} from '../../dsh-live2d-pet/lib/display.js'

const tempHome = (tag) => {
  const path = join(DESKTOP, '.run', 'display-test-' + tag + '-' + process.pid)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  return path
}

test('判定规则是真值表 —— 两端必须一致', () => {
  // 心跳新鲜：mode 不是 inline 就是桌面端
  assert.equal(computeOwner('auto', true), 'desktop')
  assert.equal(computeOwner('desktop', true), 'desktop')
  assert.equal(computeOwner('inline', true), 'inline')
  // 心跳不新鲜：一律回到页面内
  assert.equal(computeOwner('auto', false), 'inline')
  assert.equal(computeOwner('desktop', false), 'inline')
  assert.equal(computeOwner('inline', false), 'inline')
})

test('mode 会规范化，认不出来就当 auto', () => {
  assert.equal(normaliseMode('desktop'), 'desktop')
  assert.equal(normaliseMode('inline'), 'inline')
  assert.equal(normaliseMode('auto'), 'auto')
  assert.equal(normaliseMode('banana'), 'auto')
  assert.equal(normaliseMode(42), 'auto')
  assert.equal(normaliseMode(undefined), 'auto')
})

test('心跳按 TTL 过期', () => {
  const now = 1_000_000
  assert.equal(heartbeatFresh({ desktopPid: 42, at: now - 1000 }, now), true)
  assert.equal(heartbeatFresh({ desktopPid: 42, at: now - HEARTBEAT_TTL_MS - 1 }, now), false)
  assert.equal(heartbeatFresh({ desktopPid: 0, at: now }, now), false, '没有 pid 不算在跑')
  assert.equal(heartbeatFresh({}, now), false)
})

test('写偏好不会擦掉对面写的字段', () => {
  const home = tempHome('merge')
  writePreference(home, { desktopPid: 4242, at: Date.now(), desktopStartedAt: Date.now() })
  writePreference(home, { mode: 'desktop' })
  const preference = readPreference(home)
  assert.equal(preference.mode, 'desktop')
  assert.equal(preference.desktopPid, 4242, '写 mode 不能把桌面端的心跳擦掉')
  rmSync(home, { recursive: true, force: true })
})

test('偏好文件就是 %DSH_HOME%\\pet-desktop.json（两端同一个位置）', () => {
  const home = tempHome('path')
  writePreference(home, { mode: 'inline' })
  const raw = readFileSync(join(home, 'pet-desktop.json'), 'utf8')
  assert.match(raw, /"mode": "inline"/)
  rmSync(home, { recursive: true, force: true })
})

test('进程状态读口如实反映心跳（running 才是判据）', () => {
  const home = tempHome('state')
  const cold = desktopProcessState(home)
  assert.equal(cold.file, false, '没写过就是没有')
  assert.equal(cold.heartbeatFresh, false)
  assert.equal(cold.running, false)
  // 拿当前进程当"桌面端"：它一定活着，心跳也新鲜。
  writePreference(home, { desktopPid: process.pid, at: Date.now() })
  const warm = desktopProcessState(home)
  assert.equal(warm.heartbeatFresh, true)
  assert.equal(warm.running, true)
  // 心跳过期 → 就是不在跑（哪怕那个 pid 号还占着）。
  writePreference(home, { desktopPid: 999_999, at: 0 })
  const stale = desktopProcessState(home)
  assert.equal(stale.heartbeatFresh, false)
  assert.equal(stale.running, false)
  rmSync(home, { recursive: true, force: true })
})

test('判据只看心跳 —— pid 号被重用也不会误判成"还在跑"', () => {
  const home = tempHome('pid-reuse')
  // 心跳过期，但 pid 指向**当前这个活着的进程**（模拟"桌面端被杀之后号被别的进程拿走"）。
  writePreference(home, { desktopPid: process.pid, at: Date.now() - HEARTBEAT_TTL_MS - 1000 })
  const state = desktopProcessState(home)
  assert.equal(state.heartbeatFresh, false, '心跳已经过期')
  assert.equal(state.pidStillTaken, true, '那个 pid 号确实还占着（可能是别人的进程）')
  assert.equal(state.running, false, '**结论必须是不在跑** —— 拿 pid 当判据就会在这里说"活着"')
  rmSync(home, { recursive: true, force: true })
})

test('写不进去也不能抛（只读盘 / 权限问题）', () => {
  assert.doesNotThrow(() => {
    writePreference(join(DESKTOP, '.run', 'no-such-drive', 'x'), { mode: 'auto' })
  })
})
