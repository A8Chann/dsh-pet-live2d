// 桌面端二进制的定位（宿主半区）。
//
// 桌宠有两条呈现路径：**页面内**（本插件自己渲染，随 DSH 启停）与**桌面上**（一个原生
// 窗口进程，DSH 关掉她也能站着）。后者需要一个二进制，它由**平台子包**随主包一起装：
//
//   Windows x64  dsh-pet-live2d-desktop-win32-x64   （声明了 os/cpu，别的平台装不上）
//   将来的       …-darwin-arm64 / …-linux-x64       （同一个解析器，加一行清单即可）
//
// 为什么用"平台子包 + optionalDependencies"而不是把 exe 塞进主包：非 Windows 用户不该
// 为一个跑不了的 9MB 买单，而 npm 的 `os`/`cpu` 字段正好能让不匹配的平台**静默跳过**。
// 于是 Windows 用户装完就能用（无感），macOS 用户装完没这一项（也无感、不报错）。
//
// 解析顺序是**从"用户显式指定"到"包管理器装的"再到"我们自己下过的"**，每一步都有它存在的
// 理由，见下面 resolveDesktopBinary 的注释。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gunzipAsync = promisify(gunzip)

const HERE = dirname(fileURLToPath(import.meta.url))

/** 当前平台对应的子包名（没有就是"这个平台还没有桌面版"）。 */
export function desktopPackageName(platform = process.platform, arch = process.arch) {
  const table = {
    'win32-x64': 'dsh-pet-live2d-desktop-win32-x64',
    // 将来加构建时在这里补：'darwin-arm64' / 'linux-x64' …
  }
  return table[platform + '-' + arch]
}

/** 子包里 exe 的相对路径（各平台同一个名字，省得再分叉）。 */
const BINARY_NAME = {
  win32: 'dsh-pet-live2d-desktop.exe',
  darwin: 'dsh-pet-live2d-desktop',
  linux: 'dsh-pet-live2d-desktop',
}

/** 主包版本（子包版本必须与它一致，`tools/npm-prepare-subpackage.mjs` 会校）。 */
function ownVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 找 `node_modules/<name>`：从插件自己的位置**逐级向上**找。
 *
 * 为什么要向上找：装法有三种，落点不一样 ——
 *   * 直接从仓库装（`github:…#path:/dsh-live2d-pet`）：插件在 `…/node_modules/dsh-pet-live2d/`，
 *     子包与它**同级**；
 *   * 从 npm 装在 profile 里：同样同级；
 *   * pnpm 的隔离布局：真身在 `.pnpm/<name>/node_modules/…`，同级看到的可能是软链。
 * 只要从插件目录向上几层里任一处的 `node_modules/<name>` 存在，就是它。
 */
function findInNodeModules(name, from = HERE) {
  let dir = resolve(from)
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 我们自己下过的那份放哪儿（惰性下载兜底、或用户手动放的）。 */
export function managedBinPath(home) {
  return join(home, 'bin', BINARY_NAME[process.platform] ?? 'dsh-pet-live2d-desktop')
}

/**
 * 定位桌面端二进制。
 *
 * 顺序与理由：
 *   1. `DSH_PET_DESKTOP_BIN` —— 用户/测试显式指定，永远最优先（排查时不至于被"包里的
 *      那份"盖住）；
 *   2. 平台子包 —— 正常路径，装插件时就带下来了；
 *   3. `%DSH_HOME%\bin\` —— 我们自己下的那份，或者用户手动放的；
 *   4. 插件包旁边的 `desktop-bin/` —— 开发期（`dsh-live2d-pet-desktop` 就在仓库里时）。
 *
 * @returns {{ path: string, source: string, size: number } | undefined}
 */
export function resolveDesktopBinary(options = {}) {
  const home = options.home
  const name = desktopPackageName()
  const candidates = []

  const explicit = process.env.DSH_PET_DESKTOP_BIN
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    candidates.push([resolve(explicit.trim()), 'env:DSH_PET_DESKTOP_BIN'])
  }
  if (name !== undefined) {
    const pack = findInNodeModules(name)
    if (pack !== undefined) {
      candidates.push([join(pack, 'bin', BINARY_NAME[process.platform]), 'package:' + name])
    }
  }
  if (typeof home === 'string' && home !== '') {
    candidates.push([managedBinPath(home), 'managed'])
  }
  candidates.push([join(HERE, '..', 'desktop-bin', BINARY_NAME[process.platform]), 'repo-dev'])

  for (const [path, source] of candidates) {
    try {
      const stat = statSync(path)
      // 下限 32KB：不是为了"差不多就行"，而是为了**排除把网页当二进制**——
      // 404 的 HTML、package.json、占位文件都远小于它，而真二进制 9MB。
      // （原来写 1MB，结果夹具里的 1MB 整文件被挡在门外 —— 阈值该贴着"要排除什么"定，
      // 不该拍一个看起来很大的数。）
      if (stat.isFile() && stat.size > 32 * 1024) {
        return { path, source, size: stat.size }
      }
    } catch {
      /* 下一个 */
    }
  }
  return undefined
}

/** 这个平台有没有桌面版（没有时设置里那一项要灰掉并说明原因）。 */
export function desktopSupported(platform = process.platform, arch = process.arch) {
  return desktopPackageName(platform, arch) !== undefined
}

/**
 * 给用户看的一句话：怎么才能有桌面版。
 *
 * 分三种情况说清楚 —— "本平台还没有构建"和"装的时候被跳过了"是两件不同的事，
 * 混在一起说会让用户去装一个根本不存在的东西。
 */
