// 套件计时：慢在哪。
//
// 两个互补的视角，缺一个都会猜错：
//
//   * **总体**：每个 driver 的墙钟时间（串行跑一遍，好对比）；
//   * **构成**：把每个 driver 源码里的 `sleep` 加总 —— "固定等待"和"轮询等待"是两种东西，
//     前者是纯粹的浪费（条件早就满足了也得等满），后者已经是最优形态。
//
// 光看墙钟时间会得出"gaze 慢"这种没用的结论；光看 sleep 总和会漏掉浏览器启动与 CDP 往返。
//
//   node tools/suite-budget.mjs                 # 只做静态统计（秒级出结果）
//   node tools/suite-budget.mjs --run           # 再串行跑一遍，量真实墙钟
//   node tools/suite-budget.mjs --run --jobs 3  # 指定并发
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUITE } from '../run-suite.mjs'
import { HERE } from '../paths.mjs'

const argv = process.argv.slice(2)
const shouldRun = argv.includes('--run')
const jobsFlag = argv.indexOf('--jobs')
const jobs = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : 1

/** 把源码里所有字面量 sleep 加总（轮询里的那种小 sleep 也在内，但量级看得出区别）。 */
function sleepBudget(source) {
  let total = 0
  let count = 0
  for (const match of source.matchAll(/sleep\(\s*(\d+)\s*\)/g)) {
    total += Number(match[1])
    count += 1
  }
  return { ms: total, count }
}

console.log('--- 静态统计（每个 driver 里字面量 sleep 的总和）')
const rows = []
for (const [file, label] of Object.entries(SUITE)) {
  const source = readFileSync(join(HERE, file), 'utf8')
  const budget = sleepBudget(source)
  const lines = source.split('\n').length
  rows.push({ file, label, lines, sleeps: budget.count, ms: budget.ms })
}
rows.sort((a, b) => b.ms - a.ms)
const pad = (text, width) => String(text).padEnd(width)
console.log('  ' + pad('driver', 28) + pad('sleep 次数', 11) + pad('sleep 合计', 12) + pad('行数', 7) + '说明')
for (const row of rows) {
  console.log('  ' + pad(row.file, 28) + pad(row.sleeps, 11) + pad((row.ms / 1000).toFixed(1) + ' s', 12) + pad(row.lines, 7) + row.label.slice(0, 30))
}
const totalSleep = rows.reduce((sum, row) => sum + row.ms, 0)
console.log('  ' + pad('合计', 28) + pad(rows.reduce((s, r) => s + r.sleeps, 0), 11) + pad((totalSleep / 1000).toFixed(1) + ' s', 12))

if (!shouldRun) {
  console.log('\n（加 --run 再串行跑一遍量真实墙钟；--jobs N 指定并发）')
  process.exit(0)
}

console.log('\n--- 真实墙钟（jobs=' + jobs + '）')
const started = Date.now()
let output = ''
try {
  output = execFileSync('node', ['run-suite.mjs', '--jobs', String(jobs)], {
    cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  output = String(error.stdout ?? '') + String(error.stderr ?? '')
}
const wall = ((Date.now() - started) / 1000).toFixed(1)
const measured = [...output.matchAll(/^(PASS|FAIL)\s+(\S+?)\s{2,}(.*?)\s+\((\d+)ms\)/gm)]
  .map((match) => ({ ok: match[1] === 'PASS', file: match[2], label: match[3], ms: Number(match[4]) }))
  .sort((a, b) => b.ms - a.ms)
console.log('  ' + pad('driver', 26) + pad('墙钟', 10) + pad('sleep 预算', 12) + '差额（启动 + CDP + 断言）')
const byFile = new Map(rows.map((row) => [row.file, row]))
for (const item of measured) {
  const row = byFile.get(item.file)
  const budget = row === undefined ? 0 : row.ms
  console.log('  ' + pad(item.file, 26) + pad((item.ms / 1000).toFixed(1) + ' s', 10) + pad((budget / 1000).toFixed(1) + ' s', 12)
    + ((item.ms - budget) / 1000).toFixed(1) + ' s' + (item.ok ? '' : '  ← 失败'))
}
console.log('  ' + pad('总计', 26) + pad(wall + ' s', 10) + pad((totalSleep / 1000).toFixed(1) + ' s', 12)
  + ((Number(wall) * 1000 - totalSleep) / 1000).toFixed(1) + ' s')
