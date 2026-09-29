// Windows 完整性标签（integrity level）的检查与摆正。
//
// **完整性标签是"上限"，不是"下限"** —— 这一点是 2026-09 绕了一大圈才彻底搞清的：
// 进程的完整性级别 = min(启动者令牌, exe 文件上的标签)。所以给产物**贴任何低于令牌的
// 标签都是自伤**：
//
//   * 贴 `Low`（在 DSH 会话里构建出来的产物会这样，沙箱给工作区新文件打的就是 Low）：
//     双击后进程也是 Low ⇒ **写不进 `%DSH_HOME%`**（`拒绝访问 (os error 5)`）、建不了
//     `%LOCALAPPDATA%\<id>\EBWebView`（WebView2 `0x800700AA`）、**托盘也注册不上**。
//     用户 2026-09 报的"双击没显示"就是这一条。
//   * 贴 `Medium`（**这是我当时"修"它的办法 —— 错的**）：进程被压到 Medium ⇒ 在那台
//     **资源管理器本身跑在 High 的机器上**（UAC 关闭 ⇒ 整台机器都是 High）时，Medium 进程
//     给 shell 的托盘消息会被 UIPI 拦掉 ⇒ `Shell_NotifyIcon(NIM_ADD)` 返回 FALSE、
//     `GetLastError=5`（ACCESS_DENIED）⇒ **托盘里永远没有她**，而进程、窗口、宠物全正常。
//     同一台机器上换成 High（或干脆没有标签）立刻就好 —— A/B 实测：
//       Low ⇒ NIM_ADD=False；设成 High ⇒ True；无标签 ⇒ True；Medium ⇒ False。
//     用户在**另一台**电脑上一切正常，正是因为那台机器的资源管理器是 Medium。
//   * **没有标签**（或 `High`）：进程跟着启动者走 —— 本机 High（有托盘）、普通机器 Medium
//     （也有托盘）。这才是产物出厂该有的样子。
//
// ⇒ 所以产物出库前该做的不是"摆成 Medium"，而是**确保没有把进程压低的标签**：
// 没标签最好；被目录"传染"了 Low/Medium 就摆成 **High**（等于"不设上限"）。
import { execFileSync } from 'node:child_process'

/** 读一个路径的完整性标签（读不到就返回 undefined）。 */
export function integrityLabel(path) {
  try {
    const output = execFileSync('icacls', [path], { encoding: 'utf8' })
    const line = String(output)
      .split(/\r?\n/)
      .find((candidate) => /Mandatory Label/i.test(candidate))
    return line === undefined ? undefined : line.trim()
  } catch {
    return undefined
  }
}

/** 标签里写的是哪一档（`Low` / `Medium` / `High` / `System`），读不出来返回 undefined。 */
export function integrityRank(path) {
  const label = integrityLabel(path)
  if (label === undefined) return undefined
  const found = /Mandatory Label\\(\w+)/i.exec(label)
  return found === null ? undefined : found[1]
}

/**
 * 保证这个文件**不会把进程压低**（Windows 上才有意义）。
 *
 *   * 没有显式标签 ⇒ 继承目录 ⇒ 放行（这是最理想的）；
 *   * 标签是 `High` / `System` ⇒ 放行（不设上限）；
 *   * 标签是 `Low` / `Medium` ⇒ **摆成 `High`**（不是 Medium！见文件头那段血泪），再复查；
 *   * 摆不正 ⇒ 抛错（调用方负责让构建失败）。
 *
 * 非 Windows 直接放行（那边没有这套机制）。
 */
export function ensureRunnableIntegrity(path, log = console.log) {
  if (process.platform !== 'win32') return
  const label = integrityLabel(path)
  if (label === undefined) {
    log('  完整性标签：无（继承目录，跟着启动者走 —— 最理想）')
    return
  }
  const rank = integrityRank(path)
  if (rank === undefined) {
    log('  （读不出完整性标签的档位，跳过检查）')
    return
  }
  if (rank === 'High' || rank === 'System') {
    log('  完整性标签：' + rank + '（不设上限，放行）')
    return
  }
  log('  ⚠️ 这个文件带 ' + rank + ' 标签 —— 它会把进程压到 ' + rank + '，正在摆成 High：')
  log('     ' + label)
  execFileSync('icacls', [path, '/setintegritylevel', 'High'], { stdio: 'inherit' })
  const after = integrityRank(path)
  if (after === undefined || (after !== 'High' && after !== 'System')) {
    throw new Error(
      '完整性标签摆正失败（还是 ' + String(after) + '）：' + path +
      '\n带 Low/Medium 标签的 exe 双击起来会：写不进 %DSH_HOME%、建不了 WebView2 数据目录，' +
      '在资源管理器跑在 High 的机器上还会**注册不了托盘**（GetLastError=5）。' +
      '\n手动修：icacls "<路径>" /setintegritylevel High',
    )
  }
  log('     → ' + after)
}

// 兼容旧名字：早期调用点还写着 `ensureNotLowIntegrity`（那时以为"摆成 Medium 就行"）。
export const ensureNotLowIntegrity = ensureRunnableIntegrity
