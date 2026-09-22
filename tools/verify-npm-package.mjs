// 从 tarball 里验两份 README（那才是 npm 页面真正渲染的）。
// 注意：**别只查"旧说法没有了"** —— 空字符串也会通过，那是空洞成立的断言（我犯过两次）。
// 所以每条都同时要求"有新的、没有旧的、且长度正常"。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = process.argv[2] ?? '2.0.2'
const url = `https://registry.npmjs.org/dsh-pet-live2d/-/dsh-pet-live2d-${version}.tgz`
const dir = mkdtempSync(join(tmpdir(), 'pet-verify-'))
const tgz = join(dir, 'p.tgz')

// 等它上线（npm 处理有时要几分钟）
let status = 0
for (let i = 0; i < 40; i += 1) {
  const res = await fetch(`https://registry.npmjs.org/dsh-pet-live2d/${version}`)
  status = res.status
  if (res.ok) break
  await new Promise((r) => setTimeout(r, 15000))
}
console.log(version, '版本级接口 ->', status)
if (status !== 200) {
  console.log('还没上线，稍后再验')
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

execFileSync('curl', ['-s', '-o', tgz, url])
execFileSync('tar', ['-xzf', tgz, '-C', dir, 'package/README.md', 'package/pets/ds-whale-girl/README.md'])

const check = (label, text, must, mustNot) => {
  const problems = []
  if (text.length < 400) problems.push('长度只有 ' + text.length + '（空的？）')
  for (const s of must) if (!text.includes(s)) problems.push('缺少「' + s + '」')
  for (const s of mustNot) if (text.includes(s)) problems.push('还有旧说法「' + s + '」')
  console.log((problems.length === 0 ? 'OK   ' : '不对 ') + label + (problems.length ? ' → ' + problems.join('；') : ''))
  return problems.length === 0
}

const main = readFileSync(join(dir, 'package/README.md'), 'utf8')
const pet = readFileSync(join(dir, 'package/pets/ds-whale-girl/README.md'), 'utf8')
const a = check('主 README', main, ['Cubism Core：不用手动装', '20 个互斥槽位'], ['必须自备 Cubism Core'])
const b = check('宠物 README', pet, ['不用自己去找', 'Cubism 5', '20 个'], ['需要自行放置', '@linxin666', 'Cubism 3/4', '17 个'])
rmSync(dir, { recursive: true, force: true })
process.exit(a && b ? 0 : 1)
