// **发行格式验证**：不需要发布、不需要联网 GitHub —— 全部在本地临时目录里做完。
//
// 它按顺序回答四个问题：
//
//   1. 两个包的清单一致吗？（子包版本必须等于主包版本，否则用户会装到对不上的二进制）
//   2. `npm pack` 出来的 tarball 里有 exe 吗？多大？（这是用户真正下载的东西）
//   3. `npm install` 之后，**不匹配平台的子包会不会被静默跳过**？
//      —— 用一个假的 `darwin-arm64` 子包做对照实验：如果它被跳过了，说明 macOS 用户
//      装主包时连报错都不会有（这就是"两边都无感"的机制依据）。
//   4. 解析器能从**装好的位置**找到 exe 吗？它 `--attach` 起得来吗？（端到端）
//
//   node tools/verify-npm-distribution.mjs [--keep] [--skip-install]
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP, ROOT } from './paths.mjs'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const skipInstall = argv.includes('--skip-install')
const PLUGIN = join(ROOT, 'dsh-live2d-pet')
const SUB = join(DESKTOP, 'npm', 'desktop-win32-x64')
const WORK = join(DESKTOP, '.run', 'npm-dist-verify')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(2) + ' MB'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * 怎么调 npm。
 *
 * Windows 上 `npm` 是 `.cmd`，而 `execFileSync` 既不解析扩展名（ENOENT）也不能直接
 * spawn `.cmd`（Node 24 起报 EINVAL，需要 shell）。两条都不要走 —— 直接调**当前这个
 * npm 自己的 JS 入口**：`npm_execpath` 就是它（npm 跑脚本时一定会设），用 node 起它，
 * 既没有引号/转义的坑，也不依赖 PATH 里有什么。
 */
function npmArgs(args) {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.endsWith('.js') && existsSync(execpath)) {
    return { command: process.execPath, args: [execpath, ...args] }
  }
  // 退化路径：`npm` 在 PATH 里、且平台允许直接 spawn。
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: process.platform === 'win32' }
}
function runNpm(args, options) {
  const { command, args: argv, shell } = npmArgs(args)
  return execFileSync(command, argv, { ...options, ...(shell === undefined ? {} : { shell }) })
}

// ---------------------------------------------------------------- 0. 准备
console.log('--- 0. 准备子包内容（把 exe 铺进去）')
execFileSync('node', [join(DESKTOP, 'tools', 'npm-prepare-subpackage.mjs')], { stdio: 'inherit' })

const mainManifest = readJson(join(PLUGIN, 'package.json'))
const reference = readJson(join(DESKTOP, 'npm', 'main-package.json'))
const subManifest = readJson(join(SUB, 'package.json'))

check('主包真的改了（optionalDependencies 指向子包，版本一致）',
  mainManifest.optionalDependencies?.[subManifest.name] === mainManifest.version,
  JSON.stringify({ main: mainManifest.version, declared: mainManifest.optionalDependencies?.[subManifest.name] }))
check('仓库里那份参考主包清单与真品一致',
  JSON.stringify(reference) === JSON.stringify(mainManifest),
  JSON.stringify(reference) === JSON.stringify(mainManifest) ? undefined : 'npm/main-package.json 与 dsh-live2d-pet/package.json 已经不同步')
check('子包声明了 os/cpu（否则非 Windows 用户也会下这 9MB）',
  Array.isArray(subManifest.os) && subManifest.os.includes('win32')
  && Array.isArray(subManifest.cpu) && subManifest.cpu.includes('x64'),
  JSON.stringify({ os: subManifest.os, cpu: subManifest.cpu }))

// ---------------------------------------------------------------- 1. npm pack
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
console.log('--- 1. npm pack（用户真正下载的就是这个 tarball）')
const packInto = (dir, out) => {
  const output = runNpm(['pack', '--pack-destination', out, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'error' },
  })
  // `npm pack --json` 直接给文件清单，不用再解一遍 tarball（也就不用依赖系统 tar）。
  const parsed = JSON.parse(output)
  return { tgz: join(out, parsed[0].filename), files: parsed[0].files.map((entry) => entry.path) }
}
const mainPack = packInto(PLUGIN, WORK)
const subPack = packInto(SUB, WORK)
const mainTgz = mainPack.tgz
const subTgz = subPack.tgz
const mainFiles = mainPack.files
const subFiles = subPack.files
console.log('  主包 tarball  ' + mb(mainTgz) + '（' + mainFiles.length + ' 个文件）')
console.log('  子包 tarball  ' + mb(subTgz) + '（' + subFiles.length + ' 个文件）')
check('子包 tarball 里有 exe', subFiles.some((name) => name.includes('dsh-pet-live2d-desktop.exe')),
  subFiles.filter((name) => name.includes('.exe')).join(', '))
