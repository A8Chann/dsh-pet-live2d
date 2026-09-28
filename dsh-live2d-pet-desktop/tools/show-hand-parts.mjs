// 一次性：从 cdi3 里找出"右手 / 手 / 手臂 / 手机"这些部件叫什么，以及各动作写不写它们。
//
// 用户的原话：「我的意思一直是**右手没有抬起来**」。所以要看的是**手那块几何在画面上
// 抬没抬**，而不是某个参数等于几 —— 前几轮我一直盯参数名（`phone` / `phone2`），方向就错了。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'P:/DSH/live2d原始'
const cdi3 = JSON.parse(readFileSync(join(dir, 'c_0120.cdi3.json'), 'utf8'))
console.log('cdi3 顶层键：' + Object.keys(cdi3).join(', '))

const parts = cdi3.Parts ?? []
const drawables = cdi3.Drawables ?? []
console.log('部件数 ' + parts.length + '，drawable 数 ' + drawables.length)
console.log('')

const WANT = /手|臂|phone|hand|arm|手机|掌|指/i
console.log('=== 名字像"手/手臂/手机"的部件 ===')
for (const part of parts) {
  const name = String(part.Name ?? '')
  if (!WANT.test(name)) continue
  console.log('  ' + String(part.Id).padEnd(24) + name)
}
console.log('')
console.log('=== 名字像"手/手臂/手机"的 drawable ===')
for (const item of drawables) {
  const name = String(item.Name ?? '')
  if (!WANT.test(name)) continue
  console.log('  ' + String(item.Id).padEnd(28) + name)
}
console.log('')
console.log('=== 全部部件名（好找"右"在哪）===')
console.log('  ' + parts.map((part) => String(part.Name ?? '')).join(' | '))
