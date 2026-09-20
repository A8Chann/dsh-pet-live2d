// One-shot regression suite runner.
//
// Starts the harness server, runs every contract driver in SUITE, prints a
// PASS/FAIL table, and always tears the server down again.
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'
import { HERE, BASE, PROFILES } from './paths.mjs'

/** filename -> what user-visible contract it proves. */
export const SUITE = {
  'cdp-sm.mjs': '动作状态机：点击→播放→回待机、重播、连点、面板播放、归位',
  'cdp-v12.mjs': 'v1.2 交互契约：面板不缩放、点击遮罩、视线回正、相位映射、摸鱼',
  'cdp-phase.mjs': '会话相位 → 动作映射（SSE）',
  'cdp-mask.mjs': '点击轮廓网格（alpha 剪影）',
  'cdp-gaze.mjs': '注视跟随与回默认位',
  'cdp-dpr.mjs': 'DPR 渲染倍率（放大清晰）',
  'cdp-sharp.mjs': '2x 超采样下限（缩小不虚）',
  'cdp-motion.mjs': '动作语义：嘴还原 / 喷水 / 定格 / 前置动作',
  'cdp-exp.mjs': '表情面板：44 项可点且真的生效',
  'cdp-handoff2.mjs': '定格姿势能被会话相位接管',
  'cdp-host-events.mjs': '真实 DSH 事件接线（tools/*）+ 相位持续播放',
  'cdp-head.mjs': '点头部才重锤出击；摸鱼不碰重锤/喷水',
  'cdp-idle-return.mjs': '动作/表情到点自动回到初始待机',
  'cdp-passthrough.mjs': '只有角色可拖动，透明处事件穿透',
}

const PORT = 8793
const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname.replace(/^\//, ''), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {})
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/live2d-pet/catalog'); if (r.ok) return true } catch { /* retry */ }
    await sleep(250)
  }
  return false
}

// Every driver creates a disposable Edge profile (~50-80 MB). They are removed
// on exit, but a crashed or interrupted run leaves them behind, so sweep both
// before and after.
const purgeProfiles = () => {
  try { rmSync(PROFILES, { recursive: true, force: true }) } catch { /* best effort */ }
}
purgeProfiles()

// Rebuild the DBG variant from the current client source.
//
// It is a copy, so it silently goes stale whenever client.js changes — once
// that made cdp-motion fail against a variant that predated a fix. Rebuilding
// here means a suite run can never test yesterday's code.
const variant = spawnSync(process.execPath, [new URL('./make-variant.mjs', import.meta.url).pathname.replace(/^\//, '')], { encoding: 'utf8' })
if (variant.status !== 0) {
  console.error('make-variant failed:\n' + (variant.stderr || variant.stdout || ''))
  process.exit(1)
}

const only = process.argv.slice(2)
const results = []
try {
  if (!await waitForServer()) throw new Error('harness server did not come up on ' + BASE)
  for (const [file, label] of Object.entries(SUITE)) {
    if (only.length > 0 && !only.some((o) => file.includes(o))) continue
    const started = Date.now()
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [new URL('./' + file, import.meta.url).pathname.replace(/^\//, '')], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (c) => resolve({ code: c, out }))
    })
    const ok = code.code === 0
    results.push({ file, label, ok, ms: Date.now() - started, out: code.out })
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + file.padEnd(20) + label + '  (' + (Date.now() - started) + 'ms)')
    if (!ok) console.log(code.out.split('\n').slice(-25).join('\n'))
  }
} finally {
  server.kill()
  purgeProfiles()
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + results.length + ' drivers, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed')
process.exit(failed.length === 0 ? 0 : 1)
