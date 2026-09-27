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
// `test-*.mjs` 是**纯 node** 的：host 半区的文件系统逻辑不需要浏览器，直接跑，
// 也就不占一个 CDP 端口、不用等模型加载。
//
//   node run-suite.mjs                 # every driver, parallel
//   node run-suite.mjs mask head       # only drivers whose name contains these
//   node run-suite.mjs --jobs 1        # serial, for debugging the suite itself
//   node run-suite.mjs --jobs 6        # more parallelism on a big machine
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { PROFILES } from './paths.mjs'
// 清单在**纯数据模块**里：这个文件一 import 就会开跑（顶层执行），所以任何想读清单的
// 工具（计时统计等）只能 import 那个模块，不能反过来 import 这个跑者。
export { SUITE, PARALLEL_SAFE } from './suite-manifest.mjs'
import { SUITE, PARALLEL_SAFE } from './suite-manifest.mjs'

const argv = process.argv.slice(2)
const jobsFlag = argv.indexOf('--jobs')
const jobsRaw = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : NaN
// Only skip the token after --jobs when --jobs is actually present: with it
// absent jobsFlag is -1, so "i !== jobsFlag + 1" silently discarded the first
// filter argument and every filtered run quietly executed the whole suite.
const only = argv.filter((a, i) => !a.startsWith('--') && (jobsFlag < 0 || i !== jobsFlag + 1))

// Headless Edge renders the model with SwiftShader, which is CPU-bound, so
// oversubscribing the cores makes every driver slower without finishing the
// suite any sooner.
//
// 上限从 6 收到 **4**：实测 6 并发时每条 driver 都被拖到 30-190s（单独跑 2.5-33s），
// 而且断言开始在负载下红（`cdp-exp` 在 4 并发下都红过一次、单独跑就绿）。
// 并发车道的意义是"把等待重叠起来"，不是"把 CPU 榨干" —— 一旦争抢到掉帧，
// 省下的时间会被重试与假红吃掉。
const JOBS = Number.isFinite(jobsRaw) && jobsRaw > 0
  ? jobsRaw
  : Math.max(2, Math.min(4, Math.floor(cpus().length / 4)))

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
// 开局先扫一次孤儿：上一轮崩溃或被 Ctrl-C 时留下的浏览器。**这时没有并发**，扫是安全的
// （而每条 driver 收尾时扫是**错的** —— 会杀掉正在并发跑的别条 driver 的浏览器，见下面注释）。
const staleAtStart = killStrayBrowsers()
if (staleAtStart > 0) console.log('（开局清掉上一轮遗留的 ' + staleAtStart + ' 个无头浏览器）')

/**
 * 杀**进程树**，不是杀那个子进程。
 *
 * 为什么单靠 `browser.kill()` 不够：headless Edge 会派生一堆子进程（渲染、GPU、utility…），
 * 杀掉父进程**不会**带走它们。实测一轮套件跑完留下 **101 个无头浏览器进程**在那儿占 CPU ——
 * 下一轮就更慢，而且这算把用户的机器当垃圾场。`taskkill /T` 才会连整棵树一起收
 * （Windows 上没有别的手段：Node 的 `kill` 不带树语义）。
 */
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch { /* 已经退了 */ }
}

