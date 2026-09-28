// 互动与气泡：摸头/摸尾巴/转圈三个互动、相位台词、以及"所有文本/位置/开关都可配"。
//
// 对应用户这批的 (2)(3)(4)(5)(6)(7)(8)。断言分两类：
//   - **机制**：判定/触发真的发生了（摸尾巴命中、转圈累计够、相位弹台词）；
//   - **可配**：改设置真的改变行为（文本、偏移、开关），读的是"有效值"而不是 input.value。
//
// 注意：本 driver 必须用 `run-suite.mjs --jobs 1 interact` 跑（BASE 由 run-suite 拉起）。
// 裸跑 `node cdp-interact.mjs` 时 BASE 无人服务，页面加载不出来，而 waitReady 返回 false
// 不会自己抛 —— 表现是一堆"设置挂不出来"的假红。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { waitReady, openPanel, pageErrors, killBrowser } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

const EDGE = browserPath()
const PORT = 9388
const PROFILE = join(PROFILES, '_cdp-interact')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + PROFILE, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let page
for (let i = 0; i < 120 && page === undefined; i++) {
  try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page') } catch {}
  if (page === undefined) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
const send = (a, p = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method: a, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
await waitForBoot(ev)

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(200) }
  return false
}
/** 防崩的 JSON 读口：读不到就返回 null，而不是让整个 driver 抛在 JSON.parse 上。 */
const json = async (expr) => {
  const raw = await ev(expr)
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}
const bubble = () => ev('(document.querySelector("[data-dsh-live2d-pet] [data-bubble]")||{}).textContent ?? null')
/** 在页面坐标点一下（按下 + 抬起，走真实的 pointer 事件）。 */
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
/** 用原生 setter 派发，React 的受控 input 才认（直接改 .value 会被忽略）。 */
const setInput = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (el === null) return false
  const proto = el.type === 'checkbox' ? window.HTMLInputElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, ${JSON.stringify(String(value))})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
/** 勾/取消一个开关（checkbox 用 click() 才会走 React 的 onChange）。 */
const setFlag = (key, wanted) => ev(`(() => {
  const box = document.querySelector('#dsh-settings-probe [data-flag=${JSON.stringify(key)}]')
  if (box === null) return false
  if (box.checked !== ${wanted ? 'true' : 'false'}) box.click()
  return true
})()`)

check('页面真的加载出来了（BASE 有服务）', (await ev('!!window.__dshLive2dPet')) === true, 'BASE=' + BASE)
check('模型与点击遮罩就绪', (await waitReady(ev)) === true)

// 把设置正文挂进探针容器（drivers 一直这么干；重复挂载会翻倍，所以先查在不在）。
const openSettings = async () => ev('(() => {'
  + ' if (document.querySelector("#dsh-settings-probe")) return true;'
  + ' const slot = (window.__pluginSections ?? {})["pet-settings"];'
  + ' if (!slot) return false;'
  + ' const host = document.createElement("div"); host.id = "dsh-settings-probe"; document.body.appendChild(host);'
  + ' window.ReactDOM.createRoot(host).render(slot.render());'
  + ' return true })()')
await openPanel(ev)
let mounted = false
for (let i = 0; i < 20 && !mounted; i += 1) { mounted = (await openSettings()) === true; if (!mounted) await sleep(300) }
check('设置正文能挂出来', mounted)
await sleep(900)

// --- (2)(3)(4) 设置里必须真的能配 ------------------------------------------
const cards = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-card]")).map(n => n.getAttribute("data-card")))')
check('设置页有「互动」卡', String(cards).includes('interact'), cards)
check('设置页有「气泡」卡', String(cards).includes('bubble'), cards)
const flags = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-flag]")).map(n => n.getAttribute("data-flag")))')
for (const key of ['patEnabled', 'tailEnabled', 'spinEnabled', 'bubbleEnabled']) {
  check('开关存在：' + key, String(flags).includes(key), flags)
}
const sliders = await ev('JSON.stringify(Array.from(document.querySelectorAll("#dsh-settings-probe [data-input]")).map(n => n.getAttribute("data-input")))')
for (const key of ['bubbleOffsetX', 'bubbleOffsetY', 'bubbleHoldMs', 'spinTurns', 'spinWindowMs']) {
  check('滑杆存在：' + key, String(sliders).includes(key), '')
}
// 台词：每个字段都要有输入框（"所有的文本都可配"）。
// fields 读不到就**判失败**，不能当成"没有字段所以全都有"（空洞断言）。
const fields = await json('JSON.stringify(window.__dshLive2dPet.lineFields())')
check('台词字段清单读得到（否则下面的"都有输入框"会空洞通过）',
  fields !== null && Array.isArray(fields.plain) && fields.plain.length >= 7, JSON.stringify(fields))
