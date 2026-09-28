// **模块加载期 TDZ 检查**：找"在声明之前就被求值"的顶层 const 引用。
//
// 为什么需要它：这类错**不是语法错**（`node --check` 干净通过），而是运行期抛
// `Cannot access 'X' before initialization` —— 症状是**整个插件 import 失败**，
// 页面直接变成 "Failed to load plugins"。我踩过一次：把
// `const SHARED_KEYS = { overrides: OVERRIDE_KEY, … }` 写在 `OVERRIDE_KEY` 声明之前。
//
// 规则（只查最外层 `const NAME = <字面量>` 这种"加载期就会求值"的声明）：
//   * 收集所有顶层 `const`/`let`/`function` 的名字与出现行号；
//   * 对每个**字面量**初始化器（`{…}` / `[…]` / 字符串 / 数字 / 模板串），取出里面
//     引用到的标识符；若某个标识符的声明行号 > 使用处行号 ⇒ 报错。
//
// 函数体、箭头函数、方法里的引用**不算**（那些是调用期才求值）。
//
//   node tools/check-client-tdz.mjs [文件…]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [join(ROOT, 'dsh-live2d-pet', 'lib', 'client.js')]

let bad = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  // 先收集所有顶层声明（缩进 <= 2 空格）的名字 → 行号
  const declarations = new Map()
  const declRe = /^\s{0,2}(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/
  for (let i = 0; i < lines.length; i += 1) {
    const match = declRe.exec(lines[i])
    if (match !== null && !declarations.has(match[1])) declarations.set(match[1], i + 1)
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const match = /^\s{0,2}(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line)
    if (match === null) continue
    const initializer = match[2]
    // 只查"加载期会求值"的初始化器：对象/数组/字面量/模板串/三元的字面量分支。
    // 函数、箭头函数、new、调用一律跳过（调用期才求值）。
    if (/^\s*(async\s+)?(function\b|\()/.test(initializer)) continue
    if (/=>/.test(initializer)) continue
    if (/^\s*new\s/.test(initializer)) continue

    const used = new Set()
    for (const token of initializer.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) used.add(token[1])
    for (const name of used) {
      const at = declarations.get(name)
      if (at === undefined) continue              // 不是本文件声明的（import / 全局）
      if (at <= i + 1) continue                   // 声明在使用之前（或同一行）⇒ 没问题
      console.log('TDZ  ' + file + ':' + (i + 1)
        + '  初始化器引用了 `' + name + '`，但它在第 ' + at + ' 行才声明')
      console.log('     ' + line.trim().slice(0, 110))
      bad += 1
    }
  }
}

console.log('')
console.log(bad === 0
  ? 'OK  没有"加载期引用未初始化 const"的地方'
  : 'FAIL  发现 ' + bad + ' 处 —— 这些会让**整个插件 import 失败**')
process.exit(bad === 0 ? 0 : 1)