/** 收掉**套件自己那些**无头浏览器 —— 靠 profile 路径认，绝不碰用户自己的浏览器。 */
function killStrayBrowsers() {
  if (process.platform !== 'win32') return 0
  try {
    const script = "$ps = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
      + "Where-Object { $_.CommandLine -match 'browser-test\\\\\\.profiles' }; "
      + "$ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
      + "$ps.Count; exit 0"
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    return Number(String(output).trim()) || 0
  } catch {
    return 0
  }
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
  const started = Date.now()
  // 纯 node 的测试不起 server（它测的是 host 半区的函数，没有 HTTP 参与）。
  const isPlainTest = file.startsWith('test-')
  const server = isPlainTest ? undefined : await startServer(PORT_BASE + slot)
  const base = server?.base
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [new URL('./' + file, import.meta.url).pathname.replace(/^\//, '')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(base === undefined ? {} : { PET_BASE: base, PET_PORT: String(PORT_BASE + slot) }) },
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => {
        // ⚠️ **这里绝对不要扫"所有套件浏览器"。** 踩过一次：收尾时调 `killStrayBrowsers()`，
        // 而它按 profile 路径匹配、会杀掉**正在并发跑的别条 driver** 的浏览器 —— 那些 driver
        // 的 WebSocket 中途断掉、`await` 悬空，进程以非 0 退出，报出来是
        // "Warning: Detected unsettled top-level await"。
        //
        // 症状极具误导性：几条 driver **几秒内快速失败**、单独跑全绿，看起来像"并发负载抖动"，
        // 于是我一直往"收并发数 / 挪 PARALLEL_SAFE 名单"的方向调，越调越乱。
        //
        // 正确的分工：**driver 收自己的**（`killBrowser(edge)`，树杀，在 driver 里），
        // 跨 driver 的清扫只在整轮的首尾（那时没有并发的别人）。
        resolve({ file, code, out, ms: Date.now() - started })
      })
    })
  } finally {
    server?.proc.kill()
  }
}

