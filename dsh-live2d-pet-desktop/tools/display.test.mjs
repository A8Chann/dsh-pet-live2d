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
  needsReattach,
  normaliseMode,
  readPreference,
  upstreamKey,
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

test('挂错上游才重拉 —— 而且只认自己拉的那一只', () => {
  const fallback = 'http://127.0.0.1:3080'
  const real = 'http://127.0.0.1:43129'
  // 没在跑：没什么好重拉的（要拉走 `start()`）。
  assert.equal(needsReattach(false, fallback, real), false)
  // 在跑、地址也没变：让她待着。
  assert.equal(needsReattach(true, real, real), false)
  // 在跑，但当初是拿**旧**地址拉起来的：这一只永远挂错上游，收掉重拉。
  assert.equal(needsReattach(true, fallback, real), true)
  // 不是我们拉起来的（用户手动双击开的）：地址再怎么变也不碰。
  assert.equal(needsReattach(true, null, real), false)
})

test('同一个 DSH 的不同拼法不算「地址变了」—— 否则两个标签页就能把自愈变成反复重启', () => {
  // `dshUrl` 是**页面报上来的**（`/layer` 的 Origin / Host）。一个标签页用 127.0.0.1、
  // 另一个用 localhost 是完全正常的，而 `reconcile()` 的重拉分支会把冷却清零 ⇒ 不归一化
  // 就是每拍收掉重拉一次（2026-10 实测 8 秒重启 2 次，每次都 taskkill 一整棵进程树）。
  const a = 'http://127.0.0.1:43129'
  const b = 'http://localhost:43129'
  assert.equal(needsReattach(true, a, b), false, 'localhost 与 127.0.0.1 是同一个上游')
  assert.equal(needsReattach(true, b, a), false, '反过来也一样')
  assert.equal(needsReattach(true, 'http://LOCALHOST:43129', a), false, '主机名大小写不敏感')
  assert.equal(needsReattach(true, 'http://127.0.0.1:43129/', a), false, '尾部斜杠不算另一种地址')
  assert.equal(needsReattach(true, 'http://[::1]:43129', a), false, 'IPv6 回环也是同一个上游')

  // 但**端口真的变了**必须重拉 —— 那才是这条自愈存在的理由。
  assert.equal(needsReattach(true, a, 'http://127.0.0.1:43130'), true, '端口不同 = 不同上游')
  assert.equal(needsReattach(true, a, 'http://localhost:43130'), true, '端口不同（即便主机名同义）')
  // 主机名不同（不是回环别名）也要重拉：那可能就是另一台机器。
  assert.equal(needsReattach(true, a, 'http://192.168.1.9:43129'), true)
  // http 与 https 不是同一个上游。
  assert.equal(needsReattach(true, a, 'https://127.0.0.1:43129'), true)
})

test('upstreamKey 归一化：合并回环别名、补默认端口、解析不了就退回原串', () => {
  const key = (url) => upstreamKey(url)
  // 四种回环写法归到同一个键。
  const same = ['http://127.0.0.1:3080', 'http://localhost:3080', 'http://[::1]:3080']
  assert.equal(new Set(same.map(key)).size, 1, '回环别名应当归成一个键：' + JSON.stringify(same.map(key)))
  // 默认端口要补上（`http://a` 与 `http://a:80` 是同一个）。
  assert.equal(key('http://127.0.0.1'), key('http://127.0.0.1:80'))
  assert.equal(key('https://example.test'), key('https://example.test:443'))
  // 尾部斜杠（一个或多个）都吃掉。
  assert.equal(key('http://127.0.0.1:3080/'), key('http://127.0.0.1:3080'))
  // 路径不同就是不同上游（将来挂到子路径下也成立）。
  assert.notEqual(key('http://127.0.0.1:3080/a'), key('http://127.0.0.1:3080/b'))
  // 非字符串 / 解析不了：原样退回，绝不抛。
  assert.equal(key(undefined), undefined)
  assert.equal(key('不是地址'), '不是地址')
  assert.equal(key(''), '')
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
