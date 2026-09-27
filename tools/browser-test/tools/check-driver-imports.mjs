// 检查每个 driver 用到的跨模块标识符**都 import 了吗**。
//
// 为什么要有这个：`tools/migrate-kill-browser.mjs` 批量替换时漏了一个分支
// （`cdp-settings-render.mjs` 不 import `ready.mjs`，于是它替换了调用却没加 import），
// 症状是**所有断言都 PASS、退出码却是 1** —— 输出看起来全绿，只有退出码在喊。
// 那种失败最容易被当成"偶发"放过。
//
//   node tools/check-driver-imports.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE } from '../paths.mjs'
import { SUITE } from '../suite-manifest.mjs'

/** 跨模块的公共工具 → 应该从哪个模块来。 */
const EXPORTS = {
  './ready.mjs': ['waitReady', 'openPanel', 'closePanel', 'panelFooter', 'pageErrors', 'pauseFidget', 'killBrowser'],
  './wait-for.mjs': ['waitFor', 'waitForBoot', 'createWaiter', 'checkEventually', 'mustElapse', 'signal', 'POLL_MS'],
}

let bad = 0
for (const file of Object.keys(SUITE)) {
  let source
  try {
    source = readFileSync(join(HERE, file), 'utf8')
  } catch {
    continue
  }
  const problems = []
  for (const [module, names] of Object.entries(EXPORTS)) {
    for (const name of names) {
      // 用到它了吗？用"作为标识符出现且不是 import 那一行"来判定。
      const used = new RegExp('(?<![\\w.$])' + name + '\\s*\\(').test(source)
        && !new RegExp("import[^\\n]*\\b" + name + "\\b[^\\n]*from '" + module.replace('./', '\\./') + "'").test(source)
      if (used) {
        // 也许它从别处 import 了（那是另一回事，报出来让人看一眼）。
        const importedAnywhere = new RegExp("import[^\\n]*\\b" + name + "\\b").test(source)
        problems.push(name + (importedAnywhere ? '（从别的模块 import 了？）' : '（**没有 import**）'))
      }
    }
  }
  if (problems.length > 0) {
    bad += 1
    console.log('  ' + file.padEnd(26) + problems.join('、'))
  }
}
console.log(bad === 0
  ? 'DRIVER-IMPORTS PASS —— 每个 driver 用到的公共工具都 import 了'
  : 'DRIVER-IMPORTS FAIL —— ' + bad + ' 个 driver 有缺失的 import（症状会是"断言全绿、退出码 1"）')
process.exit(bad === 0 ? 0 : 1)
