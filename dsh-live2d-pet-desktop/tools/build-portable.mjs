// 一键产出**单文件便携 exe**。
//
// 顺序是有讲究的（每一步都是下一步的输入）：
//
//   1. prep-embed  —— 把插件宿主半区、随包宠物、React、Cubism Core、页面铺到 sidecar/embed/，
//                     并生成资源清单（壳与 sidecar 都按它来）；
//   2. build-sidecar —— deno compile 把 sidecar 编成独立二进制（内含上一步那堆资源）；
//   3. cargo build --release —— 壳把 sidecar 二进制与资源一起 `include_bytes!` 进 exe；
//   4. 拷到 dist/ —— 起个人看得懂的名字，把大小报出来。
//
// 产出只有一个文件。用户双击就能用：不需要装 node、不需要装 DSH、不需要装插件。
//
//   node tools/build-portable.mjs [--skip-suite]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from '../sidecar/paths.mjs'

const argv = process.argv.slice(2)
const skipSuite = argv.includes('--skip-suite')
const DIST = join(DESKTOP, 'dist')
const EXE_SRC = join(DESKTOP, 'src-tauri', 'target', 'release', 'dsh-pet-live2d-desktop.exe')
const EXE_OUT = join(DIST, 'DSH桌宠.exe')

const cargo = process.platform === 'win32'
  ? join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe')
  : 'cargo'
const cargoBin = existsSync(cargo) ? cargo : 'cargo'
const env = {
  ...process.env,
  PATH: join(process.env.USERPROFILE ?? '', '.cargo', 'bin') + ';' + (process.env.PATH ?? ''),
}

const step = (title, fn) => {
  console.log('\n=== ' + title + ' ===')
  fn()
}

step('1/5 铺 embed 资源', () => {
  execFileSync('node', [join(DESKTOP, 'tools', 'prep-embed.mjs')], { stdio: 'inherit', env })
})

step('2/5 编译 sidecar 独立二进制（deno compile）', () => {
  execFileSync('node', [join(DESKTOP, 'tools', 'build-sidecar.mjs')], { stdio: 'inherit', env })
})

step('3/5 编译壳（release，含内嵌 sidecar 与资源）', () => {
  execFileSync(cargoBin, ['build', '--release'], {
    stdio: 'inherit',
    cwd: join(DESKTOP, 'src-tauri'),
    env,
  })
})

step('4/5 产出 dist/' + 'DSH桌宠.exe', () => {
  if (!existsSync(EXE_SRC)) throw new Error('没找到 release 产物：' + EXE_SRC)
  mkdirSync(DIST, { recursive: true })
  copyFileSync(EXE_SRC, EXE_OUT)
  const mb = statSync(EXE_OUT).size / 1024 / 1024
  console.log('  ' + EXE_OUT + '  ' + mb.toFixed(1) + ' MB')
})

step('5/5 网页端回归（守卫没影响 web 行为）', () => {
  if (skipSuite) {
    console.log('  （--skip-suite：跳过）')
    return
  }
  execFileSync('node', ['run-suite.mjs', '--jobs', '1'], {
    stdio: 'inherit',
    cwd: join(DESKTOP, '..', 'tools', 'browser-test'),
    env,
  })
})

console.log('\nPORTABLE_OK ' + EXE_OUT)