const missing = []
for (const key of (fields?.plain ?? [])) {
  const found = await ev('document.querySelector("#dsh-settings-probe [data-line-input=\\"' + key + '\\"]") !== null')
  if (found !== true) missing.push(key)
}
for (const key of (fields?.phase ?? [])) {
  const found = await ev('document.querySelector("#dsh-settings-probe [data-line-input=\\"phase:' + key + '\\"]") !== null')
  if (found !== true) missing.push('phase:' + key)
}
check('每条台词都有输入框（问候/摸头/相位…全都能改）',
  (fields?.plain?.length ?? 0) > 0 && missing.length === 0, '缺: ' + JSON.stringify(missing))
// 反应候选：三组 chips，且默认值与宠物声明一致
const chips = await json(`JSON.stringify({
  pat: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="patReactions"] [data-reaction-chip]').length,
  tail: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="tailReactions"] [data-reaction-chip]').length,
  spin: document.querySelectorAll('#dsh-settings-probe [data-reaction-set="spinReactions"] [data-reaction-chip]').length,
  patOn: window.__dshLive2dPet.effectiveReactions('patReactions'),
  tailOn: window.__dshLive2dPet.effectiveReactions('tailReactions'),
  spinOn: window.__dshLive2dPet.effectiveReactions('spinReactions'),
})`)
check('三组反应候选都渲染出来了（chips 数 > 0）',
  (chips?.pat ?? 0) > 0 && (chips?.tail ?? 0) > 0 && (chips?.spin ?? 0) > 0,
  JSON.stringify({ pat: chips?.pat, tail: chips?.tail, spin: chips?.spin }))
check('摸头默认候选 = 宠物声明的三个',
  (chips?.patOn ?? []).length === 3 && (chips?.patOn ?? []).includes('重锤出击'), JSON.stringify(chips?.patOn))
check('转晕默认候选 = 晕晕', (chips?.spinOn ?? []).includes('晕晕'), JSON.stringify(chips?.spinOn))

// --- (3) 摸尾巴：判定与**路由** -------------------------------------------------
// 用户报的："现在摸头也是出现的摸尾巴的效果"。根因有两条：
//   ① 尾巴/翅膀是**可选配件**，同一时刻只有一个显形，其余几何还在原地 → 判定区域会重叠；
//   ② 点击路由原来**先判尾巴再判头**，于是重叠区的点击一律算摸尾巴。
// 所以这里必须断**路由**（点头给的台词是哪一类），而不是只断"存在只命中尾巴的点"——
// 我第一版就是那么写的，结果 1112 个头部命中点里 697 个同时命中尾巴，测试却是绿的。
const tailParts = (await json('JSON.stringify(window.__dshLive2dPet.partHitCounts("tail"))')) ?? []
const tailGeometry = tailParts.filter((p) => (p?.hitsAll ?? 0) > 0).map((p) => p.id)
const tailProbe = await json(`(() => {
  const c = window.__dshLive2dPet
  const r = document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect()
  let sumX = 0, sumY = 0, n = 0, tailOnly = null, both = 0, head = 0, tail = 0
  for (let iy = 0; iy < 40; iy++) {
    for (let ix = 0; ix < 40; ix++) {
      const lx = r.width * (ix + 0.5) / 40, ly = r.height * (iy + 0.5) / 40
      const h = c.hitsHead(lx, ly), t = c.hitsTail(lx, ly)
      if (h) head += 1
      if (t) tail += 1
      if (h && t) both += 1
      // 点要落在**头部区域的重心**上、而且真的落在角色身上（遮罩里）：模型一直在动，
      // 取"最上面第一个命中点"（= 头顶边缘）等换完坐标它已经挪开了，点击会落空。
      if (h && !t && c.hitsMask(lx, ly, r.width, r.height)) { sumX += lx; sumY += ly; n += 1 }
      if (t && !h && tailOnly === null) tailOnly = { lx, ly }
    }
  }
  const headPoint = n > 0 ? { lx: sumX / n, ly: sumY / n, samples: n } : null
  return JSON.stringify({ headPoint, tailOnly, both, head, tail, rect: { x: r.x, y: r.y } })
})()`)
check('摸尾巴判定与几何一致：有几何就该有命中；几何全退化（默认没戴尾巴配件）就该一个都不中',
  tailGeometry.length > 0 ? (tailProbe?.tail ?? 0) > 0 : (tailProbe?.tail ?? -1) === 0,
  '有几何的部件=' + JSON.stringify(tailGeometry) + ' tail 命中=' + tailProbe?.tail)
