// 用 GitHub REST 给 awesome-dsh-plugin 提一个收录 PR。
//
// token 从**文件**读（默认 %USERPROFILE%\\.dsh\\github-token.txt），只当 Authorization 头用：
// 不打印、不落盘、不进 git。用法：node tools/market-pr.mjs [token文件路径]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const BRANCH = 'add-dsh-pet-live2d'
// 插件在仓库的子目录里（根没有 package.json），所以条目必须指向子包 ——
// 文件名按人家的约定：owner__repo--<子路径，斜杠换成短横>。
const ENTRY_PATH = 'data/plugins/A8Chann__dsh-pet-live2d--dsh-live2d-pet.yml'
const OLD_ENTRY_PATH = 'data/plugins/A8Chann__dsh-pet-live2d.yml'
const tokenPath = process.argv[2] ?? join(homedir(), '.dsh', 'github-token.txt')

let token
try {
  token = readFileSync(tokenPath, 'utf8').trim()
} catch {
  console.error('读不到 token 文件：' + tokenPath)
  console.error('先放一份：Set-Content -Path "' + tokenPath + '" -Value "ghp_..." -NoNewline -Encoding ascii')
  process.exit(2)
}
if (token.length < 20) { console.error('token 文件内容太短，确认只放了一行 token'); process.exit(2) }

const entry = readFileSync(new URL('./market-entry.yml', import.meta.url))

const api = async (path, init = {}) => {
  const response = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-live2d-pet-market-entry',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  return { status: response.status, ok: response.ok, body }
}

const me = await api('/user')
if (!me.ok) { console.error('token 不可用：HTTP ' + me.status + ' ' + JSON.stringify(me.body).slice(0, 200)); process.exit(1) }
const login = me.body.login
console.log('账号：' + login)

const fork = await api('/repos/' + UPSTREAM + '/forks', { method: 'POST', body: '{}' })
console.log('fork：HTTP ' + fork.status + (fork.ok ? '（已受理）' : '（可能已存在，继续）'))

let ready = false
for (let i = 0; i < 20 && !ready; i += 1) {
  const mine = await api('/repos/' + login + '/awesome-dsh-plugin')
  if (mine.ok) { ready = true; break }
  await new Promise((r) => setTimeout(r, 3000))
}
if (!ready) { console.error('fork 迟迟没就绪，稍后重跑本脚本即可'); process.exit(1) }
console.log('fork 就绪：' + login + '/awesome-dsh-plugin')

const upstreamRef = await api('/repos/' + UPSTREAM + '/git/ref/heads/main')
if (!upstreamRef.ok) { console.error('读上游 main 失败：HTTP ' + upstreamRef.status); process.exit(1) }
const baseSha = upstreamRef.body.object.sha
const branchRef = await api('/repos/' + login + '/awesome-dsh-plugin/git/ref/heads/' + BRANCH)
if (branchRef.ok) {
  console.log('分支已存在，复用：' + BRANCH)
} else {
  const created = await api('/repos/' + login + '/awesome-dsh-plugin/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha: baseSha }),
  })
  if (!created.ok) { console.error('建分支失败：HTTP ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 200)); process.exit(1) }
  console.log('分支已建：' + BRANCH + ' @ ' + baseSha.slice(0, 8))
}

const existing = await api('/repos/' + login + '/awesome-dsh-plugin/contents/' + ENTRY_PATH + '?ref=' + BRANCH)
const putBody = {
  message: 'Add A8Chann/dsh-pet-live2d',
  content: Buffer.from(entry).toString('base64'),
  branch: BRANCH,
}
if (existing.ok && existing.body && existing.body.sha !== undefined) putBody.sha = existing.body.sha
const put = await api('/repos/' + login + '/awesome-dsh-plugin/contents/' + ENTRY_PATH, { method: 'PUT', body: JSON.stringify(putBody) })
if (!put.ok) { console.error('提交文件失败：HTTP ' + put.status + ' ' + JSON.stringify(put.body).slice(0, 300)); process.exit(1) }
console.log('条目已提交：' + ENTRY_PATH + ' @ ' + String(put.body.commit?.sha ?? '').slice(0, 8))

// 先指向仓库根的那版要从分支上删掉，否则会留下两条指向同一仓库的条目。
const oldEntry = await api('/repos/' + login + '/awesome-dsh-plugin/contents/' + OLD_ENTRY_PATH + '?ref=' + BRANCH)
if (oldEntry.ok && oldEntry.body && oldEntry.body.sha !== undefined) {
  const removed = await api('/repos/' + login + '/awesome-dsh-plugin/contents/' + OLD_ENTRY_PATH, {
    method: 'DELETE',
    body: JSON.stringify({ message: 'Point the entry at the plugin subpackage', sha: oldEntry.body.sha, branch: BRANCH }),
  })
  console.log('旧条目已删除：' + OLD_ENTRY_PATH + '（HTTP ' + removed.status + '）')
}

const list = await api('/repos/' + UPSTREAM + '/pulls?head=' + login + ':' + BRANCH + '&state=open')
if (list.ok && Array.isArray(list.body) && list.body.length > 0) {
  console.log('PR 已存在：' + list.body[0].html_url)
  process.exit(0)
}
const prBody = [
  'Adds the Live2D desktop pet for the DSH web GUI: draggable, pointer-tracking,',
  'session-phase driven, with a right-click control panel and a persistent outfit archive.',
  '',
  '- declares the dsh.bundle.patch manifest (cordis.patch.yml) plus a dsh.client web bundle',
  '- carries the dsh-plugin topic; public since 2026-09-20',
  '- ships its built lib/ output, so "dsh plugin add github:A8Chann/dsh-pet-live2d" needs no build step',
  '- the proprietary Cubism Core is not bundled: the host fetches it from Live2D own CDN on first use and caches it',
].join('\n')
const pr = await api('/repos/' + UPSTREAM + '/pulls', {
  method: 'POST',
  body: JSON.stringify({ title: 'Add A8Chann/dsh-pet-live2d', head: login + ':' + BRANCH, base: 'main', body: prBody }),
})
if (!pr.ok) { console.error('开 PR 失败：HTTP ' + pr.status + ' ' + JSON.stringify(pr.body).slice(0, 300)); process.exit(1) }
console.log('PR：' + pr.body.html_url)
