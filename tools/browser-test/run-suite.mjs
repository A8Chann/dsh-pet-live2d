// Regression suite runner.
//
// Starts the harness server, runs the contract drivers in SUITE, prints a
// PASS/FAIL table, and always tears the server down again.
//
// Drivers run CONCURRENTLY. Each owns its own debugging port and its own Edge
// profile, so they are already isolated; running them one after another was
// pure wall-clock waste — the serial suite spent most of its time waiting on
// timers inside a single driver while thirteen others sat idle.
//
//   node run-suite.mjs                 # every driver, parallel
//   node run-suite.mjs mask head       # only drivers whose name contains these
//   node run-suite.mjs --jobs 1        # serial, for debugging the suite itself
//   node run-suite.mjs --jobs 6        # more parallelism on a big machine
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { PROFILES } from './paths.mjs'

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

const argv = process.argv.slice(2)
const jobsFlag = argv.indexOf('--jobs')
const jobsRaw = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : NaN
// Only skip the token after --jobs when --jobs is actually present: with it
// absent jobsFlag is -1, so "i !== jobsFlag + 1" silently discarded the first
// filter argument and every filtered run quietly executed the whole suite.
const only = argv.filter((a, i) => !a.startsWith('--') && (jobsFlag < 0 || i !== jobsFlag + 1))

// Headless Edge renders the model with SwiftShader, which is CPU-bound, so
// oversubscribing the cores makes every driver slower without finishing the
// suite any sooner. Half the cores (at least 2, at most 6) measured fastest.
const JOBS = Number.isFinite(jobsRaw) && jobsRaw > 0
  ? jobsRaw
  : Math.max(2, Math.min(6, Math.floor(cpus().length / 2)))

const PORT_BASE = Number(process.env.PET_PORT_BASE ?? 8793)

/** Start one harness server on its own port; resolved once it answers. */
async function startServer(port) {
  const base = 'http://127.0.0.1:' + port
  // Two attempts, and a generous window: the suite now starts this server
  // alongside up to six headless browsers, and under that load the catalog
  // scan (which reads the whole model directory) can take well over the six
  // seconds a single-driver run needed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proc = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname.replace(/^\//, ''), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let died = false
    proc.stdout.on('data', () => {})
    proc.stderr.on('data', (d) => { process.stderr.write('[server ' + port + '] ' + d) })
    proc.on('exit', () => { died = true })
    for (let i = 0; i < 200; i += 1) {
      if (died) break
      try { const r = await fetch(base + '/api/live2d-pet/catalog'); if (r.ok) return { proc, base } } catch { /* retry */ }
      await sleep(100)
    }
    proc.kill()
    if (died) break
  }
  throw new Error('harness server did not come up on ' + base)
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

/**
 * Run one driver against its OWN harness server.
 *
 * The activity hub lives in the server process, and several drivers drive it
 * through /__nudge and /__emit. Sharing one server therefore made concurrent
 * drivers fight over the current phase — cdp-host-events saw its phase reset
 * underneath it and cdp-idle-return caught someone else's phase still active.
 * A server each costs a few milliseconds to boot and removes the coupling
 * entirely, which is what makes the parallel run trustworthy.
 */
async function runDriver(file, slot) {
  const { proc, base } = await startServer(PORT_BASE + slot)
  const started = Date.now()
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [new URL('./' + file, import.meta.url).pathname.replace(/^\//, '')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PET_BASE: base, PET_PORT: String(PORT_BASE + slot) },
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ file, code, out, ms: Date.now() - started }))
    })
  } finally {
    proc.kill()
  }
}

const results = []
try {
  let pending = Object.entries(SUITE).filter(([file]) => only.length === 0 || only.some((o) => file.includes(o)))
  const total = pending.length
  console.log('running ' + total + ' drivers across ' + Math.min(JOBS, total) + ' workers\n')

  if (pending.length === 0) {
    // Nothing matched. Without this the pool below never settles: it only
    // resolves from a driver's completion callback, and with no drivers there
    // is none — so a typo'd filter hung the runner instead of failing fast.
    console.error('no driver matches: ' + only.join(', '))
    console.error('available: ' + Object.keys(SUITE).join(', '))
    process.exit(1)
  }

  let running = 0
  // A monotonic slot per driver, NOT the live worker count: that count is
  // reused as drivers finish, so two concurrent drivers would land on the same
  // port and the second server would fail to bind.
  let slotSeq = 0
  await new Promise((resolve) => {
    const pump = () => {
      while (running < JOBS && pending.length > 0) {
        const [file, label] = pending.shift()
        running += 1
        runDriver(file, ++slotSeq).then((r) => {
          running -= 1
          const ok = r.code === 0
          results.push({ file, label, ok, ms: r.ms, out: r.out })
          console.log((ok ? 'PASS' : 'FAIL') + '  ' + file.padEnd(20) + label + '  (' + r.ms + 'ms)')
          if (!ok) console.log(r.out.split('\n').slice(-25).join('\n'))
          if (pending.length === 0 && running === 0) resolve()
          else pump()
        })
      }
    }
    pump()
  })
} finally {
  purgeProfiles()
}

// Report in SUITE order so the table is stable regardless of finish order.
results.sort((a, b) => Object.keys(SUITE).indexOf(a.file) - Object.keys(SUITE).indexOf(b.file))
const failed = results.filter((r) => !r.ok)
const wall = Math.max(...results.map((r) => r.ms))
console.log('\n' + results.length + ' drivers, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed'
  + '   (slowest ' + wall + 'ms, ' + JOBS + ' workers)')
process.exit(failed.length === 0 ? 0 : 1)
