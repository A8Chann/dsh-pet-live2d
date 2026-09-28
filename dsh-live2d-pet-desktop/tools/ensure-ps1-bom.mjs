// 确保每个 `.ps1` 都带 UTF-8 BOM。
//
// 为什么必须：Windows PowerShell 5.1 读 `.ps1` 时**没有 BOM 就按 ANSI/GBK 解**，中文注释
// 会变成乱码，而乱码里只要出现一个引号/括号就会**语法错**（报的是"Unexpected token"，
// 指向的却是完全正常的一行）。写工具（write / edit）默认不写 BOM，所以每改一次 `.ps1`
// 都要补一次 —— 与其记住这条，不如让脚本自己检查。
//
//   node tools/ensure-ps1-bom.mjs          # 检查并补上
//   node tools/ensure-ps1-bom.mjs --check  # 只检查（CI/提交前用），缺了就以非 0 退出
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const checkOnly = process.argv.includes('--check')

/** 递归找 `.ps1`（跳过构建产物目录）。 */
function findScripts(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'target' || entry === 'node_modules' || entry === '.run' || entry === 'dist') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) findScripts(path, out)
    else if (entry.endsWith('.ps1')) out.push(path)
  }
  return out
}

const scripts = findScripts(DESKTOP)
const missing = []
for (const path of scripts) {
  const buffer = readFileSync(path)
  const hasBom = buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2]
  if (hasBom) continue
  missing.push(path)
  if (!checkOnly) writeFileSync(path, Buffer.concat([BOM, buffer]))
}

const relative = (path) => path.slice(DESKTOP.length + 1)
if (missing.length === 0) {
  console.log('PS1-BOM PASS —— ' + scripts.length + ' 个 .ps1 都带 BOM')
  process.exit(0)
}
if (checkOnly) {
  console.log('PS1-BOM FAIL —— 这些缺 BOM（PowerShell 5.1 会按 GBK 读，中文注释会解析失败）：')
  for (const path of missing) console.log('  ' + relative(path))
  process.exit(1)
}
console.log('已补 BOM：')
for (const path of missing) console.log('  ' + relative(path))
process.exit(0)
