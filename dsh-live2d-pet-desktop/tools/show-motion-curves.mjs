// 「自拍动画没有举手」——先查清**哪几个参数是"举手"**，以及各动作写不写它们。
//
// 上一轮我盯的是 `phone`（手机在不在手里），那是**另一件事**：手机在手里 ≠ 手抬起来了。
// 用户的原话纠正了这一点（"不是手机的问题，是手没有抬起来"）。
//
// 做法：读 pet.json 指定的各动作 `.motion3.json`，把 **Curves 里的参数 id** 列出来，
// 逐个动作对比 —— 谁写手臂、谁不写，一眼看得出 Selfie 缺了什么。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const dir = join(ROOT, 'dsh-live2d-pet', 'pets', 'ds-whale-girl')
const model3 = JSON.parse(readFileSync(join(dir, 'c_0120.model3.json'), 'utf8'))
const fileRefs = model3.FileReferences ?? {}
const motions = fileRefs.Motions ?? {}
console.log('模型声明的动作组：' + JSON.stringify(Object.keys(motions)))
console.log('')

/** 读一个动作文件里的曲线参数 id 列表。 */
function curvesOf(file) {
  const path = join(dir, file)
  try {
    const motion = JSON.parse(readFileSync(path, 'utf8'))
    return (motion.Curves ?? []).map((curve) => String(curve.Id))
  } catch (error) {
    return ['(读不到: ' + String(error && error.message) + ')']
  }
}

const table = {}
for (const [group, entries] of Object.entries(motions)) {
  const first = Array.isArray(entries) ? entries[0] : entries
  const file = first?.File
  if (typeof file !== 'string') continue
  table[group] = curvesOf(file)
}

// "举手/手臂"相关的参数名（这只模型用拼音/英文混写，所以两条都匹配）。
const ARM = /arm|hand|shoulder|elbow|wrist|kandai|shou|jia|ju|raise|hold|phone|take/i
console.log('各动作组：曲线总数 / 其中像"手/臂"的')
for (const [group, ids] of Object.entries(table)) {
  const arm = ids.filter((id) => ARM.test(id))
  console.log('  ' + group.padEnd(14) + ' 曲线 ' + String(ids.length).padStart(3)
    + '   手/臂 ' + String(arm.length).padStart(3)
    + (arm.length > 0 && arm.length <= 14 ? '  ' + JSON.stringify(arm) : ''))
}

console.log('')
console.log('全部参数名（去重，用来找"举手"到底是哪几个）：')
const all = new Set()
for (const ids of Object.values(table)) for (const id of ids) all.add(id)
const names = Array.from(all).sort()
console.log('  ' + names.join(', '))

console.log('')
console.log('所有动作文件（含没被 model3 声明的）：' + JSON.stringify(readdirSync(join(dir, 'motions'))))
