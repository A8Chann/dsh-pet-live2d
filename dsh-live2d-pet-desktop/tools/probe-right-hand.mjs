// **右手到底抬没抬** —— 量手部那块几何在画面里的位置。
//
// 用户的纠正：「我从来没说过手机的事儿……我的意思一直是**右手没有抬起来**」。
// 所以判据不能是某个参数等于几（前几轮我一直盯 `phone` / `phone2`，方向就错了），
// 而要量**手那块几何**：模型空间 y 向上，"抬手" = 手的盒子 y 变大。
//
// 手的部件 id 从原始 cdi3 里取（不写死）：`手L` = Part125、`手R` = Part126。
//
//   node tools/probe-right-hand.mjs [--cdp 9401]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cdi3 = JSON.parse(readFileSync('P:/DSH/live2d原始/c_0120.cdi3.json', 'utf8'))
const handParts = (cdi3.Parts ?? [])
  .filter((part) => /^(手L|手R)$/.test(String(part.Name ?? '')))
  .map((part) => ({ id: String(part.Id), name: String(part.Name) }))
console.log('手的部件：' + JSON.stringify(handParts))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) {
  console.error('CDP ' + CDP + ' 上没有页面（带 PET_DESKTOP_CDP=' + CDP + ' 起一份壳）')
  process.exit(2)
}
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => {
    const failure = message.result?.exceptionDetails
    if (failure !== undefined) {
      resolve({ __error: String(failure.exception?.description ?? failure.text ?? 'threw') })
      return
    }
    resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
async function inPage(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = 'JSON.stringify((function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })())'
  const raw = await evaluate(expression)
  return raw === undefined ? undefined : JSON.parse(raw)
}
async function inPageAsync(bodyLines, args = {}) {
  const source = 'return (function (args) {\n' + bodyLines.join('\n') + '\n})(args)'
  const expression = '(function () { const args = '
    + JSON.stringify(args) + '; const run = new Function("args", ' + JSON.stringify(source) + '); return run(args) })()'
  return await evaluate(expression)
}

/** 手部两块（L/R）各自的 drawable id 清单。 */
const handDrawables = await inPage([
  'const api = window.__dshLive2dPet;',
  'const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  'const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  'if (rows.length === 0) return { error: "no-drawable-table" };',
  'const out = {};',
  'for (const id of args.ids) out[id] = [];',
  'for (const row of rows) {',
  '  const partId = String(row.partId ?? "");',
  '  if (args.ids.indexOf(partId) < 0) continue;',
  '  out[partId].push(String(row.id));',
  '}',
  'return { byPart: out, rows: rows.length };',
], { ids: handParts.map((part) => part.id) })
console.log('手部 drawable：' + JSON.stringify(handDrawables.byPart))

const rightDrawables = handDrawables.byPart?.['Part126'] ?? []
const leftDrawables = handDrawables.byPart?.['Part125'] ?? []

/**
 * 帧内采样：给的这几块 drawable 的**并集盒**（模型空间，y 向上）。
 *
 * 帧内（`requestAnimationFrame`）而不是从外面读：拍手/放手是瞬时的，
 * 外面每几十毫秒采一次会量到一堆静止值（这一轮为此白查过两轮，见 skill）。
 */
const sampleBox = (ids, ms) => inPageAsync([
  'const api = window.__dshLive2dPet;',
  'const wanted = args.ids;',
  'let samples = 0, maxTop = null, minTop = null, minBottom = null;',
  'const groups = [];',
  'return new Promise(function (resolve) {',
  '  const started = performance.now();',
  '  function tick() {',
  '    samples += 1;',
  '    const table = typeof api.drawableTable === "function" ? api.drawableTable() : null;',
  '    const rows = Array.isArray(table) ? table : (table && table.drawables) || [];',
  '    let top = null, bottom = null;',
  '    for (const row of rows) {',
  '      if (wanted.indexOf(String(row.id)) < 0) continue;',
  '      if (row.box === null || row.box === undefined) continue;',
  '      if (top === null || row.box.maxY > top) top = row.box.maxY;',
  '      if (bottom === null || row.box.minY < bottom) bottom = row.box.minY;',
  '    }',
  '    if (top !== null) {',
  '      if (maxTop === null || top > maxTop) maxTop = top;',
  '      if (minTop === null || top < minTop) minTop = top;',
  '      if (minBottom === null || bottom < minBottom) minBottom = bottom;',
  '    }',
  '    const g = api.currentGroup ? api.currentGroup() : null;',
  '    if (g !== null && groups.indexOf(g) < 0) groups.push(g);',
  '    if (performance.now() - started < args.ms) requestAnimationFrame(tick);',
  '    else resolve({ samples: samples, maxTop: maxTop, minTop: minTop, minBottom: minBottom, groups: groups });',
  '  }',
  '  requestAnimationFrame(tick);',
  '});',
], { ids, ms })

async function openPanel() {
  await inPage(['if (window.__dshLive2dPet.phaseNow) window.__dshLive2dPet.phaseNow("idle");', 'return true;'])
  await sleep(700)
  await inPage([
    'const stage = document.querySelector("[data-dsh-live2d-pet] [data-hit]") || document.querySelector("[data-dsh-live2d-pet] [data-stage]");',
    'stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
    'return true;',
  ])
  await sleep(500)
  await inPage([
    'const buttons = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));',
    'const tab = buttons.find((b) => (b.textContent || "").includes("装扮"));',
    'if (tab) tab.click();',
    'return true;',
  ])
  await sleep(500)
}
const clickSlot = (slot, label) => inPage([
  'const root = document.querySelector("[data-dsh-live2d-pet]");',
  'const group = root.querySelector("[data-panel] [data-slot=\\"" + args.slot + "\\"]");',
  'if (group === null) return { ok: false, reason: "no-slot" };',
  'const buttons = Array.from(group.querySelectorAll("[data-chips] button"));',
  'const hit = buttons.find((b) => (b.textContent || "").trim() === args.label);',
  'if (hit === undefined) return { ok: false, options: buttons.map((b) => b.textContent.trim()) };',
  'hit.click();',
  'return { ok: true };',
], { slot, label })

const report = (title, box) => {
  console.log('  ' + title + '：手R 并集盒 y ∈ [' + box.minBottom + ', ' + box.maxTop + ']'
    + '（最高 ' + box.maxTop + '，最低 ' + box.minBottom + '），组=' + JSON.stringify(box.groups))
}

await openPanel()

const idle = await sampleBox(rightDrawables, 2500)
console.log('')
report('待机', idle)

console.log('')
console.log('--- ① 只点「掏出手机」')
console.log('  点选：' + JSON.stringify(await clickSlot('rhand', '掏出手机')))
const phone = await sampleBox(rightDrawables, 3000)
report('掏出手机', phone)
console.log('  → 相对待机：手 R 最高点 ' + (phone.maxTop - idle.maxTop).toFixed(1)
  + '，最低点 ' + (phone.minBottom - idle.minBottom).toFixed(1))

console.log('')
console.log('--- ② 再点「自拍」')
console.log('  点选：' + JSON.stringify(await clickSlot('selfie', '自拍')))
const selfie = await sampleBox(rightDrawables, 4000)
report('自拍（右手已选着掏出手机）', selfie)
console.log('  → 相对待机：手 R 最高点 ' + (selfie.maxTop - idle.maxTop).toFixed(1))

console.log('')
console.log('--- ③ 清掉右手，只点「自拍」（看前提会不会把手机补上）')
await clickSlot('rhand', '无')
await sleep(1500)
const cleared = await sampleBox(rightDrawables, 1500)
report('清掉右手后', cleared)
console.log('  点选：' + JSON.stringify(await clickSlot('selfie', '自拍')))
const selfieAlone = await sampleBox(rightDrawables, 4000)
report('自拍（前提补手机）', selfieAlone)
console.log('  → 相对清掉后：手 R 最高点 ' + (selfieAlone.maxTop - cleared.maxTop).toFixed(1))

console.log('')
console.log('--- 左手对照（Part125）')
const leftIdle = await sampleBox(leftDrawables, 2000)
report('待机（左手）', leftIdle)

socket.close()
