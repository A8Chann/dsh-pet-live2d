// **发版：抬版本号**（3.0.0）。四个文件必须一致 —— 少一个就会出现"子包版本跟主包不一致"
// 或者 `optionalDependencies` 指向一个不存在的版本（装插件时静默跳过，桌面端就没了）。
//
//   node tools/bump-version.mjs 3.0.0 [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 仓库根 = 这个文件的上两级（`<repo>/tools/bump-version.mjs`）。
// 不 import desktop 那层的 `paths.mjs`：根 `tools/` 与它没有依赖关系，少一条耦合。
const ROOT = join(import.meta.dirname, '..')

const version = process.argv[2]
const dry = process.argv.includes('--dry-run')
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node tools/bump-version.mjs <x.y.z> [--dry-run]')
  process.exit(2)
}

const SUB_NAME = 'dsh-pet-live2d-desktop-win32-x64'
// 主包 `optionalDependencies` 里**每一行平台子包**都要跟着抬（3.1.1 起 darwin 也进来了）。
// 漏掉它的后果：mac 用户装主包时去找一个版本不存在的子包 —— npm 会**静默跳过**，
// 桌面端就这么消失了（正是"发布纪律：先子包后主包"要防的那类事故）。
const SUB_NAMES = [SUB_NAME, 'dsh-pet-live2d-desktop-darwin-arm64']

/** 要改的文件与"改什么"。`files` 里的路径相对仓库根。 */
const TARGETS = [
  { file: 'dsh-live2d-pet/package.json', edits: ['version', 'optionalDependencies'] },
  { file: 'dsh-live2d-pet-desktop/npm/desktop-win32-x64/package.json', edits: ['version'] },
  // ⚠️ 平台子包**每一个**都要在这里 —— 漏一个的后果不是"少改一处"，而是
  // `npm-prepare-subpackage.mjs` 的版本一致性校验直接红（CI 第 10 步），
  // 整个 mac 构建白跑。2026-09-29 发 3.1.0 时就是这么红的：只抬了 win 子包。
  { file: 'dsh-live2d-pet-desktop/npm/desktop-darwin-arm64/package.json', edits: ['version'] },
  // 这份是参考副本（`npm-prepare-subpackage.mjs` 会拿它对拍），版本也要跟上。
  { file: 'dsh-live2d-pet-desktop/npm/main-package.json', edits: ['version', 'optionalDependencies'] },
]

let changed = 0
for (const target of TARGETS) {
  const path = join(ROOT, target.file)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const optionalOf = (source) => SUB_NAMES.map((name) => name + '@' + (source.optionalDependencies?.[name] ?? '—')).join(', ')
  const before = { version: json.version, optional: optionalOf(json) }
  if (target.edits.includes('version')) json.version = version
  if (target.edits.includes('optionalDependencies') && json.optionalDependencies !== undefined) {
    for (const name of SUB_NAMES) {
      if (json.optionalDependencies[name] !== undefined) json.optionalDependencies[name] = version
    }
  }
  const after = { version: json.version, optional: optionalOf(json) }
  const same = before.version === after.version && before.optional === after.optional
  console.log('  ' + target.file)
  console.log('      version        ' + before.version + ' → ' + after.version)
  if (before.optional !== after.optional || before.optional.includes('@')) {
    console.log('      optionalDep    ' + before.optional + ' → ' + after.optional)
  }
  if (!same) changed += 1
  if (!dry) writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}

console.log('')
console.log((dry ? '（dry-run）' : '') + '改了 ' + changed + ' 个文件 → ' + version)
