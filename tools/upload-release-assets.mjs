// 把**发布产物作为附件**传到 GitHub Release 上（exe 与 npm 子包 tarball）。
//
// 为什么需要它：`make-release.mjs` 只建 Release（正文取 CHANGELOG），附件一个都不传 ——
// 于是 exe 只活在 npm 子包里，GitHub 上拿不到。用户明确指出这一点。
//
// 规矩沿用 `make-release.mjs`：token 只从仓库外的文件读、不打印、不进命令行。
//
//   node tools/upload-release-assets.mjs 3.0.1 [--dry-run]
//   node tools/upload-release-assets.mjs 3.0.0 --exe-only     # 只补 exe
//
// 幂等：同名附件已存在就跳过（重新上传同一个名字会 422）。
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN_FILE = process.env.GITHUB_TOKEN_FILE ?? join(homedir(), '.dsh', 'github-token.txt')
const SLUG = 'A8Chann/dsh-pet-live2d'
const version = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (version === undefined) {
  console.error('用法：node tools/upload-release-assets.mjs <版本> [--exe-only] [--dry-run]')
  process.exit(1)
}
const dryRun = process.argv.includes('--dry-run')
const exeOnly = process.argv.includes('--exe-only')
const tag = 'v' + version

const SUB_DIR = join(ROOT, 'dsh-live2d-pet-desktop', 'npm', 'desktop-win32-x64')
/** 要传的附件：**exe 是主角**（用户要的），tarball 顺手带上（离线装也能用）。 */
const ASSETS = [
  {
    path: join(SUB_DIR, 'bin', 'dsh-pet-live2d-desktop.exe'),
    name: 'dsh-pet-live2d-desktop-' + version + '-win32-x64.exe',
    type: 'application/vnd.microsoft.portable-executable',
  },
  {
    path: join(SUB_DIR, 'dsh-pet-live2d-desktop-win32-x64-' + version + '.tgz'),
    name: 'dsh-pet-live2d-desktop-win32-x64-' + version + '.tgz',
    type: 'application/gzip',
  },
].filter((asset) => (exeOnly ? asset.name.endsWith('.exe') : true))

for (const asset of ASSETS) {
  if (!existsSync(asset.path)) {
    console.error('RELEASE_FAILED 没有这个产物：' + asset.path)
    console.error('  （exe 先跑 `npm run build:portable` + `npm run npm:prepare`；'
      + 'tarball 用 `npm pack` 生成）')
    process.exit(1)
  }
}
if (!existsSync(TOKEN_FILE)) {
  console.error('RELEASE_FAILED 没找到 token 文件：' + TOKEN_FILE)
  process.exit(1)
}
const token = readFileSync(TOKEN_FILE, 'utf8').trim()
const headers = {
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-pet-live2d-release-assets',
}

// Release 必须已经存在（先跑 make-release.mjs），否则附件的上传地址都没有。
const releaseResponse = await fetch('https://api.github.com/repos/' + SLUG + '/releases/tags/' + tag, { headers })
if (!releaseResponse.ok) {
  console.error('RELEASE_FAILED 远端没有 ' + tag + ' 的 Release（HTTP ' + releaseResponse.status + '）'
    + ' —— 先跑 node tools/make-release.mjs ' + version)
  process.exit(1)
}
const release = await releaseResponse.json()
const existing = new Set((release.assets ?? []).map((asset) => asset.name))
console.log(tag + ' 的 Release：' + release.html_url)
console.log('已有附件：' + (existing.size === 0 ? '(无)' : Array.from(existing).join(', ')))

for (const asset of ASSETS) {
  const size = statSync(asset.path).size
  const mib = (size / 1024 / 1024).toFixed(2) + ' MB'
  if (existing.has(asset.name)) {
    console.log('SKIP ' + asset.name + '（已存在）')
    continue
  }
  if (dryRun) {
    console.log('DRYRUN 会传 ' + asset.name + '  ' + mib + '  ← ' + asset.path)
    continue
  }
  // 上传地址是 uploads.github.com，且**必须**显式带 content-length（流式上传不认 chunked）。
  const uploadUrl = 'https://uploads.github.com/repos/' + SLUG + '/releases/'
    + release.id + '/assets?name=' + encodeURIComponent(asset.name)
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: Object.assign({}, headers, {
      'content-type': asset.type,
      'content-length': String(size),
    }),
    body: createReadStream(asset.path),
    duplex: 'half',
  })
  if (!response.ok) {
    console.error('RELEASE_FAILED 上传 ' + asset.name + ' 失败：HTTP ' + response.status + ' '
      + (await response.text()).slice(0, 300))
    process.exit(1)
  }
  const uploaded = await response.json()
  console.log('UPLOADED ' + asset.name + '  ' + mib + '  ' + uploaded.browser_download_url)
}

console.log(dryRun ? 'DRYRUN_OK' : 'ASSETS_OK ' + release.html_url)
