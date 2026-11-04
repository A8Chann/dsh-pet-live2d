// 界面文案对照表（`UI_EN`）的静态检查 —— 纯 node，不需要浏览器。
//
// 它盯的是「漏翻 / 翻错位 / 翻串了」这三类只在英文界面里才看得见的问题：
//
//   1. `client.js` 里每个 `t("…")` 的 key 都必须在 `UI_EN` 里（否则英文界面里夹一句中文，
//      而且**不报错**）；
//   2. `UI_EN` 里不许有重复 key（对象字面量重复键会静默后者覆盖前者）；
//   3. 译文里不许再出现中文（漏译最常见的样子就是照抄）；
//   4. 表里每个 key 在 `client.js` 里**真的出现过**（翻完了但代码又改回中文的话，
//      这条就会红，免得表越攒越脏）；
//   5. **身份字符串不许进表**：槽位 id / 选项标签 / 动作组 / `looksByPhase` 的值这些
//      按字符串相等比较或写进存档，翻一个就静默失效。
//
//   node --test dsh-live2d-pet-desktop/tools/ui-strings.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN } from './paths.mjs'

const SOURCE = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')

/** 从源码里取出 `const UI_EN = { … }` 的对象字面量并求值。 */
function readDictionary() {
  const start = SOURCE.indexOf('const UI_EN = {')
  assert.notEqual(start, -1, 'client.js 里找不到 UI_EN')
  let index = SOURCE.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let at = index; at < SOURCE.length; at += 1) {
    const ch = SOURCE[at]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = at + 1; break }
    }
  }
  assert.notEqual(end, -1, 'UI_EN 的对象字面量没有闭合')
  const literal = SOURCE.slice(index, end)
  // 对象字面量里只有字符串键值，求值安全；重复键在严格模式下会抛，正好也测出来。
  return new Function('"use strict"; return (' + literal + ');')()
}

/** `client.js` 里所有 `t("…")` 的 key（用与 codemod 相同的小扫描思路，跳过注释）。 */
function readCallSites() {
  const keys = []
  let index = 0
  while (index < SOURCE.length) {
    const ch = SOURCE[index]
    const next = SOURCE[index + 1]
    if (ch === '/' && next === '/') { const nl = SOURCE.indexOf('\n', index); index = nl < 0 ? SOURCE.length : nl; continue }
    if (ch === '/' && next === '*') { const close = SOURCE.indexOf('*/', index + 2); index = close < 0 ? SOURCE.length : close + 2; continue }
    if ((ch === '"' || ch === "'" || ch === '`')) {
      const quote = ch
      const start = index
      index += 1
      while (index < SOURCE.length) {
        if (SOURCE[index] === '\\') { index += 2; continue }
        if (SOURCE[index] === quote) break
        index += 1
      }
      // 前一个非空白字符是 `(`、再往前是 `t`，且 `t` 前面不能是字母（`createElement(` 也以 `t(`
      // 结尾 —— 第一版就是这么把 "script" / "div" 当成文案的）。
      const before = SOURCE.slice(Math.max(0, start - 8), start)
      if (/(^|[^A-Za-z0-9_$.])t\(\s*$/.test(before) && quote !== '`') {
        keys.push(SOURCE.slice(start + 1, index))
      }
      index += 1
      continue
    }
    index += 1
  }
  return keys
}

const dictionary = readDictionary()
const callSites = readCallSites()

test('每个 t("…") 都能在对照表里查到', () => {
  const missing = [...new Set(callSites.filter((key) => dictionary[key] === undefined))]
  assert.deepEqual(missing, [], '这些文案没有英文：' + JSON.stringify(missing))
})

test('对照表里的 key 在 client.js 里真的出现过（别攒死键）', () => {
  const unused = Object.keys(dictionary).filter((key) => !callSites.includes(key))
  assert.deepEqual(unused, [], '这些 key 已经不在代码里了：' + JSON.stringify(unused))
})

test('译文里不许再有中文（空串只允许是去掉了词缀的片段）', () => {
  const bad = Object.entries(dictionary)
    .filter(([zh, english]) => {
      if (typeof english !== 'string') return true
      if (/[\u4e00-\u9fff]/.test(english)) return true
      // 空串只对"两边带空格的片段"合法：`" 段"` 这种英文里没有对应词缀（`第 N 段` → `Part N`），
      // 删掉才是对的。独立的空标签不行。
      if (english.trim() === '') return !/^\s|\s$/.test(zh)
      return false
    })
    .map(([zh, english]) => zh + ' → ' + JSON.stringify(english))
  assert.deepEqual(bad, [], '这些译文不合格：' + JSON.stringify(bad))
})

test('身份字符串不许进对照表', () => {
  // 与 pet.json 里身份字段同名的值：选项标签、动作组、表情名、内置反应标签。
  const identity = [
    '圆眼镜', '方眼镜', '椭圆眼镜', '墨镜', '猫猫', '兔兔', '蝴蝶结', '摘掉发箍', '单边马尾',
    '头顶鲸', '放桌上', '巴菲', '掏出手机', '喵喵手', '双手比耶', '挤番茄酱', '写本本',
    '自拍', '快速自拍', '撤回', '画笔', '橡皮', '蛋包饭', '星星眼', '爱心眼', '呆呆眼', '晕晕',
    '阴暗', '开心兴奋', '悲伤', '大哭', '生气', '调皮', '闭眼口水', '吐魂', '吐舌', '吹泡泡糖',
    '问号', '感叹号', '流汗', '情绪花花', '心跳', '冒爱心', '脸红', '手机换色', '点菜按下',
    '重锤出击', '待机',
  ]
  const leaked = identity.filter((label) => Object.prototype.hasOwnProperty.call(dictionary, label))
  assert.deepEqual(leaked, [], '这些是身份字符串，不能翻：' + JSON.stringify(leaked))
})
