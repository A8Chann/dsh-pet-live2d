// 设置存档（宿主半区）：**一份两端共享的设置**，落在 `%DSH_HOME%\pet-settings.json`。
//
// 为什么必须有它（用户报的"桌面的设置与 DSH 里的设置没有同步"）：
// 设置原来只存在 `window.localStorage` 里，而**桌面端页面与 DSH 页面不是同一个 origin**：
//
//   桌面端：http://127.0.0.1:<壳的随机端口>     ← `--attach` 模式下页面由壳转发
//   DSH：   http://127.0.0.1:3080
//
// 浏览器按 origin 隔离 localStorage，所以两边各有一份、永不互见 —— 不是"同步没做"，
// 而是**根本没有共享的存储**。显示层（`pet-desktop.json`）早就踩过同一个问题，
// 解法也一样：把共享状态放到一个两端都能读写的文件里。
//
// 三个键（与客户端的三类 shared 存档一一对应）：
//
//   tuning     ← `dsh-pet-live2d.settings.v1`  可调项（手感、池子节奏…）
//   overrides  ← `dsh-pet-live2d.settings.v2`  相位池子覆盖 + 开关 + 反应清空
//   outfit     ← `dsh-pet-live2d:outfit`       装扮槽位的选择
//
// **位置与大小不在里面**（`dsh-live2d-pet.state.v1`）：那个必须每个窗口各不相同
// （桌面上她贴屏幕右下角、DSH 页面里她贴面板右下角），共享了反而会打架。
//
// Rust 侧的对应实现见 `dsh-live2d-pet-desktop/src-tauri/src/host/settings.rs`：
// 独立模式下壳直接读写这个文件；挂载模式下页面读的仍是 DSH 的这条路由。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 存档里的键（客户端与 Rust 侧都按这三个名字读写）。 */
export const SETTINGS_KEYS = ['tuning', 'overrides', 'outfit']

export function settingsPath(home) {
  return join(home, 'pet-settings.json')
}

/**
 * 读共享设置。
 *
 * 返回 `{ tuning, overrides, outfit, rev, at }`；键缺失就是 `null`（"这一项用户没改过"）。
 * `rev` 每次写入 +1 —— 页面用它判断"我这份是不是旧的"，也用它避免自己写自己读的回环。
 */
export function readSettings(home) {
  const empty = { tuning: null, overrides: null, outfit: null, rev: 0, at: 0 }
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const out = Object.assign({}, empty)
  for (const key of SETTINGS_KEYS) {
    const value = parsed[key]
    // 只接受对象：存档被人手改坏时不要把它传染给页面。
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out[key] = value
  }
  if (typeof parsed.rev === 'number' && parsed.rev >= 0) out.rev = parsed.rev
  if (typeof parsed.at === 'number' && parsed.at >= 0) out.at = parsed.at
  return out
}

/**
 * 写共享设置（**合并写**：只动传进来的那几项，别把别的窗口写的擦掉）。
 *
 * 返回写好之后的那一份（含新的 `rev`）。写失败时返回 `null` —— 调用方要能区分
 * "没写成功"和"写成功了"，否则页面会以为同步好了。
 */
export function writeSettings(home, patch) {
  if (patch === null || typeof patch !== 'object') return null
  const current = readSettings(home)
  const next = {
    tuning: current.tuning,
    overrides: current.overrides,
    outfit: current.outfit,
    rev: current.rev + 1,
    at: Date.now(),
  }
  let touched = false
  for (const key of SETTINGS_KEYS) {
    const value = patch[key]
    if (value === null) continue          // 没传 = 不动这一项
    if (value === undefined) continue
    if (typeof value !== 'object' || Array.isArray(value)) continue
    next[key] = value
    touched = true
  }
  // **没有实际内容就不算一次写入**：不推进 `rev`、也不落盘。
  //
  // 这一条是防回环的：页面按 `rev` 判断"我这份是不是旧的"，如果"只带 rev 的空写"也推进
  // 版本号，另一个窗口就会以为有变化、于是回写一次 → 互相推着转。
  // （单元测试先红在这里，才有了这条注释。）
  if (!touched) return current
  try {
    mkdirSync(dirname(settingsPath(home)), { recursive: true })
    writeFileSync(settingsPath(home), JSON.stringify(next, null, 2) + '\n')
    return next
  } catch {
    return null
  }
}
