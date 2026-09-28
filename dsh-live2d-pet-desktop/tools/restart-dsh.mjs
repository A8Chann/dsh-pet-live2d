// 用**固定参数**重启 DSH（web profile、3080），并把结果打出来。
//
// 为什么写成脚本：上两次我用 PowerShell 拼命令行，`--profile web` 被吃成了 `--profile`
// （于是 profile 退回 minimal），页面直接变成 "Failed to load plugins"。参数不再经过
// shell 拼接，就不会再有这个问题。
//
//   node tools/restart-dsh.mjs
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BIN = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const NODE = process.execPath
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(BIN)) {
  console.error('找不到 DSH 入口：' + BIN)
  process.exit(2)
}

/** 找现在在听 3080 的进程。 */
async function ownerOf3080() {
  const result = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.on('close', () => resolve(out.trim()))
  })
  return result === '' ? null : Number(result)
}

const existing = await ownerOf3080()
if (existing !== null) {
  console.log('停掉正在听 3080 的进程 ' + existing)
  try { process.kill(existing) } catch { /* 可能已经退了 */ }
  await sleep(3000)
}

// **参数是数组**，不经过任何 shell 拼接。
const args = [BIN, '--profile', 'web', '--no-open', '--port', '3080']
console.log('启动：' + NODE + ' ' + args.join(' '))
const child = spawn(NODE, args, { detached: true, stdio: 'ignore' })
child.unref()

// 等它起来，然后自证：命令行对不对、插件路由在不在。
for (let i = 0; i < 30; i += 1) {
  await sleep(1000)
  try {
    const response = await fetch('http://127.0.0.1:3080/api/live2d-pet/catalog', { cache: 'no-store' })
    console.log('第 ' + (i + 1) + ' 秒：/api/live2d-pet/catalog → ' + response.status)
    if (response.status === 200) {
      const settings = await fetch('http://127.0.0.1:3080/api/live2d-pet/settings', { cache: 'no-store' })
      console.log('/api/live2d-pet/settings → ' + settings.status
        + '  ' + (await settings.text()).slice(0, 120))
      console.log('')
      console.log('DSH 已用 web profile 起来，插件路由正常。')
      process.exit(0)
    }
  } catch {
    process.stdout.write('.')
  }
}
console.error('')
console.error('30 秒内没等到 /api/live2d-pet/catalog 变成 200 —— 可能 profile 或插件加载有问题，'
  + '看 DSH 自己的日志。')
process.exit(1)
