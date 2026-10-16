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

/** 本机回环的几种写法 —— 它们指的是**同一台服务**。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 上游地址的**比较键**：只用来判"是不是同一个上游"，不用来连接。
 *
 * 为什么不能直接比字符串：`dshUrl` 是**页面报上来的**（`/layer` 的 Origin / Host），而页面
 * 那边完全可能出现两种拼法 —— 一个标签页是 `http://127.0.0.1:43129`，另一个是
 * `http://localhost:43129`。它们是同一个 DSH，字符串却不相等。
 *
 * 不归一化的后果不是"少重拉一次"，而是**反复收掉重拉**：`reconcile()` 里那条重拉分支把
 * 冷却（`lastAttempt`）显式清零了，于是两个标签页错相轮询时，每一拍都会判成"挂错上游"
 * ⇒ 收掉、重拉、再收掉…… 实测（2026-10，两个页面各 1 秒一拉、相位错开 500ms）8 秒里
 * 她就被重启了 2 次，每次还 `taskkill /T` 掉一整棵 WebView2 进程树。用户看到的是
 * "桌宠刚出现就没了"。
 *
 * 归一化的三件事：主机名小写、回环别名合并成 `127.0.0.1`、补上默认端口并去掉尾部斜杠。
 * 解析不了就退回原字符串（宁可多比一次，也不要因为解析失败而漏判）。
 */
export function upstreamKey(url) {
  if (typeof url !== 'string') return url
  const text = url.trim()
  try {
    const parsed = new URL(text)
    const host = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
      ? '127.0.0.1'
      : parsed.hostname.toLowerCase()
    const port = parsed.port !== '' ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')
    const path = parsed.pathname.replace(/\/+$/, '')
    return parsed.protocol + '//' + host + ':' + port + path
  } catch {
    return text.replace(/\/+$/, '')
  }
}

/**
 * 该不该把现在这只壳收掉、按新地址重拉一只？
 *
 * 壳只在**被拉起的那一刻**知道上游地址（`--attach` 写死在命令行里），它自己不会跟着变。
 * 而插件刚加载的头一秒页面还没报过地址，壳只能拿兜底值起来（见 `dshUrl`），等真实地址
 * 报上来，这一只就永远挂错了上游 —— 表现是"桌面上什么都没有"，它的 `/layer` 会答
 * `attach-upstream-unreachable`。
 *
 * **只认自己拉的那一只**：`spawnedUrl === null` 表示这只不是我们拉起来的（用户手动
 * 双击开的），地址变了也不该动它 —— 那是用户自己的窗口。
 *
 * **比的是归一化之后的键**（见 `upstreamKey`）：同一个 DSH 的两种回环拼法不算"地址变了"
 * —— 否则两个标签页就能把自愈变成反复重启。
 */
export function needsReattach(alive, spawnedUrl, dshUrl) {
  if (alive !== true || spawnedUrl === null) return false
  return upstreamKey(spawnedUrl) !== upstreamKey(dshUrl)
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
   * 页面还没报过之前，用 3080 兜底 —— 那是 `dsh web` 的默认值。**注意它会变**：
   * 页面一报上来就改了，而已经用旧地址拉起来的那只壳得收掉重拉（见 `needsReattach`）。
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
  /**
   * 这一只壳是**用哪个上游地址**拉起来的（`null` = 不是我们拉的）。
   *
   * 要单独记一份：`dshUrl` 会变（页面把真实端口报上来），而壳那边的 `--attach` 定死在
   * 被拉起的那一刻。两者不一致就是"挂错了上游"，见 `needsReattach`。
   */
  let spawnedUrl = null
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
    // 壳都没了，"它当初是用哪个地址拉的"也就没意义了。
    spawnedUrl = null
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
      spawnedUrl = null
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
          spawnedUrl = null
        }
      })
      // **拉起失败是异步事件，下面那个 `try/catch` 接不到它**：`spawn` 起不来的原因
      // （`EACCES` 没有执行位、`ENOENT` 文件不在、`ENOEXEC` 格式不对）走的是 `'error'`
      // 事件；而 `'error'` 上**没有监听者时，Node 会把它当未捕获异常抛出去** ——
      // 在 DSH 里就是整个 Harness 进程当场退出，不是"这次没起来"。
      // （2026-10 实测：设置里把显示层改成「桌面」，宿主 201ms 后消失，日志是
      // `dsh: fatal uncaught exception: Error: spawn … EACCES`。缺监听也会让
      // 上面那行"已拉起"照打不误 —— `（pid 0）` 就是它。）
      child.on('error', (error) => {
        if (childPid === (child?.pid ?? 0)) {
          note('拉起桌面端失败（spawn error）：' + String(error && error.message))
          child = null
          childPid = 0
          spawnedUrl = null
        }
        // 冷却**不**清（见 `RETRY_MS`）：真起不来时（二进制损坏之类）每 30 秒试一次就够，
        // 清了会变成每秒一条日志。
      })
      // `pid` 是 `undefined` = `spawn` 已经失败了（具体原因在下面那个 `'error'` 里）。
      // 别再打"已拉起"——那行在排查时最误导人。
      if (childPid !== 0) {
        // 记下"这一只是用哪个地址拉的" —— 地址之后可能变，见 `needsReattach`。
        spawnedUrl = dshUrl
        note('已拉起桌面端：' + binary.path + ' --attach ' + dshUrl + '（pid ' + childPid + '）')
      }
      return { ok: true, reason: 'spawned', pid: childPid }
    } catch (error) {
      child = null
      childPid = 0
      spawnedUrl = null
      note('拉起桌面端失败：' + String(error && error.message))
      return { ok: false, reason: 'spawn-failed' }
    }
  }

  /**
   * 每秒一次：按偏好把两边摆正。
   *
   *   auto     桌面端在跑 → 让她待着；没跑 → 也不主动拉（用户没要求过桌面）
   *   desktop  必须有一个：没跑就拉起（失败就只是提示，不崩）；挂错了上游就收掉重拉
   *   inline   收掉我们拉的那个，桌面端自己会让位（它读同一个文件）
   */
  function reconcile() {
    const mode = normaliseMode(preference().mode)
    if (mode === 'desktop') {
      const alive = running()
      // **挂错上游的壳不会自愈**：`--attach` 定死在被拉起的那一刻，`setDshUrl()` 改不了
      // 已经在跑的那一只。收掉它，下一拍按新地址重拉 —— `stop()` 会把心跳清零，所以
      // 下一拍一定走下面的 `!alive`，正好把冷却绕开（冷却是给"起不来"用的，不是给这个）。
      if (needsReattach(alive, spawnedUrl, dshUrl)) {
        note('DSH 地址已变为 ' + dshUrl + '（当初用 ' + spawnedUrl + ' 拉的），重拉桌面端')
        stop()
        lastAttempt = 0
        return status()
      }
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