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

/** 要改的文件与"改什么"。`files` 里的路径相对仓库根。 */
const TARGETS = [
  { file: 'dsh-live2d-pet/package.json', edits: ['version', 'optionalDependencies'] },
  { file: 'dsh-live2d-pet-desktop/npm/desktop-win32-x64/package.json', edits: ['version'] },
  // 这份是参考副本（`npm-prepare-subpackage.mjs` 会拿它对拍），版本也要跟上。
  { file: 'dsh-live2d-pet-desktop/npm/main-package.json', edits: ['version', 'optionalDependencies'] },
]

let changed = 0
for (const target of TARGETS) {
  const path = join(ROOT, target.file)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const before = { version: json.version, optional: json.optionalDependencies?.[SUB_NAME] ?? null }
  if (target.edits.includes('version')) json.version = version
  if (target.edits.includes('optionalDependencies') && json.optionalDependencies !== undefined) {
    json.optionalDependencies[SUB_NAME] = version
  }
  const after = { version: json.version, optional: json.optionalDependencies?.[SUB_NAME] ?? null }
  const same = before.version === after.version && before.optional === after.optional
  console.log('  ' + target.file)
  console.log('      version        ' + before.version + ' → ' + after.version)
  if (before.optional !== null || after.optional !== null) {
    console.log('      optionalDep    ' + before.optional + ' → ' + after.optional)
  }
  if (!same) changed += 1
  if (!dry) writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}

console.log('')
console.log((dry ? '（dry-run）' : '') + '改了 ' + changed + ' 个文件 → ' + version)
