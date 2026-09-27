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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      if (stat.isFile() && stat.size > 1024 * 1024) {
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
  return '桌面端二进制不在：装一次 `dsh plugin --profile web add ' + name + '`，'
    + '或在设置里点「下载桌面端」（若你的版本支持）。'
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