check('找得到一个**只算头、不算尾巴**的点（下面那条路由断言才有意义）',
  tailProbe?.headPoint !== null && tailProbe?.headPoint !== undefined,
  JSON.stringify({ headPoint: tailProbe?.headPoint, both: tailProbe?.both, head: tailProbe?.head, tail: tailProbe?.tail }))
if (tailProbe?.headPoint) {
  const patLines = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().pat)')
  const tailLines = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().tail)')
  await ev('window.__dshLive2dPet.phaseNow("idle")')
  await sleep(600)
  await clickAt(tailProbe.rect.x + tailProbe.headPoint.lx, tailProbe.rect.y + tailProbe.headPoint.ly)
  const said = await until(async () => {
    const text = await bubble()
    return text !== null && (String(patLines).includes(text) || String(tailLines).includes(text))
  }, 6000)
  const text = await bubble()
  // 路由是**尾巴优先**（2026-09 按用户要求从"头优先"翻回来）。
  //
  // 历史：最早先判尾巴，用户报"摸头出的是摸尾巴的效果" → 改成先判头；那个报告的前提是
  // `hitsTail` 把 11 块**没显形的配件**也算进去（尾鳍上 86.6% 的点同时算头）。收窄到
  // 5 块真尾鳍之后重叠降到 **9%**，而用户看到"尾巴画在头发上面"，于是要求点在尾鳍上算摸尾巴。
  //
  // 所以这条断言取的是**只算头、不算尾巴**的点（上面的 headPoint 已经是这个含义）：
  // 点头部仍然给摸头台词；重叠那一片（29/1024 格）现在归尾巴，这是有意的取舍。
  check('点**只算头**的部位给的是摸头台词（重叠区归尾巴，见路由注释）',
    said && String(patLines).includes(text),
    'bubble=' + text + ' pat=' + String(patLines) + ' tail=' + String(tailLines))
}

// --- 尾巴：点**可见的尾鳍**必须给摸尾巴的台词 ----------------------------------
// 用户报的："尾巴一直在摆动，摸尾巴的事件现在很难点到。" 根因有两层，都得在这里盯住：
//   ① `hitsTail` 原来把那 16 块"名字里带尾/翅"的几何全算尾巴（其中 11 块是**可换配件**，
//      几何一直留在原地、横跨全身），于是"算尾巴"的格子占角色 22%、其中 86.6% 同时算头，
//      而路由是摸头优先 ⇒ 点在可见的尾鳍上拿到的是摸头反应；
//   ② 可点轮廓是开机抓一次的静态快照，而尾鳍一直在摆 ⇒ 摆出去的那一瞬间事件穿透到页面
//      （实测 elementFromPoint 返回 HTML，而判定说她是）。
//
// 上面那条"存在只命中尾巴的点"**证明不了**这两件事 —— 它当初就是绿的。所以要断行为。
const tailLines = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().tail)')
const patLines = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().pat)')
const bodyLines = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().click)')
const findTailPoint = () => ev(`(() => {
  const api = window.__dshLive2dPet;
  const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");
  const r = stage.getBoundingClientRect();
  const N = 64;
  const canvas = stage.querySelector("canvas");
  const off = document.createElement("canvas");
  off.width = N; off.height = N;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  const cells = [];
  for (let gy = 0; gy < N; gy += 1) {
    for (let gx = 0; gx < N; gx += 1) {
      const lx = r.width * (gx + 0.5) / N, ly = r.height * (gy + 0.5) / N;
      if (api.hitsTail(lx, ly) !== true) continue;
      if (api.hitsHead(lx, ly) === true) continue;
      cells.push({ lx, ly, painted: px[(gy * N + gx) * 4 + 3] > 24 });
    }
  }
  if (cells.length === 0) return JSON.stringify({ point: null, reason: "no-tail-cell" });
  const outside = cells.filter((c) => api.hitsMaskStatic(c.lx, c.ly, r.width, r.height) === false);
  const pool = outside.length > 0 ? outside : cells;
  const cx = pool.reduce((s, c) => s + c.lx, 0) / pool.length;
  const cy = pool.reduce((s, c) => s + c.ly, 0) / pool.length;
  let best = pool[0], bestD = Infinity;
  for (const c of pool) {
    const d = (c.lx - cx) ** 2 + (c.ly - cy) ** 2;
    if (d < bestD) { bestD = d; best = c }
  }
  return JSON.stringify({
    point: best, rect: { x: r.x, y: r.y },
    cells: cells.length, painted: cells.filter((c) => c.painted).length,
    outsideStatic: outside.length,
    onModel: api.hitsMask(best.lx, best.ly, r.width, r.height) === true,
    staticOnly: api.hitsMaskStatic(best.lx, best.ly, r.width, r.height) === true,
  });
})()`)

