// 一次性改造：driver 里的 `edge.kill()` 全部换成 `killBrowser(edge)`（树杀）。
//
// 要替换的形态（20 处，缩进与变量名各异）：
//
//   edge.kill()
//   ws.close(); edge.kill(); process.exit(0)
//   try { edge.kill() } catch { /* already gone */ }
//
// `killBrowser` 会连浏览器派生的子进程一起收（`edge.kill()` 收不掉，实测漏 101 个）。
//
//   node tools/migrate-kill-browser.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE } from '../paths.mjs'
import { SUITE } from '../suite-manifest.mjs'

const dry = process.argv.includes('--dry')

// `名称.kill()` 里名称是 edge / browser / child —— 只替换**这些**，别碰 `server.kill()`。
const PATTERN = /\b(edge|browser)\.kill\(\)/g

const changed = []
for (const file of Object.keys(SUITE)) {
  const path = join(HERE, file)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  const hits = [...source.matchAll(PATTERN)]
  if (hits.length === 0) continue
  let next = source.replace(PATTERN, (_, name) => 'killBrowser(' + name + ')')

  // 补 import。
  //
  // ⚠️ 这里原来写的是 `if (!next.includes('killBrowser') || next.includes("from './ready.mjs'"))`
  // —— **分支漏洞**：`cdp-settings-render.mjs` 既不 import ready.mjs、替换后又含有
  // `killBrowser` 这个词，两个条件同时为假，于是**调用被替换了、import 却没加**。
  // 症状是那条 driver 所有断言都 PASS、退出码却是 1（`ReferenceError` 发生在收尾那一步），
  // 最容易被当成偶发放过去。
  //
  // 正确判据只有一个：**它到底有没有 import 进来**。
  if (!/import \{[^}]*killBrowser[^}]*\} from '\.\/ready\.mjs'/.test(next)) {
    const readyImport = /^import \{([^}]*)\} from '\.\/ready\.mjs'$/m.exec(next)
    if (readyImport !== null) {
      const names = readyImport[1].split(',').map((n) => n.trim()).filter((n) => n !== '')
      if (!names.includes('killBrowser')) names.push('killBrowser')
      next = next.replace(readyImport[0], "import { " + names.join(', ') + " } from './ready.mjs'")
    } else {
      const lastImport = [...next.matchAll(/^import .*$/gm)].pop()
      next = next.slice(0, lastImport.index + lastImport[0].length)
        + "\nimport { killBrowser } from './ready.mjs'"
        + next.slice(lastImport.index + lastImport[0].length)
    }
  }
  // 替换完**当场验一遍**：改了调用却没 import 的话，这里就该抛。
  if (!/import \{[^}]*killBrowser[^}]*\} from '\.\/ready\.mjs'/.test(next)) {
    throw new Error(file + '：替换了 killBrowser 调用但没能补上 import')
  }
  changed.push({ file, count: hits.length })
  if (!dry) writeFileSync(path, next)
}

console.log((dry ? '（--dry）' : '') + '替换 ' + changed.length + ' 个 driver，共 '
  + changed.reduce((sum, item) => sum + item.count, 0) + ' 处：')
for (const item of changed) console.log('  ' + item.file.padEnd(26) + item.count + ' 处')
