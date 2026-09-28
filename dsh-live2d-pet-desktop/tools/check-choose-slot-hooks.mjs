// 一次性检查：`chooseSlotOption` 现在是普通函数声明了，里面**不能**有 hook 调用
// （React 只允许在组件/自定义 hook 的顶层调用 hook）。顺手确认区间找对了。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const lines = readFileSync(join(ROOT, 'dsh-live2d-pet', 'lib', 'client.js'), 'utf8').split('\n')
const start = lines.findIndex((line) => line.includes('function chooseSlotOption(slot, option, satisfy)'))
if (start < 0) {
  console.error('没找到 chooseSlotOption')
  process.exit(2)
}
let depth = 0
let end = start
for (let i = start; i < lines.length; i += 1) {
  for (const ch of lines[i]) {
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
  }
  if (i > start && depth <= 0) { end = i; break }
}
console.log('区间 ' + (start + 1) + ' … ' + (end + 1) + '（' + (end - start + 1) + ' 行）')

const hooks = []
const calls = []
for (let i = start; i <= end; i += 1) {
  const hook = lines[i].match(/use[A-Z][A-Za-z]+\(/g)
  if (hook !== null) hooks.push((i + 1) + ': ' + hook.join(' '))
  const call = lines[i].match(/\b([a-zA-Z_$][\w$]*)\(/g)
  if (call !== null) calls.push(...call.map((name) => name.replace('(', '')))
}
console.log(hooks.length === 0
  ? '  区间内没有 hook 调用 —— 普通函数声明是安全的'
  : '  **区间内有 hook，必须改回 useCallback 或换别的写法**:')
for (const line of hooks) console.log('    ' + line)
console.log('  区间内调用的函数（去重）: ' + JSON.stringify([...new Set(calls)].slice(0, 24)))