const routing = JSON.parse((await findTailPoint()) ?? '{}')
check('尾鳍上有一批「只算尾巴、不算头」的点（下面那条断言的输入）',
  (routing?.cells ?? 0) >= 20 && (routing?.point ?? null) !== null,
  JSON.stringify({ cells: routing?.cells, painted: routing?.painted, outsideStatic: routing?.outsideStatic }))
if (routing?.point) {
  // 顺序很重要：先把上一轮的气泡等掉，**再取点、立刻点**。反过来会让尾鳍在空档里摆走，
  // 按住时的几何已经不是选中那一个（探针里为此误判过好几轮）。
  await until(async () => (await bubble()) === null, 8000)
  const fresh = JSON.parse((await findTailPoint()) ?? '{}')
  check('取到的点落在开机快照之外、但判定（含尾巴实时盒子）算落在她身上',
    (fresh?.outsideStatic ?? 0) > 0 && fresh?.onModel === true,
    JSON.stringify({ cells: fresh?.cells, outsideStatic: fresh?.outsideStatic, onModel: fresh?.onModel, staticOnly: fresh?.staticOnly }))
  if (fresh?.point) {
    // 取点和点击**必须在同一次页面求值里**：分两次 CDP 往返的话，尾鳍在中间就摆走了，
    // 按住时的几何已经不是选中那一个（实测就是"onHead=true onTail=false"这种自相矛盾的读数）。
    const clicked = JSON.parse(await ev(`(() => {
      const api = window.__dshLive2dPet;
      const stage = document.querySelector("[data-dsh-live2d-pet] [data-stage]");
      const r = stage.getBoundingClientRect();
      const N = 64;
      const canvas = stage.querySelector("canvas");
      const off = document.createElement("canvas");
      off.width = N; off.height = N;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, N, N);
      const px = ctx.getImageData(0, 0, N, N).data;
      const cells = [];
      for (let gy = 0; gy < N; gy += 1) {
        for (let gx = 0; gx < N; gx += 1) {
          const lx = r.width * (gx + 0.5) / N, ly = r.height * (gy + 0.5) / N;
          if (api.hitsTail(lx, ly) !== true) continue;
          if (api.hitsHead(lx, ly) === true) continue;
          if (!(px[(gy * N + gx) * 4 + 3] > 24)) continue;
          cells.push({ lx, ly });
        }
      }
      if (cells.length === 0) return JSON.stringify({ ok: false, reason: "no-tail-cell" });
      const cx = cells.reduce((s, c) => s + c.lx, 0) / cells.length;
      const cy = cells.reduce((s, c) => s + c.ly, 0) / cells.length;
      let best = cells[0], bestD = Infinity;
      for (const c of cells) {
        const d = (c.lx - cx) ** 2 + (c.ly - cy) ** 2;
        if (d < bestD) { bestD = d; best = c }
      }
      const node = document.elementFromPoint(r.x + best.lx, r.y + best.ly);
      const target = node === null ? "null" : (node.closest("[data-dsh-live2d-pet]") ? "pet" : node.tagName);
      const before = JSON.parse(JSON.stringify({
        head: api.hitsHead(best.lx, best.ly) === true,
        tail: api.hitsTail(best.lx, best.ly) === true,
        staticMask: api.hitsMaskStatic(best.lx, best.ly, r.width, r.height) === true,
      }));
      const opts = { bubbles: true, cancelable: true, clientX: r.x + best.lx, clientY: r.y + best.ly, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
      const down = new PointerEvent("pointerdown", opts);
      const up = new PointerEvent("pointerup", Object.assign({}, opts, { buttons: 0 }));
      (node && node.closest("[data-dsh-live2d-pet]") ? node : stage).dispatchEvent(down);
      (node && node.closest("[data-dsh-live2d-pet]") ? node : stage).dispatchEvent(up);
      return JSON.stringify({ ok: true, target, before, count: cells.length, point: best });
    })()`) ?? '{}')
    check('取点与点击之间没有空档（同一次求值），事件落在宠物身上',
      clicked.ok === true && clicked.target === 'pet' && clicked.before.tail === true && clicked.before.head === false,
      JSON.stringify(clicked))
    const saidTail = await until(async () => {
      const text = await bubble()
      return text !== null && String(tailLines).includes(text)
    }, 6000)
    const text = await bubble()
    const press = JSON.parse(await ev('JSON.stringify(window.__dshLive2dPet.lastPress ? window.__dshLive2dPet.lastPress() : null)') ?? 'null')
    check('点可见的尾鳍 → 摸尾巴的台词（用户报的「很难点到」）',
      saidTail && String(tailLines).includes(text),
      'bubble=' + text + ' | 按住时 onModel=' + press?.onModel + ' onHead=' + press?.onHead
      + ' onTail=' + press?.onTail + ' | tail=' + String(tailLines)
      + ' pat=' + String(patLines) + ' click=' + String(bodyLines))
  } else {
    check('点可见的尾鳍 → 摸尾巴的台词（用户报的「很难点到」）', false, '第二轮没取到点: ' + JSON.stringify(fresh))
  }
}

