// 共享设置路由的**端到端**验证（走真实的宿主代码，不是 mock）。
//
//   node tools/probe-settings-sync.mjs
//
// 验三件事：
//   ① `GET /api/live2d-pet/settings` 给出 `{tuning,overrides,outfit,rev}`；
//   ② `POST` 一项**只动那一项**（两个"窗口"轮流写，各自的项都在）—— 这就是跨 origin 同步的地基；
//   ③ 落盘的是 `%DSH_HOME%` 下的 `pet-settings.json`（不是页面自己的 localStorage）。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const HARNESS = join(ROOT, 'tools', 'browser-test')
const PORT = 8981
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

const child = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: HARNESS, stdio: 'ignore' })
await sleep(2500)

const url = 'http://127.0.0.1:' + PORT + '/api/live2d-pet/settings'
const getJson = async () => {
  const response = await fetch(url, { cache: 'no-store' })
  return { status: response.status, body: await response.json() }
}
const postJson = async (payload) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

try {
  // ① 读口
  const first = await getJson()
  check('GET /settings 可用（200 + 三个键 + rev）',
    first.status === 200 && first.body.ok === true
    && 'tuning' in first.body && 'overrides' in first.body && 'outfit' in first.body
    && typeof first.body.rev === 'number',
    JSON.stringify(first.body).slice(0, 140))

  // ② 两个"窗口"轮流写
  const a = await postJson({ tuning: { gazeRangePx: 321 } })
  check('窗口 A 写调参成功（rev 推进）', a.status === 200 && a.body.ok === true && a.body.tuning?.gazeRangePx === 321,
    'rev=' + a.body.rev)
  const b = await postJson({ outfit: { glasses: '圆眼镜' } })
  check('窗口 B 写装扮成功', b.status === 200 && b.body.outfit?.glasses === '圆眼镜', 'rev=' + b.body.rev)
  const c = await postJson({ overrides: { flags: { bubbleEnabled: false } } })
  check('窗口 A 再写开关成功', c.status === 200 && c.body.overrides?.flags?.bubbleEnabled === false, 'rev=' + c.body.rev)

  const merged = await getJson()
  check('**三项都在**（合并写，谁也没擦掉谁）',
    merged.body.tuning?.gazeRangePx === 321
    && merged.body.outfit?.glasses === '圆眼镜'
    && merged.body.overrides?.flags?.bubbleEnabled === false,
    JSON.stringify({ tuning: merged.body.tuning, outfit: merged.body.outfit, overrides: merged.body.overrides }))
  check('rev 单调推进（1→2→3）',
    a.body.rev === 1 && b.body.rev === 2 && c.body.rev === 3,
    [a.body.rev, b.body.rev, c.body.rev].join(','))

  // ③ 落盘位置（真实路径带点：`tools/browser-test/.profiles/_layer-home`）
  const file = join(HARNESS, '.profiles', '_layer-home', 'pet-settings.json')
  check('落在 home 下的 pet-settings.json（不是页面 localStorage）', existsSync(file), file)
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    check('文件内容是缩进 JSON 且含三项',
      text.includes('"tuning"') && text.includes('"outfit"') && text.includes('"overrides"'),
      text.slice(0, 80).replace(/\s+/g, ' '))
  }

  // ④ 空写不推进版本（防回环）
  const empty = await postJson({})
  check('空 POST 不推进 rev（防跨窗口回环）', empty.body.rev === merged.body.rev, 'rev=' + empty.body.rev)
} finally {
  // 优雅收尾：直接 kill 会让 libuv 在退出时报 `UV_HANDLE_CLOSING` 断言（看着像功能坏了，
  // 其实只是没等子进程把监听句柄放掉）。
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(400)
}

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SETTINGS-SYNC ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
