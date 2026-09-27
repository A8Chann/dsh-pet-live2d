// 桌面端的「设置菜单」验证：右键面板的第三个页签（设置正文），以及托盘那两条事件。
//
// 要验的是**能不能真的改设置**，不是"看着有个页签"：
//   1. 桌面端页签存在、点得开；
//   2. 设置正文真的渲染出来（卡片 / 池子 / 相位都在）；
//   3. 改一个数值 → 读回设置存档（`settingsOverrides()`），确认落盘了；
//   4. 托盘发的 `pet://settings` / `pet://reset` 事件被接住（桌面端专属那条链）。
//
//   node tools/probe-settings.mjs [--cdp-port 8823]
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const CDP = Number(argOf('--cdp-port', '8823'))

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('CDP 端口 ' + CDP + ' 上没有页面 —— 壳起来了吗？带 PET_DESKTOP_CDP 了吗？')
  process.exit(2)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const cb = pending.get(message.id)
  if (cb) { pending.delete(message.id); cb(message) }
})
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (message) => {
    if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 300)))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})
const json = async (expression) => {
  const raw = await evaluate(expression)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

/** 等一个期望值（不轮询"稳定"）。 */
async function until(label, probe, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (predicate(last)) return last
    await sleep(150)
  }
  throw new Error('超时：' + label + '，最后一次 ' + JSON.stringify(last))
}

// 桌面端标记（设置页签只在有这个标记时出现）
const desktop = await evaluate('String(window.__petDesktop !== undefined && window.__petDesktop !== null)')
check('页面带桌面端标记', desktop === 'true', 'window.__petDesktop=' + desktop)

// 开面板：真在宠物身上点右键（和用户操作同一条路）
await evaluate(`(() => {
  const root = document.querySelector('[data-dsh-live2d-pet]');
  const b = root.getBoundingClientRect();
  const el = document.elementFromPoint(Math.round(b.left + b.width * 0.5), Math.round(b.top + b.height * 0.62)) || root;
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + b.width / 2, clientY: b.top + b.height * 0.62 }));
  return true;
})()`)
const panel = await until('面板出现', () => json('JSON.stringify({ open: !!document.querySelector("[data-dsh-live2d-pet] [data-panel]"), tabs: [...document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button")].map(b => b.textContent) })'), (v) => v.open === true)
check('右键打开面板', panel.open === true, JSON.stringify(panel.tabs))
check('桌面端多了「设置」页签', panel.tabs.some((t) => t.includes('设置')), JSON.stringify(panel.tabs))

// 点开设置页签
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('[data-dsh-live2d-pet] [data-tabs] button')].find(b => b.textContent.includes('设置'));
  btn.click();
  return true;
})()`)
const body = await until('设置正文渲染', () => json(`JSON.stringify({
  wide: !!document.querySelector('[data-dsh-live2d-pet] [data-panel][data-wide]'),
  settings: !!document.querySelector('[data-dsh-live2d-pet] [data-panel-settings]'),
  cards: [...document.querySelectorAll('[data-dsh-live2d-pet] [data-panel-settings] [data-card]')].map(c => c.getAttribute('data-card')),
  inputs: document.querySelectorAll('[data-dsh-live2d-pet] [data-panel-settings] input').length,
  chips: document.querySelectorAll('[data-dsh-live2d-pet] [data-panel-settings] button').length,
})`), (v) => v.settings === true && v.cards.length > 0)
check('设置正文渲染成卡片', body.cards.length >= 5, body.cards.length + ' 张：' + body.cards.join(','))
check('面板在设置页签下加宽', body.wide === true)
check('设置里有可操作的控件', body.inputs > 0 && body.chips > 0, 'input=' + body.inputs + ' button=' + body.chips)

// 真的改一个值，然后读存档
const flagKey = 'patEnabled'
const readFlag = async () => {
  const raw = await json(`JSON.stringify({
    live: window.__dshLive2dPet.settingsOverrides().flags[${JSON.stringify(flagKey)}],
    box: (() => { const b = document.querySelector('[data-dsh-live2d-pet] [data-panel-settings] [data-flag="${flagKey}"]'); return b === null ? null : b.checked })(),
    stored: (() => { try { return JSON.parse(localStorage.getItem('dsh-pet-live2d.settings.v2') ?? '{}')?.flags?.[${JSON.stringify(flagKey)}] ?? null } catch { return 'ERR' } })(),
  })`)
  return raw
}
const before = await readFlag()
const target = before.live !== false
console.log('（改之前：' + JSON.stringify(before) + '）')
const clicked = await evaluate(`(() => {
  const box = document.querySelector('[data-dsh-live2d-pet] [data-panel-settings] [data-flag="${flagKey}"]');
  if (box === null) return 'no-box';
  // **必须用 click()**：React 对 checkbox 的 onChange 其实挂在 click 上，手写一个
  // 'change' 事件派发出去 React 根本不认（实测：DOM 的 checked 变了、插件里的开关没有）。
  // 这也是"驱动要模拟真实操作、不要自己造事件"的一个具体例子。
  box.click();
  return 'ok';
})()`)
const after = await readFlag()
console.log('（改之后：' + JSON.stringify(after) + '，dispatch=' + clicked + '）')
check('改设置真的进了存档', after.stored === !target, flagKey + ': 存档 ' + JSON.stringify(before.stored) + ' -> ' + JSON.stringify(after.stored) + '，实时值 ' + JSON.stringify(after.live))
// 改回去，别给用户留个被改过的存档
await evaluate(`(() => {
  const box = document.querySelector('[data-dsh-live2d-pet] [data-panel-settings] [data-flag="${flagKey}"]');
  if (box !== null) box.click();
  return true;
})()`)

// 托盘那两条事件：壳发的是窗口事件，页面 runtime 转发不了，这里直接派发同名事件验证页面接住了
const resetOk = await evaluate(`(() => {
  window.dispatchEvent(new Event('pet://reset'));
  return true;
})()`)
await sleep(300)
const posAfterReset = await json('JSON.stringify({ right: 24, bottom: 0, stored: JSON.parse(window.localStorage.getItem("dsh-live2d-pet.state.v1") ?? "{}") })')
check('接得住托盘的「归位」事件', resetOk === true && posAfterReset.stored.right === 24 && posAfterReset.stored.bottom === 0, JSON.stringify(posAfterReset.stored))

await evaluate(`(() => { window.dispatchEvent(new Event('pet://settings')); return true; })()`)
const reopened = await until('托盘设置事件打开面板', () => json('JSON.stringify({ open: !!document.querySelector("[data-dsh-live2d-pet] [data-panel]"), settingsTab: !!document.querySelector("[data-dsh-live2d-pet] [data-panel-settings]") })'), (v) => v.open === true && v.settingsTab === true, 4000).catch(() => null)
check('接得住托盘的「设置…」事件', reopened !== null, JSON.stringify(reopened))

socket.close()
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SETTINGS ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