// --- (5)(7)(8) 气泡：相位台词 / 偏移 / 总开关 -------------------------------
await ev('window.__dshLive2dPet.phaseNow("thinking")')
// 问候气泡也在用同一个位置，所以轮询到**等于 thinking 那句**为止。
const thinkingLine = await ev('window.__dshLive2dPet.effectiveLines().phase.thinking')
const phaseSaid = await until(async () => (await bubble()) === thinkingLine, 9000)
check('会话相位会弹台词气泡（thinking）', phaseSaid,
  'bubble=' + (await bubble()) + ' 台词=' + thinkingLine)
// 位置偏移：改滑杆 -> 气泡上的 CSS 变量跟着变（值，不是布局规则）
check('改得了气泡左右偏移', (await setInput('#dsh-settings-probe [data-input="bubbleOffsetX"]', '40')) === true)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("done")')
await until(async () => (await bubble()) !== null, 6000)
const offset = await ev('(() => {'
  + ' const node = document.querySelector("[data-dsh-live2d-pet] [data-bubble]");'
  + ' return node === null ? null : node.style.getPropertyValue("--bubble-x") })()')
check('气泡位置偏移可配（改了立刻反映到气泡上）', offset === '40px', '--bubble-x=' + offset)
// 总开关：关掉之后任何台词都不弹
check('关得掉气泡总开关', (await setFlag('bubbleEnabled', false)) === true)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(600)
// 先确认"这时候本来该弹"：手动把开关开回来试一次，再关掉验证。
await setFlag('bubbleEnabled', true)
await ev('window.__dshLive2dPet.phaseNow("failed")')
const wouldSay = await until(async () => (await bubble()) === (await ev('window.__dshLive2dPet.effectiveLines().phase.failed')), 8000)
check('开着开关时 failed 相位确实会弹（下面那条断言才有意义）', wouldSay, 'bubble=' + (await bubble()))
await setFlag('bubbleEnabled', false)
await sleep(400)
await ev('window.__dshLive2dPet.phaseNow("idle")')
await sleep(500)
// 等上一条气泡自己消失，再触发一次：这次不该出现。
await until(async () => (await bubble()) === null, 8000)
await ev('window.__dshLive2dPet.phaseNow("done")')
await sleep(1500)
check('关掉总开关后不再弹气泡', (await bubble()) === null, 'bubble=' + (await bubble()))
check('开关状态可读（进了同一份设置存档）',
  (await ev('window.__dshLive2dPet.settingsOverrides().flags.bubbleEnabled')) === false)
check('开得回来', (await setFlag('bubbleEnabled', true)) === true)
await sleep(400)

