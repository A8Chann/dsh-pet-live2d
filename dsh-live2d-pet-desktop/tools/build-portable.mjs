// 一键产出**可分发产物**。
//
//   node tools/build-portable.mjs [--skip-suite] [--target <triple>] [--no-app]
//
// 两个平台两条形状（同一份源码，差别只在"怎么打包"）：
//
//   * **Windows**：`dist/DSH桌宠.exe` —— 单文件便携 exe。默认跑完三步验证（对拍 + 壳全链 +
//     网页端回归），那是本机唯一能端到端验的路。
//   * **macOS**：两样东西
//       - `dist/dsh-pet-live2d-desktop` —— 裸二进制，给 npm 平台子包用（插件 spawn 它）；
//       - `dist/DSH桌宠.app` —— 给人双击用（Info.plist + 图标 + ad-hoc 签名）。
//     **不跑验证**：那套驱动全是 Windows 的（PowerShell / `SetCursorPos` / 窗口扩展样式 /
//     WebView2 的 CDP 端口），mac 上一条都跑不了 —— 与其印一个假的绿，不如什么都不印。
//
// 资源（页面 / 浏览器半区 / 随包宠物 / Cubism Core）在**编译期**由 `src-tauri/build.rs`
// 嵌进二进制，所以这一步没有"铺资源"的活。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, ROOT } from './paths.mjs'
import { ensureRunnableIntegrity } from './integrity.mjs'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (flag) => (argv.indexOf(flag) === -1 ? undefined : argv[argv.indexOf(flag) + 1])

const skipSuite = has('--skip-suite')
const targetTriple = value('--target')
const wantApp = !has('--no-app')

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const DIST = join(DESKTOP, 'dist')
const BIN_NAME = isWin ? 'dsh-pet-live2d-desktop.exe' : 'dsh-pet-live2d-desktop'
const OUT_DIR = targetTriple === undefined
  ? join(DESKTOP, 'src-tauri', 'target', 'release')
  : join(DESKTOP, 'src-tauri', 'target', targetTriple, 'release')

// cargo 不一定在 PATH 上：本机（Windows）装在 `%USERPROFILE%\.cargo\bin`，macOS 是
// `~/.cargo/bin`。两边都先探一下，探不到就交给 PATH。
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const cargoBin = join(home, '.cargo', 'bin')
const cargoExe = isWin ? 'cargo.exe' : 'cargo'
const cargo = existsSync(join(cargoBin, cargoExe)) ? join(cargoBin, cargoExe) : 'cargo'
const env = { ...process.env, PATH: cargoBin + (isWin ? ';' : ':') + (process.env.PATH ?? '') }

const step = (title, fn) => {
  console.log('\n=== ' + title + ' ===')
  fn()
}
const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(2) + ' MB'

const buildArgs = ['build', '--release', '--bin', 'dsh-pet-live2d-desktop']
if (targetTriple !== undefined) buildArgs.push('--target', targetTriple)

step('1/3 编译壳（release；资源在编译期嵌入）', () => {
  execFileSync(cargo, buildArgs, {
    stdio: 'inherit',
    cwd: join(DESKTOP, 'src-tauri'),
    env,
  })
})

step('2/3 产出 dist/', () => {
  const built = join(OUT_DIR, BIN_NAME)
  if (!existsSync(built)) throw new Error('没找到 release 产物：' + built)
  mkdirSync(DIST, { recursive: true })

  if (isWin) {
    // ⚠️ **产物名用 ASCII**（`DSH-Pet.exe`，不是 `DSH桌宠.exe`）。
    //
    // 两个理由：① 发出去的那两份本来就是 ASCII（Release 资产是
    // `dsh-pet-live2d-desktop-<版本>-win32-x64.exe`、npm 子包里是
    // `dsh-pet-live2d-desktop.exe`），本机构建没理由另起一个中文名；
    // ② 有一处"注册表里所有成功注册托盘图标的程序都是 ASCII 名、只有中文名那份没注册上"
    // 的观察（2026-09），虽然没定论，但没必要在这上面冒险。
    const exeOut = join(DIST, 'DSH-Pet.exe')
    copyFileSync(built, exeOut)
    console.log('  ' + exeOut + '  ' + mb(exeOut))
    // **这一道不能省**：产物**不能带任何会把进程压低的完整性标签**（在会话里构建出来的
    // 会带 Low；而带 Low 的 exe 双击起来写不进 `%DSH_HOME%`、建不了 WebView2 数据目录，
    // 连托盘都注册不上）。注意修法是**摆成 High（= 不设上限）而不是 Medium** ——
    // Medium 会把进程压在 Medium，在资源管理器跑在 High 的机器上就再也注册不了托盘
    // （用户 2026-09 那台机器就是，A/B 实测见 `tools/integrity.mjs` 的长注释）。
    ensureRunnableIntegrity(exeOut)
    return
  }

  // macOS / Linux：裸二进制（平台子包要的那份）
  const binOut = join(DIST, BIN_NAME)
  copyFileSync(built, binOut)
  execFileSync('chmod', ['755', binOut])
  console.log('  ' + binOut + '  ' + mb(binOut))
  if (isMac && wantApp) makeAppBundle(binOut)
})

