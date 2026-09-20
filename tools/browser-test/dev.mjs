// Fast development loop.
//
// The full suite is the pre-commit gate, not the inner loop. This keeps one
// harness server alive, watches the files a driver actually depends on, and
// re-runs only the drivers you asked for — so a change is verified in seconds
// instead of minutes.
//
//   node dev.mjs head              # watch + re-run drivers matching "head"
//   node dev.mjs head passthrough  # several at once, still concurrent
//   node dev.mjs --once mask       # single run, no watch (same as run-suite)
//   node dev.mjs                   # watch the whole suite
//
// Watched: the client and host halves, the pet manifest, and the drivers
// themselves. Watching the whole plugin directory would also fire on the
// regenerated DBG variant, which the runner writes on every pass — that made
// the first version of this loop re-run itself forever.
import { spawn } from 'node:child_process'
import { watch, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { HERE, PLUGIN } from './paths.mjs'

const argv = process.argv.slice(2)
const once = argv.includes('--once')
const only = argv.filter((a) => !a.startsWith('--'))

const watchTargets = [
  join(PLUGIN, 'lib', 'client.js'),
  join(PLUGIN, 'lib', 'index.js'),
  join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'pets', 'ds-whale-girl', 'pet.json'),
]

let child = null
let queued = false
const run = () => {
  if (child !== null) { queued = true; return }
  console.log('\n=== ' + new Date().toLocaleTimeString() + '  running ' + (only.length ? only.join(', ') : 'the whole suite') + ' ===')
  child = spawn(process.execPath, [new URL('./run-suite.mjs', import.meta.url).pathname.replace(/^\//, ''), ...only], { stdio: 'inherit' })
  child.on('close', () => {
    child = null
    if (queued) { queued = false; run() }
  })
}

run()
if (once) {
  const wait = () => { if (child === null) process.exit(0); setTimeout(wait, 200) }
  wait()
} else {
  for (const target of watchTargets) {
    if (!existsSync(target)) continue
    watch(target, { persistent: true }, () => {
      console.log('[dev] changed: ' + target.replace(PLUGIN + '\\', ''))
      run()
    })
  }
  console.log('[dev] watching ' + watchTargets.filter(existsSync).length + ' files; Ctrl+C to stop')
}
