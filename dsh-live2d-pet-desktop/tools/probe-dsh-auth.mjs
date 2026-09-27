// 一次性诊断：DSH 的 `/api/*` 到底要什么才放行。
//
// 背景：`/api/live2d-pet/catalog` 无头访问返回 200，而**未知的** `/api/*` 返回 401。
// 挂载模式要把 `/api/live2d-pet/*` 转发给 DSH，所以必须知道"要不要带头、带哪个头"。
//
//   node tools/probe-dsh-auth.mjs [--dsh http://127.0.0.1:3080]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const DSH = argOf('--dsh', 'http://127.0.0.1:3080')
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

let token = ''
try {
  token = JSON.parse(readFileSync(join(HOME, 'dsh-live2d-pet-desktop.json'), 'utf8')).token ?? ''
} catch { /* 没有就算了 */ }
console.log('token 文件里有 token：' + (token !== '' ? token.length + ' 字符' : '没有'))

const probe = async (path, headers, label) => {
  try {
    const response = await fetch(DSH + path, { headers })
    console.log('  ' + path.padEnd(46) + ' ' + String(response.status).padEnd(4) + label)
  } catch (error) {
    console.log('  ' + path.padEnd(46) + ' ERR  ' + label + ' ' + String(error && error.message))
  }
}

const variants = [
  ['(无头)', {}],
  ['authorization: Bearer', { authorization: 'Bearer ' + token }],
  ['x-dsh-token', { 'x-dsh-token': token }],
  ['x-desktop-token', { 'x-desktop-token': token }],
  ['cookie dsh_token', { cookie: 'dsh_token=' + token }],
]

console.log('--- 未知的 /api/* （401 说明有守卫）')
for (const [label, headers] of variants) {
  await probe('/api/live2d-pet/definitely-not-a-route', headers, label)
}
console.log('--- 对照：已知存在的插件路由')
for (const [label, headers] of variants) {
  await probe('/api/live2d-pet/catalog', headers, label)
}
console.log('--- 对照：DSH 自己的 API')
for (const [label, headers] of variants) {
  await probe('/api/sessions', headers, label)
}
