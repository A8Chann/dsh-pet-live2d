// 显示层（宿主半区）：桌宠在**页面内**还是**桌面上**，以及"谁来管这只宠物"。
//
// 两条呈现路径都可能活着（插件在 DSH 里渲染 + 一个原生窗口进程），所以需要一个判定，
// 否则用户会看见两只。判定靠一个**两端都能读的文件**：
//
//   %DSH_HOME%\pet-desktop.json
//   { mode: "auto"|"inline"|"desktop", desktopPid, desktopStartedAt, at }
//
// 规则**只有一条**，两端各自算、结论必然一致：
//
//   桌面端心跳新鲜（< 6 秒）且 mode ≠ "inline"  →  桌面端是 owner
//   否则                                        →  页面内是 owner
//
// Rust 侧那份实现在 `dsh-live2d-pet-desktop/src-tauri/src/host/display.rs`，**逐字对应**
// （各自的单元测试都钉着同一张真值表）。改规则必须两边一起改。
//
// 为什么不走 DSH 的进程内服务：桌面端是另一个进程，拿不到 `ctx.on(...)`。一个文件加一条
// 纯规则，是这两边唯一都能用的东西。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { downloadDesktopBinary } from './desktop.js'

/** 心跳有效期：桌面端每 1 秒刷一次（见它的 display_loop），这里给六倍余量。 */
export const HEARTBEAT_TTL_MS = 6000

export const MODES = ['auto', 'inline', 'desktop']

export function preferencePath(home) {
  return join(home, 'pet-desktop.json')
}

