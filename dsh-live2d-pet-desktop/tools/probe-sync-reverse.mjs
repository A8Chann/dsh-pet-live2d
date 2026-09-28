// **反方向**验证：桌面端页面改一项 → DSH 一侧看得见。
//
// 用户的 bug 是"桌面的设置与 DSH 里的设置没有同步"，方向不重要 —— 两边都得同步。
// 这里触发的是**真实的用户动作**（点桌面右键面板里"显示气泡"那个开关），
// 然后问宿主要那份存档：变了就说明桌面端这一侧真的写进共享存档了。
//
//   node tools/probe-sync-reverse.mjs [--cdp 9401]
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp', '9401'))
const DSH = argOf('--dsh', 'http://127.0.0.1:3080')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && target === undefined; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* 还没起来 */ }
  if (target === undefined) await sleep(300)
}
if (target === undefined) { console.error('CDP 上没有页面'); process.exit(2) }
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const ev = async (expression) => {
  const result = await new Promise((resolve) => {
    const id = ++seq
    pending.set(id, (message) => resolve(message.result))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  if (result?.exceptionDetails !== undefined) return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
  return result?.result?.value
}
const json = async (expression) => {
  const raw = await ev(expression)
  if (raw !== null && typeof raw === 'object' && typeof raw.__error === 'string') throw new Error(raw.__error)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const hostSettings = async () => (await fetch(DSH + '/api/live2d-pet/settings', { cache: 'no-store' })).json()

const before = await hostSettings()
const beforeFlag = before.overrides?.flags?.bubbleEnabled ?? null
console.log('宿主里 bubbleEnabled（改之前）：' + String(beforeFlag) + '  rev=' + before.rev)

// 打开桌面右键面板 → 设置页签 → 点"显示气泡"开关（真实用户动作）
const opened = await json(`JSON.stringify((() => {
  const stage = document.querySelector('[data-dsh-live2d-pet] [data-hit]') || document.querySelector('[data-dsh-live2d-pet] [data-stage]');
  if (stage === null) return { ok: false, why: 'no-stage' };
  stage.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return { ok: true };
})())`)
check('能在桌面端打开右键面板', opened.ok === true, JSON.stringify(opened))
await sleep(700)

const switched = await json(`JSON.stringify((() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const panel = root.querySelector('[data-panel]');
  if (panel === null) return { ok: false, why: 'no-panel' };
  // 切到「设置」页签（那是显示设置正文的那一格）
  const tabs = Array.from(panel.querySelectorAll('[data-tabs] button'));
  const tab = tabs.find((b) => (b.textContent || '').includes('设置'));
  if (tab !== undefined) tab.click();
  return { ok: true, tabs: tabs.map((b) => (b.textContent || '').trim()) };
})())`)
console.log('页签：' + JSON.stringify(switched))
await sleep(800)

const clicked = await json(`JSON.stringify((() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const box = root.querySelector('[data-flag="bubbleEnabled"]');
  if (box === null) return { ok: false, why: 'no-flag-input' };
  const wasChecked = box.checked;
  box.click();
  return { ok: true, wasChecked: wasChecked, nowChecked: box.checked };
})())`)
check('点到了「显示气泡」开关', clicked.ok === true, JSON.stringify(clicked))
await sleep(1200)

const after = await hostSettings()
const afterFlag = after.overrides?.flags?.bubbleEnabled ?? null
check('**宿主存档跟着变了**（桌面端的改动写进了共享存档）',
  afterFlag !== null && afterFlag !== beforeFlag,
  'bubbleEnabled ' + String(beforeFlag) + ' → ' + String(afterFlag) + '  rev ' + before.rev + ' → ' + after.rev)

// 还原（点回去），别把用户的设置改坏
if (afterFlag !== beforeFlag) {
  await json(`JSON.stringify((() => {
    const box = document.querySelector('[data-dsh-live2d-pet] [data-flag="bubbleEnabled"]');
    if (box !== null) box.click();
    return { ok: true };
  })())`)
  await sleep(1200)
  const restored = await hostSettings()
  // `null`（"没存过这一项"）与显式的 `true` 是**同一个意思**（默认就是开），
  // 所以不能拿 `===` 比 —— 第一版就是这么误报的。
  const same = (value, expected) => value === expected
    || (value === null && expected === true)
    || (value === true && expected === null)
  check('还原成原值（语义等价即可：null 与 true 都是"开着"）',
    same(restored.overrides?.flags?.bubbleEnabled ?? null, beforeFlag),
    'bubbleEnabled=' + String(restored.overrides?.flags?.bubbleEnabled))
}

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SYNC-REVERSE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' '
  + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