// --- (4) 转圈转晕 -----------------------------------------------------------
// 时间窗必须**宽到与机器速度无关**：合成的画圈是逐次 CDP 往返（几百次），窗口一到期
// 累计就被整轮作废。原来这里设的是 6000ms —— 那已经是这个字段的**上限**
// （`spinWindowMs` 的 max，见 TUNING_FIELDS），机器吃力时画完 3.2 圈要 6 秒以上，
// 于是只剩最后小半圈被累计、`total` 停在 0.59 弧度，三条断言一起假红（单跑就绿）。
//
// 所以这里**不假装能设更大**：断言改成"设置真的生效了"，值就是上限本身；要迁就的是
// 画圈要比 6 秒快（下面那条 elapsed 断言会把这一点明确报出来，而不是留一堆看不懂的红）。
const SPIN_WINDOW_MS = 6000
check('时间窗可配（拉到上限 6000ms）',
  (await setInput('#dsh-settings-probe [data-input="spinWindowMs"]', String(SPIN_WINDOW_MS))) === true)
await sleep(400)
check('窗口设置真的生效了',
  (await ev('window.__dshLive2dPet.spinDebug().windowMs')) === SPIN_WINDOW_MS,
  'windowMs=' + await ev('window.__dshLive2dPet.spinDebug().windowMs'))
const spinSetup = await json(`(() => {
  const r = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect()
  return JSON.stringify({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, radius: r.width * 0.45 })
})()`)
// 步数=每圈 32 步（每步 ~11°，比"抖动"大得多，判定按 `atan2` 的增量累计，够用）。
// 早先是每圈 96 步 = 308 次 CDP 往返，实测要 7 秒 —— 比 6 秒的窗口还长，累计必被作废。
// 每次往返约 23ms 是这里唯一真正的时间开销，所以**减少步数**是唯一有效的办法。
const steps = 32
const turns = 3.2
// 画圈本身要**比时间窗快**，否则窗口中途到期、累计被整轮作废（见上面的说明）。
// 所以顺手量一下耗时并断言：机器吃力时这条会直接报出来，而不是让下面三条一起红。
const spinStart = Date.now()
for (let i = 0; i <= steps * turns; i++) {
  const angle = (i / steps) * Math.PI * 2
  const x = Math.round((spinSetup?.cx ?? 0) + Math.cos(angle) * (spinSetup?.radius ?? 100))
  const y = Math.round((spinSetup?.cy ?? 0) + Math.sin(angle) * (spinSetup?.radius ?? 100))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}
const spinElapsed = Date.now() - spinStart
check('合成画圈跑得比时间窗快（否则累计会被整轮作废）', spinElapsed < SPIN_WINDOW_MS * 0.8,
  '画了 ' + Math.ceil(steps * turns) + ' 步用了 ' + spinElapsed + 'ms，窗口 ' + SPIN_WINDOW_MS + 'ms')
const spinLine = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().spin)')
const spun = await until(async () => {
  const text = await bubble()
  return text !== null && String(spinLine).includes(text)
}, 5000)
const spinState = await ev('JSON.stringify(window.__dshLive2dPet.spinDebug())')
check('鼠标绕圈会转晕（弹台词）', spun, 'bubble=' + (await bubble()) + ' 台词=' + String(spinLine) + ' 状态=' + spinState)
check('转圈检测真的触发了（fires > 0，而不是"看着像没反应"）',
  ((await json('JSON.stringify(window.__dshLive2dPet.spinDebug())'))?.fires ?? 0) > 0, spinState)
// 「晕晕」驱动的是 ParamCheek77；`drawn()` 按名字片段找参数，两种写法都试一下，
// 断错参数名会得到"表情没生效"的假象（我第一版写的是 hun，根本不存在）。
const cheekHit = await until(async () => {
  const v = ((await ev('window.__dshLive2dPet.drawn("Cheek77")'))
    ?? (await ev('window.__dshLive2dPet.drawn("ParamCheek77")')) ?? 0)
  return v > 0.1
}, 4000)
check('转晕会演「晕晕」（表情真的写进模型）', cheekHit,
  'Cheek77=' + await ev('window.__dshLive2dPet.drawn("Cheek77")'))

// --- 台词可改：改了之后真的说新的 -------------------------------------------
check('改得了「被转晕」的台词', (await setInput('#dsh-settings-probe [data-line-input="spin"]', '测试专用台词')) === true)
await sleep(400)
const edited = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().spin)')
check('改台词之后有效台词跟着变', String(edited).includes('测试专用台词'), edited)
check('台词覆盖进了同一份设置存档',
  String(await ev('JSON.stringify(window.__dshLive2dPet.settingsOverrides().lines)')).includes('spin'))

const errors = await pageErrors(ev)
check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 240))
const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
ws.close()
killBrowser(edge)
await sleep(300)
process.exit(bad.length === 0 ? 0 : 1)
