// Windows 完整性标签（integrity level）的检查与摆正。
//
// 为什么需要它：**在 DSH 会话里写出来的文件会带 Low 完整性标签**（沙箱给工作区里的
// 新文件打的就是 Low）。而 Windows 的 no-write-up 规则是"低完整性进程不能写更高完整性
// 的对象"——于是一个被打上 Low 标签的 exe，双击起来后**写不进 `%DSH_HOME%`**（`拒绝访问
// (os error 5)`），也建不了 `%LOCALAPPDATA%\<id>\EBWebView`（WebView2 报
// `0x800700AA 请求的资源在使用中`）。
//
// 用户 2026-09 报的"直接跑 exe 没显示"最后就落在这一条上：本地构建的那份（在会话里产出的）
// 双击必挂，而插件从 npm 下载的那份（普通进程写的、没有标签）一切正常 —— 同一个 exe
// 二进制、同一个版本，只差一个标签。
//
// 所以**产物出库前必须过一道这个检查**，摆不正就报错（宁可不发布，也不要发一个必然起不来的包）。
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

/**
 * 保证这个文件**不是 Low 完整性**（Windows 上才有意义）。
 *
 *   * 没有显式标签 ⇒ 继承目录 ⇒ 一般为 Medium，放行；
 *   * 已经是 Low ⇒ 用 `icacls /setintegritylevel Medium` 摆正，再复查一遍；
 *   * 摆不正 ⇒ 抛错（调用方负责让构建失败）。
 *
 * 非 Windows 直接放行（那边没有这套机制）。
 */
export function ensureNotLowIntegrity(path, log = console.log) {
  if (process.platform !== 'win32') return
  const before = integrityLabel(path)
  if (before === undefined) {
    log('  （读不出完整性标签，跳过检查）')
    return
  }
  if (!/Low/i.test(before)) {
    log('  完整性标签：' + before)
    return
  }
  log('  ⚠️ 这个文件带 Low 完整性标签（在 DSH 会话里构建的产物会这样）—— 正在摆正：')
  log('     ' + before)
  execFileSync('icacls', [path, '/setintegritylevel', 'Medium'], { stdio: 'inherit' })
  const after = integrityLabel(path)
  if (after === undefined || /Low/i.test(after)) {
    throw new Error(
      '完整性标签摆正失败（还是 Low）：' + path +
      '\n双击这个 exe 会起不来：Low 进程写不进 %DSH_HOME%，也建不了 WebView2 的数据目录。' +
      '\n手动修：icacls "<路径>" /setintegritylevel Medium /T',
    )
  }
  log('     → ' + after)
}