check('主包里**没有** exe（9MB 不该塞进主包）',
  !mainFiles.some((name) => name.includes('dsh-pet-live2d-desktop.exe')),
  mainFiles.filter((name) => name.endsWith('.exe')).join(', ') || '(无)')
check('主包里带了新的解析器 lib/desktop.js',
  mainFiles.some((name) => name.includes('lib/desktop.js')))
check('用户下载量在合理区间（主包 + 子包 < 30 MB）',
  (statSync(mainTgz).size + statSync(subTgz).size) / 1024 / 1024 < 30,
  '合计 ' + (((statSync(mainTgz).size + statSync(subTgz).size) / 1024 / 1024).toFixed(2)) + ' MB')

// ---------------------------------------------------------------- 2. 对照实验：假 darwin 子包
console.log('--- 2. 对照实验：造一个假的 darwin-arm64 子包，看它会不会被静默跳过')
const FAKE_NAME = 'dsh-pet-live2d-desktop-darwin-arm64'
const fakeDir = join(WORK, 'fake-darwin')
mkdirSync(join(fakeDir, 'bin'), { recursive: true })
writeFileSync(join(fakeDir, 'package.json'), JSON.stringify({
  name: FAKE_NAME,
  version: subManifest.version,
  os: ['darwin'],
  cpu: ['arm64'],
  files: ['bin/'],
}, null, 2) + '\n')
writeFileSync(join(fakeDir, 'bin', 'dsh-pet-live2d-desktop'), 'not a real mach-o binary\n')
const fakeTgz = packInto(fakeDir, WORK)

