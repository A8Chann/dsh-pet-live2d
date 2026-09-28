// 读**原始**动作文件（P:\DSH\live2d原始\motions）：每个动作写了哪些参数、量程多少。
//
// 用户的纠正："我从来没说过手机的事儿，你把手机反而给改坏了，我的意思一直是**右手没有抬起来**"。
// 所以要看原始动作文件里，到底是哪条参数管"抬右手"，以及各动作之间的分工。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'P:/DSH/live2d原始/motions'
const files = readdirSync(dir).filter((name) => name.endsWith('.motion3.json'))
console.log('原始动作文件：' + JSON.stringify(files))

const summary = {}
for (const file of files) {
  const motion = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const rows = []
  for (const curve of motion.Curves ?? []) {
    const id = String(curve.Id)
    const numbers = (curve.Segments ?? []).filter((v) => typeof v === 'number')
    if (numbers.length === 0) continue
    rows.push({ id, min: Math.min(...numbers), max: Math.max(...numbers) })
  }
  summary[file] = rows
}

// 先看"跟手/手机有关"的参数在哪些动作里出现。
const wanted = /phone|hand|arm|shou|ju|take|hold/i
console.log('')
console.log('=== 名字像"手/手机"的参数，各动作里的量程 ===')
for (const [file, rows] of Object.entries(summary)) {
  const hit = rows.filter((row) => wanted.test(row.id))
  if (hit.length === 0) continue
  console.log('  ' + file)
  for (const row of hit) console.log('      ' + row.id.padEnd(10) + row.min.toFixed(2) + ' … ' + row.max.toFixed(2))
}

console.log('')
console.log('=== 「自拍」与「开盖」的**全部**参数（对比谁写什么）===')
for (const file of ['自拍.motion3.json', '开盖.motion3.json', '自拍简单.motion3.json']) {
  const rows = summary[file]
  if (rows === undefined) continue
  console.log('  ' + file + '（' + rows.length + ' 条）')
  for (const row of rows) console.log('      ' + row.id.padEnd(22) + row.min.toFixed(2) + ' … ' + row.max.toFixed(2))
}