const results = []
const suiteStarted = Date.now()
/** 两条车道各自的规模与实际 worker 数（收尾那一行要报，所以要在 try 外面可见）。 */
let parallelLane = []
let serialLane = []
let parallelJobs = 0
try {
  let pending = Object.entries(SUITE).filter(([file]) => only.length === 0 || only.some((o) => file.includes(o)))
  const total = pending.length

  if (pending.length === 0) {
    // Nothing matched. Without this the pool below never settles: it only
    // resolves from a driver's completion callback, and with no drivers there
    // is none — so a typo'd filter hung the runner instead of failing fast.
    console.error('no driver matches: ' + only.join(', '))
    console.error('available: ' + Object.keys(SUITE).join(', '))
    process.exit(1)
  }

  /**
   * **两条车道**：能并发的并发跑，脆弱的独占跑。
   *
   * 为什么不是"全都 N 并发"：headless Edge 用 SwiftShader 软件渲染模型，是纯 CPU 的，
   * 而这台机器上**并发的代价是双向的** ——
   *
   *   * 抢 CPU 让每个 driver 都变慢（实测 6 并发跑出 260 秒，比串行还慢）；
   *   * 更糟的是**断言开始失败**：靠固定 sleep 等缓动的 driver 在掉帧时读到半途的值，
   *     6 并发实测红 6 条（cdp-motion / cdp-idle-return / cdp-head / cdp-bubble /
   *     cdp-interact / cdp-react-defaults），串行时全绿。
   *
   * 所以并发只给那些**断言读终值、对帧率不敏感**的 driver（`PARALLEL_SAFE`，依据是实测
   * 失败模式而不是感觉）；其余独占整机跑 —— 它们反而因此变快，因为没人跟它们抢 CPU。
   */
  const parallelLaneLocal = pending.filter(([file]) => PARALLEL_SAFE.has(file))
  const serialLaneLocal = pending.filter(([file]) => !PARALLEL_SAFE.has(file))
  parallelLane = parallelLaneLocal
  serialLane = serialLaneLocal

  console.log('running ' + total + ' drivers：'
    + parallelLane.length + ' 条可并发（' + Math.min(JOBS, parallelLane.length) + ' workers）+ '
    + serialLane.length + ' 条独占跑\n')

  // A monotonic slot per driver, NOT the live worker count: that count is
  // reused as drivers finish, so two concurrent drivers would land on the same
  // port and the second server would fail to bind.
  let slotSeq = 0

  /**
   * 跑一条车道；`jobs` 为 1 就是独占。
   *
   * 返回这一车里**失败**的条目，好让调用方决定要不要重试。
   */
  const runLane = async (lane, jobs) => {
    let running = 0
    let next = 0
    const failedHere = []
    await new Promise((resolve) => {
      const pump = () => {
        while (running < jobs && next < lane.length) {
          const [file, label] = lane[next]
          next += 1
          running += 1
          runDriver(file, ++slotSeq).then((r) => {
            running -= 1
            const ok = r.code === 0
            results.push({ file, label, ok, ms: r.ms, out: r.out })
            if (!ok) failedHere.push([file, label])
            console.log((ok ? 'PASS ' : 'FAIL ') + file.padEnd(22) + label + '  (' + r.ms + 'ms)')
            if (!ok) console.log(r.out.split('\n').slice(-25).join('\n'))
            if (next >= lane.length && running === 0) resolve()
            else pump()
          })
        }
        // 空车道直接收（否则这个 Promise 永远不 resolve）。
        if (lane.length === 0) resolve()
      }
      pump()
    })
    return failedHere
  }

  // 长的一车先开跑（总时长取两车之和，先跑长的能把"尾巴"摊平）。
  const sumOf = (lane, per) => lane.length * per
  const parallelFirst = sumOf(parallelLane, 1) < sumOf(serialLane, 1)
  parallelJobs = Math.min(JOBS, Math.max(1, parallelLane.length))
  const lanes = parallelFirst
    ? [[parallelLane, parallelJobs], [serialLane, 1]]
    : [[serialLane, 1], [parallelLane, parallelJobs]]
  let retry = []
  for (const [lane, jobs] of lanes) {
    const failed = await runLane(lane, jobs)
    // **并发车道里失败的，独占重跑一次。**
    //
    // 为什么不继续手工挪名单：`PARALLEL_SAFE` 是靠"哪条红过"维护的，而红不红取决于
    // 这台机器当时有多忙 —— 换一天、换一台机器，名单又不对了（实测 `cdp-exp` /
    // `cdp-phase` / `cdp-host-events` 都出现过"并发红、单独绿"）。手工调永远追不上抖动。
    //
    // 所以规则改成：**并发车道只用来"把等待重叠起来"，它的红不作为结论**；失败的一律
    // 独占重跑，以那一轮为准。独占跑没有 CPU 争抢，结论是可信的。
    if (jobs > 1 && failed.length > 0) {
      retry = failed
      console.log('\n并发车道有 ' + failed.length + ' 条失败 → 独占重跑一遍（并发下的红不作为结论）\n')
    }
  }
  if (retry.length > 0) {
    for (const [file, label] of retry) {
      const again = await runLane([[file, label]], 1)
      // 重试那一轮的结果是**刚 push 进来的最后一条**（`runLane` 只管 push）；
      // 先把它取出来，再把**原来那条**替换掉 —— 不替换的话 `results` 里会留两份，
      // 计数就变成"3 条 driver 报 4 条 passed"。
      const fresh = results.pop()
      const index = results.findIndex((r) => r.file === file)
      if (again.length === 0) {
        // 重试通过：结论改成通过，但**标注出来**，别把并发的抖动藏掉。
        results[index] = { ...fresh, retried: true }
        console.log('（' + file + ' 并发下失败、独占重跑通过）')
      } else {
        results[index] = fresh
      }
    }
  }
} finally {
  purgeProfiles()
  // 收尾再扫一次：中断的那一轮（Ctrl-C / 被 kill）不会有 driver 收尾回调，
  // 留下的浏览器进程只能靠这里清。
  const strays = killStrayBrowsers()
  if (strays > 0) console.log('（收尾清掉 ' + strays + ' 个遗留的无头浏览器）')
}

// Report in SUITE order so the table is stable regardless of finish order.
results.sort((a, b) => Object.keys(SUITE).indexOf(a.file) - Object.keys(SUITE).indexOf(b.file))
const failed = results.filter((r) => !r.ok)
const retried = results.filter((r) => r.retried === true)
const wall = Math.max(...results.map((r) => r.ms))
// **总时长也要报**：两条车道是串起来跑的，所以"最慢的单条"根本不是套件耗时 ——
// 少了这一行，改调度时就只能靠感觉判断快了还是慢了。
console.log('\n' + results.length + ' drivers, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed'
  + '   (slowest ' + wall + 'ms, 总时长 ' + ((Date.now() - suiteStarted) / 1000).toFixed(1) + 's, '
  + '并发车道 ' + parallelLane.length + '@' + parallelJobs + ' + 独占 ' + serialLane.length + ')')
if (retried.length > 0) {
  // 标出来，别把并发的抖动藏掉：这些是"并发下红、独占重跑绿"的。
  console.log('其中 ' + retried.length + ' 条是并发下失败、独占重跑才通过的：'
    + retried.map((r) => r.file).join(' '))
}
process.exit(failed.length === 0 ? 0 : 1)
