// **发布物判据**：tarball 里那个二进制的 Unix 权限位对不对。
//
//   node tools/check-tarball-mode.mjs <tarball> [--expect-exec <包内路径>] [--expect-nonexec <包内路径>]
//
// 为什么要有它：**Windows 上的 `tar` 与 `npm pack` 不记 Unix 权限位**，而 darwin 子包一直
// 是人工在 Windows 本机打的 —— 于是发出去的 `bin/dsh-pet-live2d-desktop` 是 644，装到 mac 上
// `spawn` 直接 `EACCES`（3.3.1 实测；3.3.2 我在 Windows 上重打，仍然是 644）。
//
// 这件事**看不出、也不会报错**：tarball 结构正常、大小正常、解出来文件也在，只有那三位
// 权限位是错的。所以它必须由一条**读 tar 头的确定性判据**来钉，不能靠"在 mac 上试一下"。
//
// 退出码：0 = 全对；1 = 判据不成立（CI 靠它拦发布）。
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const TAR_BLOCK = 512

/**
 * 列出 tar 里的条目（**不做解压**，只读头）。
 *
 * 只认常规文件与 GNU longname：这是发布物里会有的全部东西，不引 `tar` 依赖。
 * mode 在头里 offset 100、8 字节八进制（`0000755\0`）。
 */
export function listTarEntries(tar) {
  const entries = []
  let offset = 0
  let longName
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    // 全零块 = 归档结束。
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const modeText = header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 48)
    const dataStart = offset + TAR_BLOCK
    const name = longName ?? rawName
    longName = undefined
    if (typeFlag === 'L') {
      longName = tar.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '')
    } else {
      entries.push({
        name,
        mode: Number.parseInt(modeText, 8) || 0,
        size,
        typeFlag,
        body: tar.subarray(dataStart, dataStart + size),
      })
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return entries
}

/** 读一个 tarball（自动认 gzip 魔数，别赌扩展名）。 */
export function readTarball(path) {
  const raw = readFileSync(path)
  return raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
}

/** 权限位 → `0755` 这种可读形式。 */
export const formatMode = (mode) => '0' + (mode & 0o7777).toString(8).padStart(3, '0')

export const isExecutable = (mode) => (mode & 0o111) !== 0

// ---------------------------------------------------------------- CLI
//
// 判"是不是被当脚本跑的"用 `pathToFileURL` —— 别手拼 `'file://' + argv[1]`：
// 那个拼法在 Windows 上给出 `file://D:\...`（少了第三个斜杠、也没转义），与
// `import.meta.url` 永远不相等 ⇒ CLI 分支**静默不执行**、退出码恒 0 ⇒ CI 变成假绿。
// （这个坑本文件自己踩过一次，是 `npm pack` 的形状验证时顺带查出来的。）
const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isCli) {
  const argv = process.argv.slice(2)
  const tarball = argv.find((a) => !a.startsWith('--'))
  const valueAfter = (flag) => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const expectExec = valueAfter('--expect-exec')
  const expectNonexec = valueAfter('--expect-nonexec')

  if (tarball === undefined) {
    console.error('用法：node tools/check-tarball-mode.mjs <tarball> [--expect-exec <包内路径>] [--expect-nonexec <包内路径>]')
    process.exit(2)
  }

  const entries = listTarEntries(readTarball(tarball))
  const mb = (statSync(tarball).size / 1024 / 1024).toFixed(2) + ' MB'
  console.log(tarball + '  ' + mb + '  ' + entries.length + ' 个条目\n')
  const failures = []
  for (const entry of entries) {
    const exec = isExecutable(entry.mode)
    console.log('  ' + formatMode(entry.mode).padEnd(7) + (exec ? '可执行    ' : '不可执行  ')
      + String(entry.size).padStart(9) + '  ' + entry.name)
  }

  if (expectExec !== undefined) {
    const hit = entries.find((e) => e.name === expectExec)
    if (hit === undefined) {
      failures.push('tarball 里没有 ' + expectExec)
    } else if (!isExecutable(hit.mode)) {
      failures.push(expectExec + ' 是 ' + formatMode(hit.mode) + '，**没有执行位**'
        + '（装到 mac/linux 上 spawn 会报 EACCES）')
    }
  }
  if (expectNonexec !== undefined) {
    const hit = entries.find((e) => e.name === expectNonexec)
    if (hit !== undefined && isExecutable(hit.mode)) {
      failures.push(expectNonexec + ' 是 ' + formatMode(hit.mode) + '，不该有执行位')
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.log('TARBALL-MODE FAIL —— ' + failures.join('；'))
    console.log('  这份 tarball 不能发：权限位是错的，而且这一处**不会报错**，只会让用户起不来。')
    console.log('  修法：在目标平台上 `npm pack`（见 .github/workflows/desktop-mac.yml）。')
    process.exit(1)
  }
  console.log('TARBALL-MODE OK')
}
