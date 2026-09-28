// 给根 `tools/` 下的 .ps1 补/检查 UTF-8 BOM。
//
// 为什么需要单独一个：`dsh-live2d-pet-desktop/tools/ensure-ps1-bom.mjs` 只扫**那一层**的
// `tools/`，而发布脚本住在根 `tools/`。Windows PowerShell 5.1 读 .ps1 按 ANSI(GBK)，
// 中文注释会被读成乱码、把解析器带崩（症状是 `Unexpected token ')'` 报在一个完全无关的行号上 ——
// 我为这个白查了一轮）。
//
//   node tools/ensure-ps1-bom-root.mjs          补 BOM
//   node tools/ensure-ps1-bom-root.mjs --check  只检查（缺了就非 0 退出）
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const checkOnly = process.argv.includes('--check')
const dir = import.meta.dirname
const files = readdirSync(dir).filter((name) => name.endsWith('.ps1'))
let fixed = 0
let missing = 0
for (const name of files) {
  const path = join(dir, name)
  const buffer = readFileSync(path)
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  if (hasBom) continue
  missing += 1
  if (checkOnly) { console.log('  缺 BOM：' + name); continue }
  writeFileSync(path, Buffer.concat([BOM, buffer]))
  console.log('  已补 BOM：' + name)
  fixed += 1
}
if (checkOnly) {
  console.log(missing === 0
    ? 'PS1-BOM(root) PASS —— ' + files.length + ' 个 .ps1 都带 BOM'
    : 'PS1-BOM(root) FAIL —— ' + missing + ' 个缺 BOM')
  process.exit(missing === 0 ? 0 : 1)
}
console.log('PS1-BOM(root) 检查 ' + files.length + ' 个，补了 ' + fixed + ' 个')