/** 读偏好文件；读不出来就当空（老装机本来就没有）。 */
export function readPreference(home) {
  try {
    const parsed = JSON.parse(readFileSync(preferencePath(home), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写偏好文件（合并写：两端都在往里写，别把对方的东西擦掉）。 */
export function writePreference(home, patch) {
  const current = Object.assign(readPreference(home), patch)
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(preferencePath(home), JSON.stringify(current, null, 2) + '\n')
  } catch {
    /* 只读盘之类：这次生效，下次不记得 */
  }
  return current
}

export function normaliseMode(raw) {
  return typeof raw === 'string' && MODES.includes(raw) ? raw : 'auto'
}

export function heartbeatFresh(preference, now = Date.now()) {
  const at = typeof preference?.at === 'number' ? preference.at : 0
  const pid = typeof preference?.desktopPid === 'number' ? preference.desktopPid : 0
  return pid !== 0 && at !== 0 && now - at < HEARTBEAT_TTL_MS
}

/**
 * **判定规则**（唯一一条）。
 * @returns {'desktop'|'inline'}
 */
export function computeOwner(mode, heartbeatOk) {
  return mode !== 'inline' && heartbeatOk === true ? 'desktop' : 'inline'
}

/**
 * 进程还活着吗（**只用于诊断**）。
 *
 * ⚠️ **不要拿它当"在不在跑"的判据。** Windows 与类 Unix 都会**重用 pid**：桌面端被
 * 任务管理器杀掉（没走退出清理，心跳文件里还留着那个 pid）之后，那个号可能已经被别的
 * 进程拿走，`process.kill(pid, 0)` 于是说"活着"—— 然后页面里那只就永远让位，
 * 用户看到"没反应"。实测踩过一次：杀掉桌面端后 owner 仍报 desktop。
 *
 * 判据只用**心跳**：它每秒刷新，6 秒不刷新就是没了（进程被杀 / 卡死 / 崩了都覆盖），
 * 而且不依赖任何平台细节。
 */
function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但不是我们的；ESRCH = 不存在。
    return error?.code === 'EPERM'
  }
}

/**
 * 显示层控制器：读偏好、必要时拉起/收掉桌面端、回答"现在该谁显示"。
 *
 * 一个实例挂在插件生命周期上（`apply()` 里建、dispose 时收），进程内的状态就是它自己。
 */
export function createDisplayLayer(options) {
  const { home, resolveBinary, log } = options
  const note = (message) => {
    if (typeof log === 'function') log('[display] ' + message)
  }

  /**
   * 拉起桌面端时用的上游地址。
   *
   * **从页面自己报过来**（`/layer` 请求的 Origin/Host），不是我们猜的：DSH 的端口是配置的，
   * 猜错的话挂载模式会连到一个不存在的上游（那就成了"挂上去了但什么也没有"）。
   * 页面还没报过之前，用 3080 兜底 —— 那是 `dsh web` 的默认值。
   */
  let dshUrl = 'http://127.0.0.1:3080'
  const setDshUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    if (!/^https?:\/\//.test(value)) return
    dshUrl = value.replace(/\/$/, '')
  }

  /** 我们自己拉起来的那个进程（0 = 没拉）。 */
  let child = null
  let childPid = 0
  /** 上次尝试拉起的时间：失败之后不要每秒重试，会刷屏。 */
  let lastAttempt = 0
  const RETRY_MS = 30000

  const preference = () => readPreference(home)

  /**
   * 在不在跑 —— **只看心跳**（见 `pidAlive` 上的说明：pid 会被重用，不能当判据）。
   *
   * 心跳每秒刷新一次，6 秒不刷新就当作没了：进程被杀、卡死、崩了三种情况都覆盖到。
   */
  const running = () => heartbeatFresh(preference())

  /** 状态：设置页与 `/owner` 都读它。 */
  function status() {
    const current = preference()
    const mode = normaliseMode(current.mode)
    const alive = heartbeatFresh(current)
    return {
      mode,
      owner: computeOwner(mode, alive),
      desktopRunning: alive,
      desktopPid: typeof current.desktopPid === 'number' ? current.desktopPid : 0,
      desktopSpawnedByPlugin: childPid !== 0,
      heartbeatAt: typeof current.at === 'number' ? current.at : 0,
      ttlMs: HEARTBEAT_TTL_MS,
      // 诊断用：仅当心跳说"没了"而那个 pid 号还占着时，它才有信息量（pid 重用）。
      pidStillTaken: !alive && pidAlive(current.desktopPid),
    }
  }

  function stop() {
    if (child === null) return false
    try {
      // ⚠️ Windows 上 `child.kill()` 是 TerminateProcess：**只杀壳自己**。WebView2 的
      // `msedgewebview2.exe` 子进程会留下来继续占着 `%LOCALAPPDATA%\<id>\EBWebView`
      // （那是独占的），于是**下一次**启动撞 `0x800700AA 请求的资源在使用中`
      // —— 用户 2026-09 报的那个报错框就是这么来的。
      // 所以 Windows 上连整棵进程树一起收（`/T`），别留孤儿。
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(childPid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } else {
        child.kill()
      }
      note('已收掉桌面端（pid ' + childPid + '，含子进程）')
    } catch {
      /* 已经退了 */
    }
    child = null
    childPid = 0
    // 心跳留给它自己清；这里顺手清一次，页面里那只不用等超时。
    writePreference(home, { desktopPid: 0, at: 0 })
    return true
  }

  function start() {
    const binary = resolveBinary()
    if (binary === undefined) {
      note('找不到桌面端二进制，无法拉起（' + (options.hint ?? '') + '）')
      return { ok: false, reason: 'binary-missing' }
    }
    // **先自愈**：我们记着的那个子进程可能早就没了（被杀 / 崩了 / 崩溃后没人收），
    // 而 `exit` 事件也没到（比如进程被 `taskkill /T` 连带干掉）。不清理的话
    // `childPid !== 0` 会让下面那条守卫永远返回"已经有一只了" —— 于是设置里显示
    // **"桌面已接管"、桌面上却什么都没有**（用户 2026-09 报的现象）。
    if (childPid !== 0 && !pidAlive(childPid) && !running()) {
      note('记着的桌面端进程（pid ' + childPid + '）已经不在了 —— 忘掉它')
      child = null
      childPid = 0
    }
    if (childPid !== 0 || running()) return { ok: true, reason: 'already-running' }
    if (Date.now() - lastAttempt < RETRY_MS && lastAttempt !== 0) {
      return { ok: false, reason: 'retry-cooldown' }
    }
    lastAttempt = Date.now()
    try {
      // `detached` + `unref`：她是**独立的**窗口进程，DSH 关掉她还得站着。
      //
      // `--from-plugin`：告诉壳"这一份是插件按设置拉起的" —— 壳据此**严格尊重**用户的
      // 「页面内」选择。**手动双击**时没有这个参数，壳会把「页面内」改写成「桌面」：
      // 双击的意图就是"我要她在桌面上"，否则用户看到的是"双击了，什么都没发生"
      // （2026-09 用户报的就是这个；见壳里 `host::display::manual_launch_overrides_inline`）。
      child = spawn(binary.path, ['--attach', dshUrl, '--from-plugin'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      childPid = child.pid ?? 0
      child.unref()
      // **子进程退出要当场忘掉它**：否则 `childPid` 永远非 0，reconcile 会一直认为
      // "已经有一只了"，她死了插件也不重拉（设置里还显示"桌面已接管"）。
      child.on('exit', () => {
        if (childPid === (child?.pid ?? 0)) {
          note('桌面端进程退出了（pid ' + childPid + '）')
          child = null
          childPid = 0
        }
      })
      note('已拉起桌面端：' + binary.path + ' --attach ' + dshUrl + '（pid ' + childPid + '）')
      return { ok: true, reason: 'spawned', pid: childPid }
    } catch (error) {
      child = null
      childPid = 0
      note('拉起桌面端失败：' + String(error && error.message))
      return { ok: false, reason: 'spawn-failed' }
    }
  }

  /**
   * 每秒一次：按偏好把两边摆正。
   *
   *   auto     桌面端在跑 → 让她待着；没跑 → 也不主动拉（用户没要求过桌面）
   *   desktop  必须有一个：没跑就拉起（失败就只是提示，不崩）
   *   inline   收掉我们拉的那个，桌面端自己会让位（它读同一个文件）
   */
  function reconcile() {
    const mode = normaliseMode(preference().mode)
    if (mode === 'desktop') {
      const alive = running()
      if (!alive) {
        const result = start()
        if (result.reason === 'binary-missing') {
          // 说清楚"下一句该干什么"，而不是只报个失败。
          note(options.hint ?? '桌面端未安装')
        }
      }
      return status()
    }
    if (mode === 'inline' && childPid !== 0) stop()
    return status()
  }

  function setMode(mode) {
    const next = normaliseMode(mode)
    writePreference(home, { mode: next })
    note('显示层切换为 ' + next)
    return reconcile()
  }

  /**
   * 惰性下载：**先回话、后台下**。
   *
   * 不能让 HTTP 请求等下完那 5MB —— 那个请求会挂在那儿，而页面每秒轮询一次 `/layer`，
   * 用户的观感就是"卡住了，还是没反应"。所以立刻回 `{started:true}`，进度写进
   * `downloadState` 由每秒的轮询带回去；下完**不需要重启**（解析器会看 `%DSH_HOME%\bin\`）。
   */
  let downloadState = { state: 'idle', at: 0 }
  function startDownload() {
    if (downloadState.state === 'downloading') return { started: false, reason: 'already-running' }
    downloadState = { state: 'downloading', at: Date.now() }
    note('开始下载桌面端二进制')
    downloadDesktopBinary({ home, log })
      .then((result) => {
        downloadState = result.ok === true
          ? { state: 'done', at: Date.now(), path: result.path, bytes: result.bytes }
          : { state: 'failed', at: Date.now(), reason: result.reason, detail: result.detail ?? null }
        note('下载结束：' + JSON.stringify(downloadState))
        // 下完就按当前 mode 摆正一次：mode 已经是 desktop 的话这里就把它拉起来了，
        // 用户不用再点第二次。
        if (result.ok === true) reconcile()
      })
      .catch((error) => {
        downloadState = { state: 'failed', at: Date.now(), reason: 'exception', detail: String(error && error.message) }
      })
    return { started: true }
  }

  function dispose() {
    // 插件停掉（DSH 退出 / 插件卸载）时，**不**杀掉用户自己在跑的桌面端；
    // 只收掉我们拉起来的那个 —— 那本来就是"插件的延伸"。
    stop()
  }

  return {
    status,
    reconcile,
    setMode,
    setDshUrl,
    start,
    stop,
    startDownload,
    downloadState: () => downloadState,
    dispose,
    preferencePath: () => preferencePath(home),
  }
}

/** 桌面上还有没有别的实例在跑（诊断用）。 */
export function desktopProcessState(home) {
  const current = readPreference(home)
  const fresh = heartbeatFresh(current)
  return {
    pid: typeof current.desktopPid === 'number' ? current.desktopPid : 0,
    // `running` 才是判据；`alive` 只是"那个 pid 号现在还占着"（可能已经是别人的进程）。
    running: fresh,
    pidStillTaken: pidAlive(current.desktopPid),
    heartbeatFresh: fresh,
    file: existsSync(preferencePath(home)),
  }
}