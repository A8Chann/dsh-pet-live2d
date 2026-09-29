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

/**
 * 平台子包表：`--sub` 的名字 → 二进制名 + `dist/` 里那个产物名 + 主包是否必须已声明它。
 *
 * 二进制名要与 `dsh-live2d-pet/lib/desktop.js` 的 `BINARY_NAME` 一致（插件按那个名字从
 * tarball 里取），所以两边改动要一起做。
 *
 * `declared: true` = 已经发布、主包 `optionalDependencies` 里必须有一行。
 * macOS 那份现在是 `false`：代码与清单就绪但**还没发上 npm**，主包先别引用它，
 * 否则用户装主包时会去找一个不存在的包（见子包 README 的"发布纪律"）。
 */
const SUBS = {
  'win32-x64': { bin: 'dsh-pet-live2d-desktop.exe', built: 'DSH桌宠.exe', declared: true },
  'darwin-arm64': { bin: 'dsh-pet-live2d-desktop', built: 'dsh-pet-live2d-desktop', declared: false },
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
// macOS/Linux 上可执行位是要留在 tarball 里的（npm 会照搬 mode）——
// 插件那边取出来之后还会 chmod 一次，但发布物本身就不该是个 644 的文件。
if (process.platform !== 'win32') chmodSync(BIN_DST, 0o755)

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
