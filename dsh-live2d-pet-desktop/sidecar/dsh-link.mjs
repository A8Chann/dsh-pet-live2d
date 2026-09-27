// 与**运行中的 DSH** 的连接：订阅它的 `/api/live2d-pet/events`，把相位喂给本地 hub。
//
// 为什么这么做：桌面端要"跟着会话走"，但它不拥有 DSH 的进程，所以拿不到 `ctx.on(...)`。
// 好在插件宿主半区已经把 DSH 那 12 个事件折成了 9 个相位，并通过 SSE 推出来——
// 桌面端只要订阅它，就能演出**和网页端一模一样**的状态机（`agent/status` → thinking、
// `tools/pre-execute` → tool、`tool` 相位的 1200ms 防抖回落……全都发生在 DSH 那边）。
//
// 这里是**本地独立 + 可挂 DSH**：DSH 没在跑就只是 idle，宠物照样站着、照样摸鱼；
// 连上了就跟着走；断了自动重连（间隔退避），不弹错、不崩。
//
// 用 `node:http` 手写 SSE 客户端而不是拉 eventsource 包：只要一行行读 `data:` 就够了，
// 而且我们要精确控制"断了怎么办"。
import { request as httpRequest } from 'node:http'

/** 相位名与插件宿主半区保持一致的唯一来源是对方的实现，这里只做白名单校验。 */
const PHASES = new Set(['idle', 'thinking', 'waiting', 'asking', 'tool', 'helper', 'queued', 'done', 'failed'])

/**
 * @param {{ base: string, hub: { set(phase: string, detail?: string): void }, log?: (msg: string) => void }} options
 */
export function createDshLink(options) {
  const { base, hub, log } = options
  const url = new URL('/api/live2d-pet/events', base)

  const state = {
    base,
    url: url.href,
    connected: false,
    attempts: 0,
    phases: 0,
    lastPhase: null,
    lastDetail: '',
    lastAt: 0,
    lastError: null,
    closed: false,
  }

  let current = null
  let retryTimer = null
  let backoff = 500

  const note = (message) => {
    if (typeof log === 'function') log('[dsh-link] ' + message)
  }

  function schedule(delay) {
    if (state.closed || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
    retryTimer.unref?.()
  }

  function connect() {
    if (state.closed) return
    state.attempts += 1
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode !== 200) {
        state.lastError = 'HTTP ' + response.statusCode
        response.resume()
        current = null
        backoff = Math.min(15000, Math.round(backoff * 1.7))
        schedule(backoff)
        return
      }
      state.connected = true
      state.lastError = null
      backoff = 500
      note('已连上 ' + url.href)

      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          // SSE 帧里我们只认 `data:`（心跳是 `: ping`，直接跳过）。
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let payload
            try {
              payload = JSON.parse(line.slice(5).trim())
            } catch {
              continue
            }
            const phase = typeof payload?.phase === 'string' ? payload.phase : ''
            if (!PHASES.has(phase)) continue
            const detail = typeof payload?.detail === 'string' ? payload.detail : ''
            // 相位变化才喂——hub 自己也会去重，但这里少一次跨进程抖动。
            if (phase === state.lastPhase && detail === state.lastDetail) continue
            state.phases += 1
            state.lastPhase = phase
            state.lastDetail = detail
            state.lastAt = Date.now()
            hub.set(phase, detail)
          }
        }
      })
      const done = () => {
        state.connected = false
        current = null
        if (state.closed) return
        backoff = Math.min(15000, Math.round(backoff * 1.7))
        schedule(backoff)
      }
      response.on('end', done)
      response.on('close', done)
      response.on('error', (error) => {
        state.lastError = String(error && error.message)
        done()
      })
    })

    req.on('error', (error) => {
      state.connected = false
      state.lastError = String((error && error.message) || error)
      current = null
      backoff = Math.min(15000, Math.round(backoff * 1.7))
      schedule(backoff)
    })
    req.end()
    current = req
  }

  connect()

  return {
    state,
    dispose() {
      state.closed = true
      state.connected = false
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      try {
        current?.destroy()
      } catch {
        /* 已经断了 */
      }
      current = null
    },
  }
}
