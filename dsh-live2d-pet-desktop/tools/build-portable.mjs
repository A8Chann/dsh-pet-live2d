// 一键产出**单文件便携 exe**。
//
// 翻成 Rust 宿主之后这一步变得很短：没有 deno compile、没有资源清单生成 —— 资源由
// `src-tauri/build.rs` 在编译期直接嵌进去，`cargo build --release` 就够了。
//
//   node tools/build-portable.mjs [--skip-suite]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, ROOT } from './paths.mjs'

const argv = process.argv.slice(2)
const skipSuite = argv.includes('--skip-suite')
const DIST = join(DESKTOP, 'dist')
const EXE_SRC = join(DESKTOP, 'src-tauri', 'target', 'release', 'dsh-pet-live2d-desktop.exe')
const EXE_OUT = join(DIST, 'DSH桌宠.exe')

const cargoBin = join(process.env.USERPROFILE ?? '', '.cargo', 'bin')
const cargo = existsSync(join(cargoBin, 'cargo.exe')) ? join(cargoBin, 'cargo.exe') : 'cargo'
const env = { ...process.env, PATH: cargoBin + ';' + (process.env.PATH ?? '') }

const step = (title, fn) => {
  console.log('\n=== ' + title + ' ===')
  fn()
}

step('1/3 编译壳（release；资源在编译期嵌入）', () => {
  execFileSync(cargo, ['build', '--release', '--bin', 'dsh-pet-live2d-desktop'], {
    stdio: 'inherit',
    cwd: join(DESKTOP, 'src-tauri'),
    env,
  })
})

step('2/3 产出 dist/DSH桌宠.exe', () => {
  if (!existsSync(EXE_SRC)) throw new Error('没找到 release 产物：' + EXE_SRC)
  mkdirSync(DIST, { recursive: true })
  copyFileSync(EXE_SRC, EXE_OUT)
  console.log('  ' + EXE_OUT + '  ' + (statSync(EXE_OUT).size / 1024 / 1024).toFixed(2) + ' MB')
})

step('3/3 对拍 + 壳全链 + 网页端回归', () => {
  if (skipSuite) {
    console.log('  （--skip-suite：跳过）')
    return
  }
  const shell = join(DIST, 'DSH桌宠.exe')
  console.log('  起壳用于验证：' + shell)
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    "$env:PET_DESKTOP_CDP='8823'; Start-Process -FilePath '" + shell + "'; Start-Sleep -Seconds 14",
  ], { stdio: 'inherit' })
  try {
    // 对拍：拿 JS 版宿主半区当参照，逐字段比 catalog、逐字节比资产。
    execFileSync('node', [join(DESKTOP, 'tools', 'probe-catalog.mjs')], { stdio: 'inherit', env })
    execFileSync('node', [join(DESKTOP, 'tools', 'desktop-driver.mjs'), '--page', 'pet'], { stdio: 'inherit', env })
  } finally {
    // `exit 0` 不能省：没有任何进程可杀时，这条管道的退出码是 1（`Get-Process` 找不到
    // 匹配项会把错误状态带下去），而 `execFileSync` 见到非 0 就抛 —— 于是**已经成功的
    // 构建**会在收尾这一步报成失败，还顺手把 `run-suite` 那段跳掉。踩过一次。
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process 'DSH桌宠','dsh-pet-live2d-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
    ], { stdio: 'inherit' })
  }
  execFileSync('node', ['run-suite.mjs', '--jobs', '1'], {
    stdio: 'inherit',
    cwd: join(ROOT, 'tools', 'browser-test'),
    env,
  })
})

console.log('\nPORTABLE_OK ' + EXE_OUT)