// ---------------------------------------------------------------- 3. 装进一个假 profile
//
// ⚠️ 这里要打包一份**本地变体主包**：把 `optionalDependencies` 的子包版本改写成
// `file:<tarball>`。原因很实在 —— npm **不会**为 `file:` 形式的 optional 依赖建立链接
// （实测：主包和子包都装不上），所以"直接拿真品去装"验不到解析器。
//
// 变体只改这一行，其余逐字节相同；真品有没有带对那一行，由上面"主包真的改了"那条断言负责。
let installedProfile
if (!skipInstall) {
  console.log('--- 3. 装进一个假 profile（模拟 dsh plugin add）')
  installedProfile = join(WORK, 'profile')
  const variantDir = join(WORK, 'variant-main')
  mkdirSync(variantDir, { recursive: true })
  cpSync(PLUGIN, variantDir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.endsWith('.git'),
  })
  const variantManifest = readJson(join(variantDir, 'package.json'))
  variantManifest.optionalDependencies = { [subManifest.name]: 'file:' + subTgz }
  writeFileSync(join(variantDir, 'package.json'), JSON.stringify(variantManifest, null, 2) + '\n')
  const variantTgz = packInto(variantDir, WORK).tgz

  mkdirSync(installedProfile, { recursive: true })
  writeFileSync(join(installedProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-verify',
    private: true,
    dependencies: {
      'dsh-pet-live2d': 'file:' + variantTgz,
      // 故意也显式声明这个 darwin 子包：确保"平台不匹配"这条路径一定被走到。
      [FAKE_NAME]: 'file:' + fakeTgz,
    },
  }, null, 2) + '\n')
  const code = (() => {
    try {
      runNpm(['install', '--no-audit', '--no-fund', '--ignore-scripts'], {
        cwd: installedProfile,
        stdio: 'inherit',
        env: { ...process.env, npm_config_loglevel: 'error' },
      })
      return 0
    } catch (error) {
      console.error(String(error && error.message))
      return 1
    }
  })()
  check('npm install 成功（平台不匹配不该让安装失败）', code === 0, 'exit=' + code)

  const nodeModules = join(installedProfile, 'node_modules')
  const mainInstalled = join(nodeModules, 'dsh-pet-live2d')
  const winInstalled = join(nodeModules, subManifest.name)
  const darwinInstalled = join(nodeModules, FAKE_NAME)

  check('主包装上了', existsSync(mainInstalled))
  check('Windows 子包装上了（因为这台机器就是 win32-x64）',
    existsSync(winInstalled) && existsSync(join(winInstalled, 'bin', 'dsh-pet-live2d-desktop.exe')),
    existsSync(winInstalled) ? mb(join(winInstalled, 'bin', 'dsh-pet-live2d-desktop.exe')) : '(没装上)')
  check('**darwin 子包被静默跳过了**（macOS 用户的体验：不报错、也不下 9MB）',
    !existsSync(darwinInstalled),
    existsSync(darwinInstalled) ? '竟然装上了 —— 那 macOS 用户会白下 9MB' : undefined)

  // ---------------------------------------------------------------- 4. 解析器 + 端到端
  console.log('--- 4. 从**装好的位置**跑解析器，并让它真的 --attach 起来')
  // 探查脚本写成文件再跑：`-e` 里的多行模板在 Windows 上会被引号/换行搞坏（踩过）。
  //
  // ⚠️ import 的路径必须是 **file:// URL**：Windows 上 `import 'P:/…'` 会被当成协议 `p:`
  // 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。传给我们自己的函数（不是 import）时才用普通路径。
  const probeFile = join(WORK, 'probe-resolver.mjs')
  writeFileSync(probeFile, [
    `import { resolveDesktopBinary, desktopHint, desktopSupported, desktopVersionCheck } from ${JSON.stringify(pathToFileURL(join(mainInstalled, 'lib', 'desktop.js')).href)}`,
    `const home = ${JSON.stringify(join(WORK, 'home').replace(/\\/g, '/'))}`,
    'console.log(JSON.stringify({',
    '  found: resolveDesktopBinary({ home }) ?? null,',
    '  hint: desktopHint({ home }),',
    '  supported: desktopSupported(),',
    '  version: desktopVersionCheck(),',
    '}))',
    '',
  ].join('\n'))
  const probeOut = execFileSync(process.execPath, [probeFile], { encoding: 'utf8' })
  const probed = JSON.parse(probeOut.trim().split('\n').pop())
  check('解析器从 node_modules 里找到了 exe', probed.found !== undefined,
    JSON.stringify(probed.found ?? probed.hint))
  check('找到的来源是"平台子包"（不是兜底路径）', probed.found?.source === 'package:' + subManifest.name,
    probed.found?.source)
  check('这个平台报告为"支持桌面端"', probed.supported === true)
  check('子包版本与主包一致', probed.version?.ok === true, JSON.stringify(probed.version))

  if (probed.found !== undefined && process.env.PET_DESKTOP_ATTACH !== 'skip') {
    const upstream = process.env.DSH_URL ?? 'http://127.0.0.1:3080'
    let alive = false
    try {
      const response = await fetch(upstream + '/api/live2d-pet/catalog')
      alive = response.ok
    } catch { /* DSH 没开 */ }
    if (!alive) {
      console.log('  （DSH 没在跑，跳过 --attach 的端到端：' + upstream + '）')
      check('装好的 exe 能 --attach 起来（需要 DSH 在跑）', false, 'DSH 没开，无法断言')
    } else {
      const child = spawn(probed.found.path, ['--attach', upstream], {
        env: { ...process.env, PET_DESKTOP_CDP: '8851' },
        stdio: 'ignore',
      })
      await sleep(12000)
      let port = 0
      for (let i = 0; i < 20 && port === 0; i += 1) {
        try {
          const list = await (await fetch('http://127.0.0.1:8851/json/list')).json()
          const page = list.find((t) => t.type === 'page' && typeof t.url === 'string')
          const match = page === undefined ? null : /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(page.url)
          if (match !== null) port = Number(match[1])
        } catch { /* 还没起来 */ }
        if (port === 0) await sleep(500)
      }
      check('装好的 exe 起来了（有页面）', port > 0, 'port=' + port)
      if (port > 0) {
        const catalog = await fetch('http://127.0.0.1:' + port + '/api/live2d-pet/catalog')
          .then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }), () => ({ status: 0, bytes: 0 }))
        const upstreamCatalog = await fetch(upstream + '/api/live2d-pet/catalog')
          .then(async (r) => (await r.arrayBuffer()).byteLength, () => 0)
        check('它挂在 DSH 上（catalog 与上游同长）', catalog.status === 200 && catalog.bytes === upstreamCatalog,
          catalog.status + ' / ' + catalog.bytes + ' vs ' + upstreamCatalog)
      }
      try { child.kill() } catch { /* 已经退了 */ }
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
          "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
        ], { stdio: 'ignore' })
      } catch { /* 收尸失败不影响结论 */ }
    }
  }
} else {
  console.log('--- 3/4. 跳过 install（--skip-install）')
}

if (!keep) rmSync(WORK, { recursive: true, force: true })
else console.log('（--keep：临时目录留在 ' + WORK + '）')

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('NPM-DIST ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
