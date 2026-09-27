// 把 sidecar 编成**独立二进制**（deno compile），供壳嵌进 exe。
//
// 为什么是 deno compile 而不是"把宿主半区翻成 Rust"：`dsh-live2d-pet/lib/index.js` 里的
// 宠物发现、`pet.json` 归一化、模型引用闭包、随包宠物按内容指纹同步，是修过好几个 bug、
// 有回归测试的逻辑；翻一遍就是第二份实现，而且两边会慢慢分叉。deno compile 把它连同
// Node 兼容层一起编成一个 exe —— **JS 一行不改**，宠物行为与网页端天然一致。
//
//   node tools/build-sidecar.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from '../sidecar/paths.mjs'

const SIDECAR_DIR = join(DESKTOP, 'sidecar')
const OUT_DIR = join(DESKTOP, 'src-tauri', 'binaries')
const OUT = join(OUT_DIR, 'pet-sidecar-x86_64-pc-windows-msvc.exe')

function findDeno() {
  const candidates = [
    process.env.DENO_BIN,
    'deno',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'deno.exe'),
    join(process.env.USERPROFILE ?? '', '.deno', 'bin', 'deno.exe'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  // winget 装的那个包目录名带版本哈希，扫一遍兜底。
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages)) {
      if (!entry.startsWith('DenoLand')) continue
      const nested = join(packages, entry, 'deno.exe')
      if (existsSync(nested)) return nested
    }
  }
  return undefined
}

const deno = findDeno()
if (deno === undefined) {
  console.error('找不到 deno。装一个：winget install DenoLand.Deno（或用 DENO_BIN 指定路径）')
  process.exit(1)
}

if (!existsSync(join(SIDECAR_DIR, 'embed', 'plugin', 'lib', 'index.js'))) {
  console.error('sidecar/embed 还没铺好 —— 先跑 node tools/prep-embed.mjs')
  process.exit(1)
}

console.log('[build-sidecar] deno = ' + deno)
console.log('[build-sidecar] 输出 = ' + OUT)

// `--allow-all`：sidecar 要监听回环端口、读宠物目录、写缓存与状态文件。
// 独立二进制里权限是**运行期**判定的，所以这里给足，壳启动时不再需要用户授权。
//
// `--include`：embed 目录里的东西是**运行期用拼出来的路径读的**（插件宿主半区、
// React UMD、宠物资产），静态分析看不见它们 —— 不显式带上，独立二进制里就没有，
// 症状是"开发时好好的、打包后 404 或 Module not found"。
const args = [
  'compile',
  '--allow-all',
  '--no-prompt',
  '--quiet',
  '--include', join(SIDECAR_DIR, 'embed'),
  '--output', OUT,
  join(SIDECAR_DIR, 'server.mjs'),
]
// `stdio: 'inherit'` 而不是靠返回的 stdout：编译产物可能很大，让它直接写终端，
// 也别把二进制内容经管道捞回来（`execFileSync` 的返回值和 inherit 不能同时用，
// 实测直接炸 ERR_STREAM_NULL_VALUES）。
execFileSync(deno, args, { stdio: 'inherit', cwd: SIDECAR_DIR })

/**
 * 去掉调试符号。
 *
 * deno 2.9 的 `deno compile` **没有** `--strip` 选项（试过，报 unexpected argument），
 * 而它默认会把符号一起写进产物：**86MB → 45MB**（实测）。用 cargo-binutils 的
 * `rust-strip`，其次 llvm-strip。
 *
 * 注意：`rust-strip` 装在 `%USERPROFILE%\.cargo\bin`，**那不一定在 PATH 里** ——
 * 早先版本只按名字找，于是静默跳过、exe 白白大一倍。所以先拼出绝对路径再试。
 */
const stripCandidates = [
  join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'rust-strip.exe'),
  join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'rust-strip'),
  join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'llvm-strip.exe'),
  'rust-strip',
  'llvm-strip',
]
let stripped = false
let stripTool = ''
for (const tool of stripCandidates) {
  if (tool.includes(join('', '.cargo')) && !existsSync(tool)) continue
  try {
    execFileSync(tool, ['--strip-all', OUT], { stdio: 'ignore' })
    stripped = true
    stripTool = tool
    break
  } catch {
    /* 试下一个 */
  }
}

const size = statSync(OUT).size
console.log('[build-sidecar] 完成：' + (size / 1024 / 1024).toFixed(1) + ' MB'
  + (stripped ? '（已去符号，用 ' + stripTool + '）' : '（**没去符号**：装一个 cargo install cargo-binutils 可以减半）'))
console.log('BUILD_SIDECAR_OK')
