// 一次性工具：枚举随包宠物 pet.json 的**全部历史内容**，输出 SHA-256 指纹表。
//
// 用途见 lib/index.js 里 installBundledPets() 的注释：老装机（同步记录出现之前装下的
// 副本）要能认出"这就是我们某一次发出去的那份"，认出来才敢升级。判定用的是内容哈希，
// 所以这张表必须**从 git 历史里现算**，不能手抄 —— 抄错一位就是"永远不升级"或者
// "把用户的副本覆盖掉"，两种都不会报错。
//
//   node tools/print-pet-hashes.mjs            # 给人看
//   node tools/print-pet-hashes.mjs --code     # 输出可直接粘进 index.js 的字面量
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 位置参数才是宠物名，`--code` 是开关（写成 `process.argv[2]` 时会把 `--code` 当成宠物名，
// 于是安静地输出一张空表 —— 第一次跑就是这么错的）。
const args = process.argv.slice(2)
const AS_CODE = args.includes('--code')
const PET = args.find((a) => !a.startsWith('--')) ?? 'ds-whale-girl'
const REL = 'dsh-live2d-pet/pets/' + PET + '/pet.json'

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// 全部历史（含不在当前分支上的），按时间倒序；`--follow` 会跨改名追溯。
const commits = git('log', '--all', '--follow', '--format=%H', '--', REL).trim().split('\n').filter(Boolean)
const seen = new Map()
for (const commit of commits) {
  let blob
  try {
    blob = git('rev-parse', commit + ':' + REL).trim()
  } catch {
    continue // 那个提交里这个路径还不存在（改名之前）
  }
  if (seen.has(blob)) continue
  // 原始字节直接哈希：工作区里的那份会被 git 的换行转换动过，历史 blob 不会。
  const bytes = execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', blob], { maxBuffer: 64 * 1024 * 1024 })
  seen.set(blob, createHash('sha256').update(bytes).digest('hex'))
}

const lines = [...seen.entries()].map(([blob, hash]) => ({ blob, hash }))
console.log(REL + '：' + commits.length + ' 个提交，' + lines.length + ' 份不同的内容')
for (const { blob, hash } of lines) console.log('  ' + hash.slice(0, 16) + '…  ' + blob.slice(0, 8))
if (AS_CODE) {
  console.log('\n// 复制到 lib/index.js 的 BUNDLED_PET_HASHES')
  for (const { hash } of lines) console.log("  '" + hash + "',")
}
