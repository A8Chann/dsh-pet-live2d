// 造出**平台子包**的内容：把编好的 exe 放进 `npm/desktop-win32-x64/bin/`。
//
// 为什么子包目录是构建产物而不是仓库源码：exe 9MB，进 git 会让每次克隆都背着它，而它
// 完全可以从源码重建（`npm run build:portable`）。所以这里只把 `package.json` 留在仓库里，
// exe 由这个脚本铺进去 —— 与 `sidecar/page/react/`（React UMD）同一个套路。
//
//   node tools/npm-prepare-subpackage.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const SUB_DIR = join(DESKTOP, 'npm', 'desktop-win32-x64')
const EXE_SRC = join(DESKTOP, 'dist', 'DSH桌宠.exe')
const EXE_DST = join(SUB_DIR, 'bin', 'dsh-pet-live2d-desktop.exe')
const MANIFEST = join(SUB_DIR, 'package.json')

if (!existsSync(EXE_SRC)) {
  console.error('没有编好的 exe：' + EXE_SRC + '\n先跑 npm run build:portable')
  process.exit(1)
}
if (!existsSync(MANIFEST)) {
  console.error('缺少子包清单：' + MANIFEST)
  process.exit(1)
}

mkdirSync(join(SUB_DIR, 'bin'), { recursive: true })
copyFileSync(EXE_SRC, EXE_DST)

// 版本号与主包**必须一致**：主包的 optionalDependencies 写的就是这个版本。
const sub = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const main = JSON.parse(readFileSync(join(DESKTOP, '..', 'dsh-live2d-pet', 'package.json'), 'utf8'))
const declared = JSON.parse(readFileSync(join(DESKTOP, 'npm', 'main-package.json'), 'utf8'))
  .optionalDependencies?.[sub.name]

let mismatch = false
if (sub.version !== main.version) {
  console.error(`版本不一致：子包 ${sub.version}，主包 ${main.version} —— 子包版本必须跟着主包走`)
  mismatch = true
}
if (declared !== main.version) {
  console.error(`主包的 optionalDependencies 里写的是 ${declared}，但主包版本是 ${main.version}`)
  mismatch = true
}
if (mismatch) process.exit(1)

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(2) + ' MB'
console.log('[npm-sub] ' + sub.name + '@' + sub.version)
console.log('[npm-sub] exe → ' + EXE_DST + '  ' + mb(EXE_DST))
writeFileSync(join(SUB_DIR, 'bin', '.gitkeep'), '')
console.log('NPM_SUBPACKAGE_OK')
