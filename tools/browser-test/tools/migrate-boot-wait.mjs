// 一次性改造：把 18 个 driver 里那段复制粘贴的"等 harness 就绪"换成 `waitForBoot`。
//
// 要替换的形态（每轮 400-500ms，最坏 96-120 秒）：
//
//   for (let i = 0; i < 240; i++) { await sleep(400); if (await ev('document.title') === 'done') break }
//
// 换成 `await waitForBoot(ev)`（100ms 轮询、30 秒上限，见 wait-for.mjs）。
//
//   node tools/migrate-boot-wait.mjs [--dry]
//
// 这个脚本只做**一处**机械替换，替换前后都不碰别的行；`--dry` 只打印要改哪些文件。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE } from '../paths.mjs'
import { SUITE } from '../suite-manifest.mjs'

const dry = process.argv.includes('--dry')

// 宽松一点：间隔 300-600ms、轮数 100-300、`ev` 或 `evaluate` 都可能。
const PATTERN = /for \(let i = 0; i < (\d+); i\+\+\) \{ await sleep\((\d+)\); if \(await (ev|evaluate)\('document\.title'\) === 'done'\) break \}/

const changed = []
const skipped = []
for (const file of Object.keys(SUITE)) {
  if (file.startsWith('test-')) continue
  const path = join(HERE, file)
  const source = readFileSync(path, 'utf8')
  const match = PATTERN.exec(source)
  if (match === null) {
    skipped.push(file)
    continue
  }
  const [, rounds, interval, evaluateName] = match
  const replacement = 'await waitForBoot(' + evaluateName + ')'
  let next = source.replace(match[0], replacement)

  // 补 import：插在最后一条 import 之后（保持原有顺序，别动别的行）。
  if (!next.includes("from './wait-for.mjs'")) {
    const lastImport = [...next.matchAll(/^import .*$/gm)].pop()
    next = next.slice(0, lastImport.index + lastImport[0].length)
      + "\nimport { waitForBoot } from './wait-for.mjs'"
      + next.slice(lastImport.index + lastImport[0].length)
  }
  const before = (Number(rounds) * Number(interval) / 1000)
  changed.push({ file, from: before + 's 最坏', to: '30s 上限 / 100ms 轮询' })
  if (!dry) writeFileSync(path, next)
}

console.log((dry ? '（--dry）' : '') + '替换 ' + changed.length + ' 个 driver：')
for (const item of changed) console.log('  ' + item.file.padEnd(26) + item.from + ' → ' + item.to)
if (skipped.length > 0) console.log('未匹配（没这段代码，可能本来就用了 ready.mjs）：\n  ' + skipped.join(' '))
