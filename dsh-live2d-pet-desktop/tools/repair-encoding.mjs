// 把"被 PowerShell 往返弄坏的文件"恢复回来。
//
// 损坏机制是确定的：write 工具写出 UTF-8；PowerShell 按 **ANSI/GBK** 读进来做字符串替换，
// 再按 UTF-8 写出去。于是文件里现在是"原文 UTF-8 字节被 GBK 解读后重新编码"的结果。
// 逆变换同样确定：把当前文本**按 GBK 编码回字节**，再按 **UTF-8 解码**就是原文。
//
// Node 没有 GBK 编码器，所以先建一张**全表反查**：遍历 GBK 双字节空间（约 2.3 万格），
// 用 TextDecoder('gbk') 解码，记下"字符 → 字节"。一次建表，之后每字符 O(1)。
//
//   node tools/repair-encoding.mjs <文件> [--rounds 2] [--out <输出>]
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const file = argv[0]
if (file === undefined || file.startsWith('--')) {
  console.error('用法：node tools/repair-encoding.mjs <文件> [--rounds 2] [--out <输出>]')
  process.exit(1)
}
const rounds = Number(argOf('--rounds', '2'))
const out = argOf('--out', file)

let decoder
try {
  decoder = new TextDecoder('gbk', { fatal: false })
} catch (error) {
  console.error('这个 Node 没有 GBK 解码器（ICU 不全）：' + String(error && error.message))
  process.exit(2)
}

/** 字符 → GBK 字节（全表反查，一次建好）。 */
function buildGbkTable() {
  const table = new Map()
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      const bytes = Buffer.from([lead, trail])
      const text = decoder.decode(bytes)
      // 只记单字符（合法 GBK 双字节就是 1 个字符）；已记过的不覆盖。
      if (text.length === 1 && !table.has(text)) table.set(text, [lead, trail])
    }
  }
  return table
}

const MANGLED = /锛|鐨|涓|鎵|瀵|缂|棰|妗|鍙|鏄|浠|鍒|璺|鍏|浣|鏂|鐢|鍜|鑳|鏃|鍜|鎴|鐪|鐩|鐨|妫/
const looksMangled = (text) => MANGLED.test(text)

let text = readFileSync(file, 'utf8')
if (!looksMangled(text)) {
  console.log('看起来没有乱码，不动它。')
  process.exit(0)
}
copyFileSync(file, file + '.mangled-backup')
console.log('已备份损坏版本：' + file + '.mangled-backup')

const table = buildGbkTable()
console.log('GBK 反查表：' + table.size + ' 条')

for (let round = 1; round <= rounds; round += 1) {
  const bytes = []
  let missed = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const pair = table.get(ch)
    if (pair === undefined) {
      missed += 1
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte)
      continue
    }
    bytes.push(pair[0], pair[1])
  }
  text = Buffer.from(bytes).toString('utf8')
  const still = looksMangled(text)
  console.log('第 ' + round + ' 轮：表外字符 ' + missed + '，仍乱码 = ' + still)
  if (!still) break
}

writeFileSync(out, text)
console.log('写出：' + out)
console.log('REPAIR_OK')