/**
 * 组装 `DSH桌宠.app`。
 *
 * 为什么要包一层：裸 Mach-O 双击时是"从终端跑一个可执行文件"，没有图标、没有名字、
 * 系统当它是个普通进程；`.app` 才是 mac 上"一个应用"的样子。
 *
 * 三件事都是刻意的：
 *   * `LSUIElement = true` —— 不进程序坞、不进 Cmd-Tab（与代码里的
 *     `ActivationPolicy::Accessory` 双保险，从 Info.plist 就生效，比代码更早）；
 *   * 图标用仓库里那张 `src-tauri/icons/icon.png` 现场转 `.icns`（`sips` + `iconutil`
 *     是系统自带的，不引构建依赖）；转不出来就跳过图标，不让它挡住构建；
 *   * `codesign --sign -`：**ad-hoc 签名**。它不等于"已签名可分发"（用户仍可能被
 *     Gatekeeper 拦下，因为没有 Developer ID 与公证），但没有它连本机从"下载"来的包
 *     都更难启动。
 */
function makeAppBundle(binary) {
  const version = readFileSync(join(ROOT, 'dsh-live2d-pet', 'package.json'), 'utf8')
  const shortVersion = JSON.parse(version).version ?? '0.0.0'
  const appDir = join(DIST, 'DSH桌宠.app')
  const macosDir = join(appDir, 'Contents', 'MacOS')
  const resDir = join(appDir, 'Contents', 'Resources')
  rmSync(appDir, { recursive: true, force: true })
  mkdirSync(macosDir, { recursive: true })
  mkdirSync(resDir, { recursive: true })

  const execName = 'DSH桌宠'
  const execPath = join(macosDir, execName)
  copyFileSync(binary, execPath)
  execFileSync('chmod', ['755', execPath])

  const icon = makeIcns(resDir)
  writeFileSync(join(appDir, 'Contents', 'Info.plist'), infoPlist(execName, shortVersion, icon), 'utf8')

  try {
    execFileSync('codesign', ['--force', '--sign', '-', appDir], { stdio: 'inherit' })
  } catch (error) {
    console.log('  （ad-hoc 签名失败，产物照旧可用：' + String(error && error.message) + '）')
  }
  console.log('  ' + appDir)
}

/** `icons/icon.png` → `Resources/icon.icns`（sips + iconutil，都是系统自带）。 */
function makeIcns(resDir) {
  const source = join(DESKTOP, 'src-tauri', 'icons', 'icon.png')
  if (!existsSync(source)) return undefined
  const iconset = join(DIST, 'icon.iconset')
  try {
    rmSync(iconset, { recursive: true, force: true })
    mkdirSync(iconset, { recursive: true })
    // `iconutil` 只认这一套尺寸（16/32/128/256/512 各带一个 @2x），别自创 64x64 ——
    // 非标准文件名它会拒。
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(size), String(size), source, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
      execFileSync('sips', ['-z', String(size * 2), String(size * 2), source, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resDir, 'icon.icns')], { stdio: 'inherit' })
    return 'icon.icns'
  } catch (error) {
    console.log('  （图标转换跳过：' + String(error && error.message) + '）')
    return undefined
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

function infoPlist(execName, version, icon) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${execName}</string>
  <key>CFBundleDisplayName</key><string>${execName}</string>
  <key>CFBundleExecutable</key><string>${execName}</string>
  <key>CFBundleIdentifier</key><string>com.dsh.pet.live2d.desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
${icon === undefined ? '' : `  <key>CFBundleIconFile</key><string>${icon}</string>\n`}</dict>
</plist>
`
}

step('3/3 验证', () => {
  if (isWin === false) {
    console.log('  跳过：本机所有驱动都是 Windows 的（PowerShell / SetCursorPos / 窗口扩展样式），')
    console.log('  macOS 上的行为属于未验证区 —— 见 npm/desktop-darwin-arm64/README.md。')
    return
  }
  if (skipSuite) {
    console.log('  （--skip-suite：跳过）')
    return
  }
  // 产物名是 ASCII 的 `DSH-Pet.exe`（见上面 2/3 那段注释）—— 这里别再写成 `DSH桌宠.exe`：
  // 写错的话 `Start-Process` 静默失败，接着 probe-catalog 找不到壳端口直接 exit 2，
  // 于是一次**已经成功的构建**会在验证这一步报成失败。
  const shell = join(DIST, isWin ? 'DSH-Pet.exe' : 'DSH桌宠')
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

console.log('\nPORTABLE_OK ' + DIST)
