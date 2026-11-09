// 「一轮会话什么时候结束、算成功还是失败」的折叠逻辑 —— 纯 node，不需要浏览器。
//
// 盯的是三类**只会以"宠物演错了"的形式出现**的问题：
//
//   1. 事件处理器里引用到不存在的变量（`subagent/end` 曾经抛 `pendingCelebrate is not defined`，
//      被 Cordis 的事件容错吞掉 ⇒ 只留日志、"等子代理再庆祝"整段静默失效）；
//   2. 用错了 `turn/end` 的判据（出错/中断当成完成庆祝、用户主动中止却报失败）；
//   3. 宿主能力差异：`typertGateway.getPendingRemoteEvents()` 是 DSH 0.2.2 才有的方法，
//      0.2.1 上清单恒为空 —— 轮询若照旧执行，会把 `approval/request` 设好的 waiting
//      每 250 ms 踩回 thinking（用户看到"审批时闪一下就回去干活"）。
//
// 做法：把真实的 `attachActivityEvents` 挂到假 ctx 上，按宿主事件的真实载荷形状触发，
// 读 `hub.phase` 断言。不碰网络、不碰磁盘、不需要 DSH 在跑。
//
//   node --test dsh-live2d-pet-desktop/tools/activity-hub.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN } from './paths.mjs'

const { attachActivityEvents, ActivityHub } = await import(
  pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 假宿主：只实现插件真正用到的四个入口（on / onWaterfall 走同一个注册表）。
 * `gateway` 决定"这台宿主有没有 getPendingRemoteEvents"——传 undefined 就是 0.2.1。
 */
function attach({ gateway } = {}) {
  const handlers = new Map()
  const register = (event, handler) => {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
  }
  const disposers = []
  const ctx = {
    on: register,
    inject(_list, callback) {
      try { callback({ agents: null }) } catch { /* 旧宿主 */ }
      return () => {}
    },
    get(name) {
      if (name === 'typertGateway') return gateway
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }
  const hub = new ActivityHub()
  attachActivityEvents(ctx, hub, () => 'wait')
  const fire = (event, ...args) => {
    let out
    for (const handler of handlers.get(event) ?? []) out = handler(...args)
    return out
  }
  const dispose = () => {
    for (const disposer of disposers) disposer()
    hub.dispose()
  }
  return { hub, fire, dispose }
}

/** 造一个最小 Agent：`snapshotEvents()` 最后一条是 turn/end，带给定 reason。 */
const agentOf = (id, reason) => ({
  id,
  session: {
    header: { origin: undefined },
    snapshotEvents: () => (reason === undefined
      ? []
      : [{ type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason } }]),
  },
  inbox: { hasPending: () => false },
})

test('子代理结束不会抛 ReferenceError，并且会补发被推迟的庆祝', async () => {
  const { hub, fire, dispose } = attach()
  try {
    fire('subagent/start', { id: 'sub-1', runId: 'r1', provider: 'local', local: true })
    // 主回合先结束（被子代理挡住 ⇒ 挂起），再让子代理收尾
    const main = agentOf('a-main', { kind: 'completed' })
    fire('agent/status', { agent: main, status: 'running' })
    fire('agent/status', { agent: main, status: 'idle' })
    await sleep(80)
    assert.notEqual(hub.phase, 'done', '子代理还在跑时不该庆祝')

    assert.doesNotThrow(() => {
      fire('subagent/end', { id: 'sub-1', runId: 'r1', provider: 'local', local: true, stopReason: 'completed' })
    })
    await sleep(80)
    assert.equal(hub.phase, 'done', '子代理收尾后应当补上庆祝')
  } finally {
    dispose()
  }
})

test('turn/end 的 reason 决定成功还是失败', async () => {
  const { hub, fire, dispose } = attach()
  try {
    // 出错：判失败，不庆祝
    const failed = agentOf('a-err', { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })
    fire('agent/status', { agent: failed, status: 'running' })
    fire('agent/status', { agent: failed, status: 'idle' })
    assert.equal(hub.phase, 'failed')

    // 用户主动中止：安静回 idle，不报失败
    const aborted = agentOf('a-abort', { kind: 'aborted', reason: { kind: 'user' } })
    fire('agent/status', { agent: aborted, status: 'running' })
    fire('agent/status', { agent: aborted, status: 'idle' })
    assert.equal(hub.phase, 'idle')

    // 正常完成：先去抖，再庆祝
    const ok = agentOf('a-ok', { kind: 'completed' })
    fire('agent/status', { agent: ok, status: 'running' })
    fire('agent/status', { agent: ok, status: 'idle' })
    assert.notEqual(hub.phase, 'done', '450ms 去抖窗口内不该立刻庆祝')
    await sleep(600)
    assert.equal(hub.phase, 'done')
  } finally {
    dispose()
  }
})

test('多会话互不串：没跑过的会话不会借用别人的 running / error', async () => {
  const { hub, fire, dispose } = attach()
  try {
    const busy = agentOf('a-busy', { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } })
    fire('agent/status', { agent: busy, status: 'running' })
    fire('agent/status', { agent: busy, status: 'idle' })
    assert.equal(hub.phase, 'failed')

    // 另一个会话上电即空闲（从没跑过）：不该因为"见过 running"就庆祝
    const idle = agentOf('a-idle', undefined)
    fire('agent/status', { agent: idle, status: 'idle' })
    await sleep(600)
    assert.notEqual(hub.phase, 'done', '没跑过的会话不该庆祝')
  } finally {
    dispose()
  }
})

test('宿主没有 getPendingRemoteEvents（DSH 0.2.1）：不接管相位，waiting 不会被踩掉', async () => {
  // 0.2.1 的 gateway：服务在，但没有这个方法
  const { hub, fire, dispose } = attach({ gateway: {} })
  try {
    fire('approval/request', { agent: { id: 'a-ask' } }, () => undefined)
    assert.equal(hub.phase, 'waiting')
    await sleep(600) // 跨过两个 250ms 轮询
    assert.equal(hub.phase, 'waiting', '方法不存在时轮询必须完全不介入')
  } finally {
    dispose()
  }
})

test('宿主有 getPendingRemoteEvents（DSH 0.2.2）：清单折成 waiting/asking，清空后回落', async () => {
  const rows = [{ event: 'approval/request', agentId: 'a-ask' }]
  const gateway = { getPendingRemoteEvents: () => rows.slice() }
  const { hub, dispose } = attach({ gateway })
  try {
    await sleep(320) // 等一次轮询
    assert.equal(hub.phase, 'waiting')
    rows.length = 0
    await sleep(320)
    assert.equal(hub.phase, 'thinking', '清单清空后回落到干活')
  } finally {
    dispose()
  }
})
