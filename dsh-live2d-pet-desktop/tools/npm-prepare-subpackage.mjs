// 造出**平台子包**的内容：把编好的二进制放进 `npm/desktop-<平台>/bin/`。
//
//   node tools/npm-prepare-subpackage.mjs [--sub darwin-arm64]
//
// 不带参数就是 `win32-x64`（Windows 那条老路一个字没变）。
//
// 为什么子包目录是构建产物而不是仓库源码：二进制 9MB 上下，进 git 会让每次克隆都背着它，
// 而它完全可以从源码重建。所以这里只把 `package.json` 留在仓库里，二进制由这个脚本铺进去
// —— 与 `sidecar/page/react/`（React UMD）同一个套路。
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'
import { ensureRunnableIntegrity } from './integrity.mjs'

/**
 * 平台子包表：`--sub` 的名字 → 二进制名 + `dist/` 里那个产物名 + 主包是否必须已声明它。
 *
 * 二进制名要与 `dsh-live2d-pet/lib/desktop.js` 的 `BINARY_NAME` 一致（插件按那个名字从
 * tarball 里取），所以两边改动要一起做。
 *
 * `declared: true` = 已经发布、主包 `optionalDependencies` 里必须有一行（两平台现在都是）。
 */
const SUBS = {
  'win32-x64': { bin: 'dsh-pet-live2d-desktop.exe', built: 'DSH-Pet.exe', declared: true },
  // 2026-09-30（3.1.1）：darwin 那份已于 3.1.0 发上 npm，主包这一版起也声明它 ——
  // mac 用户装插件时会自动带上桌面端（在这之前只能从 Release 下 zip）。
  'darwin-arm64': { bin: 'dsh-pet-live2d-desktop', built: 'dsh-pet-live2d-desktop', declared: true },
}

const argv = process.argv.slice(2)
const at = argv.indexOf('--sub')
const subName = at === -1 ? 'win32-x64' : argv[at + 1]
const sub = SUBS[subName]
if (sub === undefined) {
  console.error('不认识的平台子包：' + subName + '（可选：' + Object.keys(SUBS).join(' / ') + '）')
  process.exit(1)
}

const SUB_DIR = join(DESKTOP, 'npm', 'desktop-' + subName)
const BIN_SRC = join(DESKTOP, 'dist', sub.built)
const BIN_DST = join(SUB_DIR, 'bin', sub.bin)
const MANIFEST = join(SUB_DIR, 'package.json')

if (!existsSync(BIN_SRC)) {
  console.error('没有编好的产物：' + BIN_SRC + '\n先跑 npm run build:portable')
  process.exit(1)
}
if (!existsSync(MANIFEST)) {
  console.error('缺少子包清单：' + MANIFEST)
  process.exit(1)
}

mkdirSync(join(SUB_DIR, 'bin'), { recursive: true })
copyFileSync(BIN_SRC, BIN_DST)

// macOS/Linux 上可执行位是要留在 tarball 里的（npm 会照搬 mode）——但**判断的必须是目标
// 平台，不是打包这台机器**。
//
// darwin 子包是**人工在 Windows 本机** `npm pack` / `npm publish` 的（mac 二进制只能在 CI
// 编出来、再拷回本机，见 `.dsh/skills/docs-and-workflow`）。原来写的是
// `if (process.platform !== 'win32')` —— 在那台机器上恒不成立，而 Windows 上的 tar/npm
// 都不记 Unix 权限位。于是 3.3.1 的 darwin 子包发出去是 `-rw-r--r--`，装到 mac 上
// `spawn` 直接 `EACCES`（2026-10 实测：tarball 里三个文件全是 644）。
const targetPlatform = subName.split('-')[0]
if (targetPlatform !== 'win32') {
  if (process.platform === 'win32') {
    // Windows 上 `chmodSync` 改的是另一套东西（只读位），管不了 Unix 权限位。拦不住
    // 这趟发布，但至少别让人以为"从来没这回事"。
    console.error(
      '\n⚠️  目标平台是 ' + targetPlatform + '，而打包这台机器是 Windows —— 没法给 bin/' + sub.bin
      + ' 记上可执行位。\n'
      + '   这份 tarball 装到 mac/linux 上会是 644，被拉起时 `spawn` 报 EACCES。\n'
      + '   ① 正路：**在 macOS 上跑这一步并 `npm pack`** —— CI（.github/workflows/desktop-mac.yml）\n'
      + '      已经把两件事都做了，tarball 跟着 Release 附件走，本机取回来原样 `npm publish`；\n'
      + '   ② 兜底：插件侧 `resolveDesktopBinary()` 会自己补一次 chmod，\n'
      + '      但发布物本身不该是个 644 的文件。\n',
    )
  } else {
    chmodSync(BIN_DST, 0o755)
  }
}

// **发布前的最后一道**：这份二进制要发上 npm、装到**别人机器**上。若它带着会把进程压低的
// 完整性标签（在 DSH 会话里构建出来的会带 Low），装完双击必挂 —— 用户 2026-09 就是这么
// 中招的（本地构建那份双击起不来，插件从 npm 下的那份正常）。注意是**摆成 High 而不是
// Medium**：Medium 在"资源管理器跑在 High"的机器上会连托盘都注册不上。见 `tools/integrity.mjs`。
ensureRunnableIntegrity(BIN_DST)

// 版本号与主包**必须一致**：主包的 optionalDependencies 写的就是这个版本。
const pack = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const main = JSON.parse(readFileSync(join(DESKTOP, '..', 'dsh-live2d-pet', 'package.json'), 'utf8'))
const declared = JSON.parse(readFileSync(join(DESKTOP, 'npm', 'main-package.json'), 'utf8'))
  .optionalDependencies?.[pack.name]

let mismatch = false
if (pack.version !== main.version) {
  console.error(`版本不一致：子包 ${pack.version}，主包 ${main.version} —— 子包版本必须跟着主包走`)
  mismatch = true
}
if (sub.declared && declared !== main.version) {
  console.error(
    declared === undefined
      ? `主包的 optionalDependencies 里没有 ${pack.name} —— 这一份已经发布了，必须声明`
      : `主包的 optionalDependencies 里写的是 ${declared}，但主包版本是 ${main.version}`,
  )
  mismatch = true
}
if (!sub.declared && declared !== undefined && declared !== main.version) {
  console.error(`主包的 optionalDependencies 里写的是 ${declared}，但主包版本是 ${main.version}`)
  mismatch = true
}
if (mismatch) process.exit(1)

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(2) + ' MB'
console.log('[npm-sub] ' + pack.name + '@' + pack.version)
console.log('[npm-sub] ' + sub.built + ' → ' + BIN_DST + '  ' + mb(BIN_DST))
if (declared === undefined) {
  console.log('[npm-sub] 提示：主包 optionalDependencies 还没有这一项，发布前要补（先发子包）')
}
writeFileSync(join(SUB_DIR, 'bin', '.gitkeep'), '')
console.log('NPM_SUBPACKAGE_OK')
