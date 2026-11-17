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

// ---------------------------------------------------------------------------
// 第二遍：`useEffect/useMemo/useCallback` 的**依赖数组**里不许出现不存在的名字。
//
// 为什么：把 `say()` 改名成 `sayBubble()` 时，函数体换了、依赖数组没换 ——
// `node --check` 通过、TDZ 检查也通过（它只查"声明前的引用"），但 React 求值依赖数组时
// 直接抛 `ReferenceError: say is not defined`，整只宠物都不渲染（页面 DOM 里连根节点都没有）。
// 这类"改完名留下的孤儿"只能靠"名字有没有声明"来抓。
//
// 判据：依赖数组只由裸标识符组成时，每个标识符都必须在本文件里有声明（含解构与形参）。
// ---------------------------------------------------------------------------
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'console', 'Math', 'JSON', 'Object', 'Array',
  'Promise', 'Date', 'Number', 'String', 'Boolean', 'Set', 'Map', 'undefined', 'null',
])

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const declared = new Set()
  const declare = (text) => {
    for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(token[0])
  }
  for (const match of source.matchAll(/^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    declared.add(match[1])
  }
  // 解构：`const [a, setA] = …` / `const { a, b: c } = …`
  for (const match of source.matchAll(/(?:const|let|var)\s*(\[[^\]]*\]|\{[\s\S]*?\})\s*=/g)) {
    declare(match[1])
  }
  // 形参：`function Pet({ catalog, pet })` 与 `(a, b) => …`
  for (const match of source.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) declare(match[1])
  for (const match of source.matchAll(/\(([^)]*)\)\s*=>/g)) declare(match[1])

  let orphans = 0
  // 依赖数组：`}, [a, b]);` —— 只认"纯标识符 + 逗号"的数组，别的（数据数组）不碰。
  for (const match of source.matchAll(/,\s*\[([^[\]]*)\]\s*\)/g)) {
    const body = match[1]
    if (!/^\s*[A-Za-z_$][\w$]*(\s*,\s*[A-Za-z_$][\w$]*)*\s*$/.test(body)) continue
    const line = source.slice(0, match.index).split('\n').length
    for (const name of body.split(',').map((part) => part.trim())) {
      if (name === '' || GLOBALS.has(name) || declared.has(name)) continue
      console.log('ORPHAN  ' + file + ':' + line
        + '  依赖数组引用了 `' + name + '`，但本文件里没有这个声明（改名后的残留？）')
      orphans += 1
    }
  }
  if (orphans > 0) {
    bad += orphans
  }
}

console.log('')
console.log(bad === 0
  ? 'OK  没有"加载期引用未初始化 const"、也没有"依赖数组里的孤儿名字"'
  : 'FAIL  发现 ' + bad + ' 处 —— 加载期那类会让**整个插件 import 失败**')
process.exit(bad === 0 ? 0 : 1)
