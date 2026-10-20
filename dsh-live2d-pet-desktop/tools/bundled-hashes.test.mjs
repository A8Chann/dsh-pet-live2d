// 随包宠物的**历史指纹表两份实现必须逐字一致**（`lib/index.js` ↔ `host/catalog.rs`）。
//
// 这张表决定"用户宠物目录里那份是不是我们发出去的原样副本"——认出来才敢升级，认不出来
// 就一个字都不碰。所以少了任何一个哈希，那一版装机的用户就**永远拿不到宠物更新**，而且
// 没有任何报错：`probe-catalog.mjs` 只对拍 catalog 与资产字节，根本碰不到这张表。
//
// 这条分叉真实发生过：PR #5 把 1.1.1 的指纹补进了 JS 侧，漏了 Rust 侧（桌面端的宠物
// 同步走的是 Rust 那份）。症状是"网页端升级会更新宠物、桌面端不更新"，两边都静默。
//
//   node --test tools/bundled-hashes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, DESKTOP } from './paths.mjs'

const JS_HOST = join(PLUGIN, 'lib', 'index.js')
const RS_HOST = join(DESKTOP, 'src-tauri', 'src', 'host', 'catalog.rs')
/** 随包宠物本体：表里的每条都该是一个**能对上老装机**的历史版本。 */
const BUNDLED_PET = join(PLUGIN, 'pets', 'ds-whale-girl', 'pet.json')

const HASH_RE = /['"]([0-9a-f]{64})['"]/g

/**
 * 从一个源码文件里抠出 `BUNDLED_PET_HASHES` 那一段的哈希。
 *
 * 按文本抠而不是 import/编译：JS 那份是 ESM 常量（可以 import），Rust 那份只能读文本；
 * 用同一套文本规则取两份，才不会因为"一边取少了"而假绿（这正是要防的错）。
 */
function hashesIn(source, anchor) {
  const at = source.indexOf('BUNDLED_PET_HASHES')
  assert.notEqual(at, -1, anchor + ' 里找不到 BUNDLED_PET_HASHES')
  const tail = source.slice(at)
  // 表后面紧跟的是同文件里别的东西：取到下一个空行 + 顶格 `}` 为止，够用且不会跨段。
  const end = tail.search(/\n\];|\n\}\n/)
  const segment = end < 0 ? tail : tail.slice(0, end)
  const found = []
  for (const match of segment.matchAll(HASH_RE)) {
    if (!found.includes(match[1])) found.push(match[1])
  }
  return found
}

const jsHashes = hashesIn(readFileSync(JS_HOST, 'utf8'), 'lib/index.js')
const rsHashes = hashesIn(readFileSync(RS_HOST, 'utf8'), 'host/catalog.rs')

test('两份实现都读到了非空的历史指纹表（防空转）', () => {
  // 没有这一条时，下面那条"两边相等"在两边都为 [] 时也会通过 —— 一条永远绿的断言。
  assert.ok(jsHashes.length >= 5, 'js 表太小：' + JSON.stringify(jsHashes))
  assert.ok(rsHashes.length >= 5, 'rust 表太小：' + JSON.stringify(rsHashes))
})

test('JS 侧有的每一个指纹，Rust 侧都有', () => {
  const missing = jsHashes.filter((hash) => !rsHashes.includes(hash))
  assert.deepEqual(missing, [], '桌面端缺这些指纹（那一版装机的用户拿不到宠物更新）：' + missing.join(', '))
})

test('Rust 侧有的每一个指纹，JS 侧也有', () => {
  const missing = rsHashes.filter((hash) => !jsHashes.includes(hash))
  assert.deepEqual(missing, [], '网页端缺这些指纹：' + missing.join(', '))
})

test('表里每条都是 64 位小写十六进制的 SHA-256', () => {
  for (const hash of [...jsHashes, ...rsHashes]) {
    assert.match(hash, /^[0-9a-f]{64}$/)
  }
})

test('随包那份自己**不能**在表里（表只收改动之前发过的版本）', () => {
  // 一旦把当前那份也塞进表，语义就乱了：它永远对得上，于是"目标就是我们上次装的"这条
  // 判定会把自己当成历史，升级链断在这里也看不出来。
  const current = createHash('sha256').update(readFileSync(BUNDLED_PET)).digest('hex')
  assert.equal(jsHashes.includes(current), false, '随包 pet.json 的指纹不该进表')
  assert.equal(rsHashes.includes(current), false, '随包 pet.json 的指纹不该进表（rust）')
})