export function desktopHint(options = {}) {
  const name = desktopPackageName()
  if (name === undefined) {
    return `本平台（${process.platform}-${process.arch}）还没有桌面版构建；她可以一直在 DSH 页面里。`
  }
  const found = resolveDesktopBinary(options)
  if (found !== undefined) return '桌面端已就绪（' + found.source + '）'
  return '点「下载桌面端」拉一份（约 5MB）'
}

/** 版本一致性：子包版本与主包不一致时给出提示（发布时最容易搞错的一处）。 */
export function desktopVersionCheck(options = {}) {
  const name = desktopPackageName()
  if (name === undefined) return { ok: true, reason: 'unsupported-platform' }
  const pack = findInNodeModules(name)
  if (pack === undefined) return { ok: true, reason: 'not-installed' }
  try {
    const version = JSON.parse(readFileSync(join(pack, 'package.json'), 'utf8')).version
    return { ok: version === ownVersion(), reason: version, expected: ownVersion() }
  } catch {
    return { ok: true, reason: 'unreadable' }
  }
}

// ---------------------------------------------------------------- 惰性下载
//
// 为什么需要它：`optionalDependencies` 是**装插件那一刻**解析的，"用户点了开关才下载"做不到。
// 于是没带上那份二进制的情况是真实存在的 —— `--no-optional`、手动删过 node_modules、
// 或以后加了别的平台。这时**不该甩给用户一个 GitHub 链接**。
//
// 走 npm 自己的 tarball（不是 GitHub Release）：
//   * 不用我们搭服务器、没有 GitHub 的 60 次/小时限流；
//   * 平台子包在 npm 上就是给"按平台分发二进制"设计的（esbuild / swc / ripgrep 都这么发）；
//   * Cubism Core 已经嵌在 exe 里，所以**不需要**再单独下任何东西。
//
// 一个**极小的 tar 解析器**：不引 `tar` 依赖（插件包要保持精简），而 GNU/ustar 的头格式
// 稳定且我们有明确的文件名要找（`package/bin/<exe>`）。chunked 在别处踩过，这里同理只认
// **未压缩长度**已知的常规文件。

const TAR_BLOCK = 512

/** 从一个 tar 里取出指定路径的文件内容（够用即止，不做链接/稀疏文件）。 */
export function readFileFromTar(buffer, wantedPath) {  let offset = 0
  let longName
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // 全零块 = 归档结束。
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText, 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 48)
    const dataStart = offset + TAR_BLOCK
    const name = longName ?? rawName
    longName = undefined
    if (typeFlag === 'L') {
      // GNU longname：这块的内容是下一个条目的真实路径。
      longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '')
    } else if (name === wantedPath || name === './' + wantedPath) {
      return buffer.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return undefined
}

/**
 * 从 npm 拉平台子包，把 exe 放到"我们自己管的那份"路径下（`%DSH_HOME%\bin\`）。
 *
 * 解析器的顺序里 `managedBinPath` 就在子包之后，所以下完之后**不需要重启**就找得到。
 */
export async function downloadDesktopBinary(options = {}) {
  const { home, log } = options
  const name = desktopPackageName()
  if (name === undefined) return { ok: false, reason: 'unsupported-platform' }
  if (typeof home !== 'string' || home === '') return { ok: false, reason: 'no-home' }
  const version = ownVersion()
  const registry = options.registry ?? 'https://registry.npmjs.org'
  const note = (message) => { if (typeof log === 'function') log('[desktop] ' + message) }

  // 先问注册表要 tarball 地址（而不是拼 URL）：镜像/私有源都能跟着走。
  let tarballUrl = registry + '/' + name + '/-/' + name + '-' + version + '.tgz'
  try {
    const response = await fetch(registry + '/' + encodeURIComponent(name), { headers: { accept: 'application/json' } })
    if (response.ok) {
      const meta = await response.json()
      const url = meta?.versions?.[version]?.dist?.tarball
      if (typeof url === 'string' && url.startsWith('https://')) tarballUrl = url
    }
  } catch {
    /* 用上面拼的那个兜底 */
  }

  note('下载 ' + tarballUrl)
  let bytes
  try {
    const response = await fetch(tarballUrl)
    if (!response.ok) return { ok: false, reason: 'download-failed', status: response.status, url: tarballUrl }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return { ok: false, reason: 'download-failed', detail: String(error && error.message), url: tarballUrl }
  }

  // npm 的 tarball 是 gzip。绝大多数情况下它就是这样，但**别赌**：万一拿到的是未压缩的
  // tar（镜像/代理改过、或响应头骗人），gzip 解压会抛一个看不懂的错。这里按魔数认
  // （`1f 8b` 是 gzip），不是 gzip 就当成裸 tar 直接用。
  let tar
  try {
    tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipAsync(bytes) : bytes
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: 'gunzip: ' + String(error && error.message) }
  }

  let inner
  try {
    inner = readFileFromTar(tar, 'package/bin/' + BINARY_NAME[process.platform])
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: String(error && error.message) }
  }
  if (inner === undefined) return { ok: false, reason: 'binary-not-in-tarball', url: tarballUrl }

  const target = managedBinPath(home)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, inner)
    if (process.platform !== 'win32') chmodSync(target, 0o755)
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: String(error && error.message), target }
  }
  note('已写入 ' + target + '（' + (inner.length / 1024 / 1024).toFixed(2) + ' MB）')
  return { ok: true, path: target, bytes: inner.length, url: tarballUrl }
}

/** 下一句该干什么（设置页那一行直接用它，不自己编词）。 */
export function desktopNextStep(options = {}) {
  const name = desktopPackageName()
  if (name === undefined) return '本平台还没有桌面版构建'
  return resolveDesktopBinary(options) === undefined ? '点「下载桌面端」拉一份（约 5MB）' : ''
}
