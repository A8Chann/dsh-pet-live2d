// 设置**正文**能不能渲染出来（这是套件之前的一个盲点）。
//
// 为什么要单开一个 driver：其它 driver 只验"设置那一节注册上了"（`__pluginSections` 里有
// 没有 `pet-settings`），**没有一个真的调用它的 render**。于是下面这种崩法可以悄悄溜过去：
//
//   ReferenceError: layerRef is not defined
//       at LayerControls (client.js)
//
// 症状是"宠物一切正常，只有设置页打不开" —— 因为设置页那一节渲染在**宠物组件之外**
// （挂在 DSH 设置页上），读组件内的 ref 会立刻炸。2026-09 真的踩过一次。
//
//   node cdp-settings-render.mjs        # 由 run-suite.mjs 拉起（自带服务器）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, browserPath, HERE, PROFILES } from './paths.mjs'
import { killBrowser, waitReady } from './ready.mjs'

const PORT = Number(process.env.PET_PORT ?? 8793)
const PROFILE = join(PROFILES, '_cdp-settings-render')
/**
 * CDP 端口**必须跟着分配到的 slot 走**，不能写死。
 *
 * 写死一个常量（原来就是 9333）时，并发跑两条以上会抢同一个调试端口 —— 后起的
 * `--remote-debugging-port` 绑不上，driver 连不上自己的浏览器，于是**几秒内快速失败**
 * （实测：并发时 cdp-mask / cdp-phase / cdp-dpr 三条都在 4 秒左右红，独占重跑就绿）。
 * 那看起来像"负载抖动"，其实是端口冲突 —— 会让人往错误的方向调（比如一直收并发数）。
 *
 * `run-suite.mjs` 给每条 driver 一个固定的 `PET_PORT`（8793 + slot），所以
 * `PET_PORT - 8793` 就是 slot，偏移到一段不会撞的端口区间即可。
 */
const SLOT = Math.max(0, PORT - 8793)
const CDP_PORT = 9433 + SLOT

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { spawn } = await import('node:child_process')
const browser = spawn(browserPath(), [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  BASE + '/',
], { stdio: 'ignore', detached: process.platform !== 'win32' })

const waitForCdp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口没就绪')
}

const socket = new WebSocket(await waitForCdp())
await new Promise((resolve) => socket.addEventListener('open', resolve))
let seq = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const cb = pending.get(message.id)
    if (cb) { pending.delete(message.id); cb(message) }
    return
  }
  events.push(message)
})
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params: params ?? {} }))
})
await send('Runtime.enable')
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, (message) => resolve(message.result?.result?.value))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
})

// 等假宿主把插件应用起来。
let applied = false
for (let i = 0; i < 60 && !applied; i += 1) {
  applied = (await evaluate('String(window.__pluginSections !== undefined && window.__pluginSections["pet-settings"] !== undefined)')) === 'true'
  if (!applied) await sleep(300)
}
check('设置那一节注册上了', applied)
if (!applied) {
  console.log('（后面的断言依赖它，直接收尾）')
} else {
  // **真的渲染它** —— 这一步就是本 driver 的全部意义。
  const rendered = await evaluate(`(() => {
    const section = window.__pluginSections['pet-settings'];
    let host = document.getElementById('dsh-settings-probe');
    if (host === null) { host = document.createElement('div'); host.id = 'dsh-settings-probe'; document.body.appendChild(host); }
    try {
      window.ReactDOM.createRoot(host).render(window.React.createElement(section.render));
      return 'ok';
    } catch (error) {
      return 'THREW: ' + String((error && error.stack) || error).slice(0, 400);
    }
  })()`)
  check('渲染调用没抛', rendered === 'ok', String(rendered).slice(0, 300))
  await sleep(1200)

  const cards = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-card]")].map((n) => n.getAttribute("data-card")))'))
  check('设置正文渲染出了卡片', cards.length >= 5, cards.join(','))

  const layerButtons = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-layer-options] button")].map((n) => n.textContent))'))
  check('「显示位置」那张卡有三个选项', layerButtons.length === 3, layerButtons.join('/'))

  // **观感也是契约**：那三个选项必须是"圆的、并排的、比正文小"。
  //
  // 这一条是补出来的 —— 加这张卡时漏了设置页作用域里 `[data-chips]` 的样式（在设置页里
  // 那套药丸样式挂在 `[data-reaction-set]` 下面），表现是三个选项**挤成一行字**，
  // 用户一眼就看出来了。数按钮个数抓不到这种问题，量样式才能。
  const chips = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#dsh-settings-probe [data-layer-options] button')].map((n) => {
    const style = getComputedStyle(n);
    const box = n.getBoundingClientRect();
    return { radius: style.borderRadius, w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top) };
  }))`))
  check('选项横排在同一行', chips.length === 3 && new Set(chips.map((c) => c.top)).size === 1,
    JSON.stringify(chips.map((c) => c.top)))
  check('选项是胶囊形状', chips.every((c) => c.radius === '999px'), JSON.stringify(chips.map((c) => c.radius)))
  check('选项紧凑（不是正文那么大）', chips.every((c) => c.w < 90 && c.h < 32),
    JSON.stringify(chips.map((c) => [c.w, c.h])))

  const flags = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#dsh-settings-probe [data-flag]")].map((n) => n.getAttribute("data-flag")))'))
  check('互动开关还在', flags.includes('patEnabled') && flags.includes('tailEnabled'), flags.join(','))
  const soundControls = JSON.parse(await evaluate(`JSON.stringify((() => {
    const card = document.querySelector('#dsh-settings-probe [data-card="sound"]');
    const phaseCard = document.querySelector('#dsh-settings-probe [data-card="phases"]');
    const toggle = card?.querySelector('[data-flag="soundEnabled"]');
    const volume = card?.querySelector('input[type="range"]');
    return { toggle: toggle?.checked, volume: volume?.value, min: volume?.min, max: volume?.max,
      hint: card?.querySelector('[data-card-head]')?.textContent ?? '',
      isolated: !phaseCard?.querySelector('[data-flag="soundEnabled"], input[type="range"]'),
      adjacent: card?.nextElementSibling === phaseCard };
  })())`))
  check('总提示音开关与音量独立成卡，紧挨会话相位', soundControls.toggle === false
    && soundControls.volume === '0.35' && soundControls.min === '0' && soundControls.max === '1'
    && soundControls.isolated && soundControls.adjacent,
  JSON.stringify(soundControls))
  check('音量卡的提示写明拖滑杆会试听', String(soundControls.hint).includes('试听'), String(soundControls.hint))
  // 拖音量滑杆会触发防抖试听（无头浏览器没有声卡，这里只验这条链不炸）：
  // 真正"按新音量发声"由 test-sound.mjs 用假音频设备断言。
  const volumeDrag = await evaluate(`(() => {
    const input = document.querySelector('#dsh-settings-probe [data-card="sound"] input[type="range"]');
    if (input === null) return 'no-slider';
    try {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '0.65');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    } catch (error) { return 'THREW: ' + String(error) }
  })()`)
  await sleep(400)
  const volumeAfterDrag = await evaluate(`document.querySelector('#dsh-settings-probe [data-card="sound"] input[type="range"]')?.value`)
  check('拖音量滑杆不抛异常且音量落到位', volumeDrag === 'ok' && volumeAfterDrag === '0.65',
    volumeDrag + ' / ' + volumeAfterDrag)
  // 相位来自异步宠物目录；等模型就绪后再读布局，不能用固定五秒当加载信号。
  const petReady = await waitReady(evaluate)
  check('相位默认值已加载', petReady)
  let overview = null
  for (let i = 0; i < 20; i += 1) {
    overview = JSON.parse(await evaluate(`JSON.stringify((() => {
      const rows = [...document.querySelectorAll('#dsh-settings-probe [data-card="phases"] [data-phase]')];
      return { count: rows.length, order: rows.map((row) => row.getAttribute('data-phase')),
        expanded: rows.filter((row) => row.hasAttribute('data-expanded')).length,
        twoColumns: rows.length > 1 && Math.abs(rows[0].getBoundingClientRect().top - rows[1].getBoundingClientRect().top) < 2 };
    })())`))
    if (overview.count === 8) break
    await sleep(250)
  }
  check('设置页八相位按工作流程成对排列、默认收起', overview.count === 8
    && overview.order?.join(',') === 'thinking,tool,waiting,asking,helper,queued,done,failed'
    && overview.expanded === 0 && overview.twoColumns, JSON.stringify(overview))
  await evaluate(`document.querySelector('#dsh-settings-probe [data-phase="done"] [data-phase-toggle="done"]')?.click()`)
  let phaseDetails = null
  for (let i = 0; i < 20; i += 1) {
    phaseDetails = JSON.parse(await evaluate(`JSON.stringify((() => {
      const phase = document.querySelector('#dsh-settings-probe [data-card="phases"] [data-phase="done"]');
      const line = phase?.querySelector('[data-line-input="phase:done"]');
      const sound = phase?.querySelector('[data-phase-sound="done"]');
      const soundControl = phase?.querySelector('[data-phase-sound-control]');
      return { line: Boolean(line), sound: sound?.textContent,
        chips: [...(phase?.querySelectorAll('[data-phase-chip]') ?? [])].map((el) => el.getAttribute('data-phase-chip')),
        sections: [...(phase?.querySelectorAll('[data-phase-section-title], [data-phase-motion-head]') ?? [])].map((el) => el.textContent),
        aligned: Boolean(line && soundControl && Math.abs(line.getBoundingClientRect().left - soundControl.getBoundingClientRect().left) < 3),
        bubblePhaseDuplicate: Boolean(document.querySelector('#dsh-settings-probe [data-card="bubble"] [data-line-input="phase:done"]')) };
    })())`))
    if (phaseDetails.line) break
    await sleep(250)
  }
  check('同一相位内有气泡台词和宠物提示音，气泡卡不重复', phaseDetails.line
    && phaseDetails.sound?.includes('660Hz') && !phaseDetails.bubblePhaseDuplicate,
  JSON.stringify(phaseDetails))
  check('相位概览展示动作/台词/音符，展开后按两块分组且输入对齐',
    phaseDetails.chips?.join(',') === 'motion,line,sound'
      && phaseDetails.sections?.[0] === '气泡与提示音'
      && phaseDetails.sections?.[1]?.startsWith('动作槽位') && phaseDetails.aligned,
    JSON.stringify(phaseDetails))
  // 「试听」：有宠物音符的相位必须点得动，而且**点它不能连带把静音勾选框点掉** ——
  // 它会读出声音（无头浏览器里没有声卡，只要求不抛异常），所以它当初就不该塞进
  // 那个 `<label>`（label 里的 button 点一下会把 label 的控件一起激活）。
  const previewProbe = JSON.parse(await evaluate(`JSON.stringify((() => {
    const phase = document.querySelector('#dsh-settings-probe [data-card="phases"] [data-phase="done"]');
    const button = phase?.querySelector('[data-phase-preview="done"]');
    const checkbox = phase?.querySelector('[data-phase-sound="done"] input[type="checkbox"]');
    const mutedBefore = checkbox?.checked === true;
    let clicked = false;
    try { button?.click(); clicked = true } catch { clicked = false }
    return { exists: Boolean(button), disabled: button?.disabled === true, clicked,
      mutedBefore, mutedAfter: checkbox?.checked === true };
  })())`))
  check('每相位有「试听」按钮：可点、点了不改静音状态、不抛异常',
    previewProbe.exists && previewProbe.disabled === false && previewProbe.clicked
      && previewProbe.mutedBefore === previewProbe.mutedAfter,
    JSON.stringify(previewProbe))
  if (phaseDetails.line) {
    const narrow = JSON.parse(await evaluate(`JSON.stringify((() => {
      const host = document.querySelector('#dsh-settings-probe');
      const prior = host.style.width;
      host.style.width = '300px';
      const phase = host.querySelector('[data-phase="done"]');
      const summary = [...phase.querySelectorAll('[data-phase-chip]')];
      const input = phase.querySelector('[data-line-input="phase:done"]');
      const notes = phase.querySelector('[data-phase-sound-control]');
      const upload = phase.querySelector('[data-phase-upload="done"]');
      const right = phase.getBoundingClientRect().right + 1;
      const result = { rows: new Set(summary.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        inputWidth: input.getBoundingClientRect().width,
        contained: [summary[2], input, notes, upload].every((el) => el.getBoundingClientRect().right <= right) };
      host.style.width = prior;
      return result;
    })())`))
    check('窄面板相位概览、台词和音符不溢出', narrow.rows >= 1
      && narrow.inputWidth >= 70 && narrow.contained, JSON.stringify(narrow))

    const checkbox = '#dsh-settings-probe [data-phase="done"] [data-phase-sound="done"] input[type="checkbox"]'
    const clickControl = async (selector) => {
      const point = JSON.parse(await evaluate(`JSON.stringify((() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        target.scrollIntoView({ block: 'center' });
        const rect = target.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })())`))
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
    }
    const sample = Buffer.alloc(46)
    sample.write('RIFF', 0); sample.writeUInt32LE(38, 4); sample.write('WAVEfmt ', 8)
    sample.writeUInt32LE(16, 16); sample.writeUInt16LE(1, 20); sample.writeUInt16LE(1, 22)
    sample.writeUInt32LE(8000, 24); sample.writeUInt32LE(16000, 28)
    sample.writeUInt16LE(2, 32); sample.writeUInt16LE(16, 34)
    sample.write('data', 36); sample.writeUInt32LE(2, 40)
    const fileInput = '#dsh-settings-probe [data-phase="done"] [data-upload-input="done"]'
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(fileInput)});
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not an audio file'], 'bad.wav', { type: 'audio/wav' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    let uploadError = ''
    for (let i = 0; i < 30 && !uploadError.includes('不受支持'); i += 1) {
      uploadError = await evaluate('document.querySelector("#dsh-settings-probe [data-upload-error=done]")?.textContent') ?? ''
      if (!uploadError.includes('不受支持')) await sleep(100)
    }
    check('错误音频被拒绝并在相位内说明原因', uploadError.includes('不受支持'), uploadError)
    const initiated = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(fileInput)});
      if (!input) return false;
      const raw = atob(${JSON.stringify(sample.toString('base64'))});
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'done.wav', { type: 'audio/wav' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    let uploaded = null
    for (let i = 0; i < 30 && !uploaded; i += 1) {
      const status = await (await fetch(BASE + '/api/live2d-pet/sound/ds-whale-girl')).json()
      uploaded = status.sounds?.done
      if (!uploaded) await sleep(100)
    }
    check('设置页能给当前宠物的 done 相位上传 WAV', initiated === true
      && uploaded?.mime === 'audio/wav' && uploaded.bytes === sample.length, JSON.stringify(uploaded))
    let uploadedSummary = ''
    for (let i = 0; i < 30 && !uploadedSummary.includes('已上传'); i += 1) {
      uploadedSummary = await evaluate('document.querySelector("#dsh-settings-probe [data-phase=done] [data-phase-chip=sound]")?.textContent') ?? ''
      if (!uploadedSummary.includes('已上传')) await sleep(100)
    }
    check('上传成功后相位概览即时显示已上传', uploadedSummary.includes('已上传'), String(uploadedSummary))
    if (uploadedSummary.includes('已上传')) await clickControl('#dsh-settings-probe [data-phase="done"] [data-upload-reset="done"]')
    else await fetch(BASE + '/api/live2d-pet/sound/ds-whale-girl/done', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }),
    })
    let removed = false
    for (let i = 0; i < 30 && !removed; i += 1) {
      const status = await (await fetch(BASE + '/api/live2d-pet/sound/ds-whale-girl')).json()
      removed = status.sounds?.done === undefined
      if (!removed) await sleep(100)
    }
    check('移除上传音频后恢复宠物音符', removed)
    await clickControl(checkbox)
    const muted = await evaluate(`String(document.querySelector(${JSON.stringify(checkbox)})?.checked === false)`)
    const muteSummary = await evaluate('document.querySelector("#dsh-settings-probe [data-phase=done] [data-phase-chip=sound]")?.textContent')
    check('单独静音 done 后相位概览立即显示已静音', muted === 'true'
      && muteSummary?.includes('已静音'), JSON.stringify({ muted, muteSummary }))
    let storedMute = false
    for (let i = 0; i < 20 && !storedMute; i += 1) {
      const shared = await (await fetch(BASE + '/api/live2d-pet/settings')).json()
      storedMute = Array.isArray(shared.overrides?.sounds?.done)
        && shared.overrides.sounds.done.length === 0
      if (!storedMute) await sleep(100)
    }
    check('单相位静音写进跨窗口共享设置', storedMute)
    await clickControl(checkbox)
    const restored = await evaluate(`String(document.querySelector(${JSON.stringify(checkbox)})?.checked === true)`)
    check('再次开启 done 恢复宠物默认音符', restored === 'true', String(restored))
    let storedRestore = false
    for (let i = 0; i < 20 && !storedRestore; i += 1) {
      const shared = await (await fetch(BASE + '/api/live2d-pet/settings')).json()
      storedRestore = shared.overrides?.sounds?.done === undefined
      if (!storedRestore) await sleep(100)
    }
    check('恢复宠物音符会从共享设置删掉覆盖', storedRestore)
    const line = '#dsh-settings-probe [data-phase="done"] [data-line-input="phase:done"]'
    const originalLine = await evaluate(`document.querySelector(${JSON.stringify(line)})?.value`)
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(line)});
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '会话台词测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await sleep(100)
    const reset = '#dsh-settings-probe [data-phase="done"] [data-phase-line-reset="done"]'
    const resetVisible = await evaluate(`String(document.querySelector(${JSON.stringify(reset)}) !== null)`)
    check('修改相位台词后提供恢复宠物默认的入口', resetVisible === 'true', String(resetVisible))
    if (resetVisible === 'true') {
      const customNarrow = JSON.parse(await evaluate(`JSON.stringify((() => {
        const host = document.querySelector('#dsh-settings-probe');
        const prior = host.style.width;
        host.style.width = '300px';
        const phase = host.querySelector('[data-phase="done"]');
        const input = host.querySelector(${JSON.stringify(line)}).getBoundingClientRect();
        const button = host.querySelector(${JSON.stringify(reset)}).getBoundingClientRect();
        const right = phase.getBoundingClientRect().right + 1;
        host.style.width = prior;
        return { inputWidth: input.width, contained: input.right <= right && button.right <= right };
      })())`))
      check('窄面板台词改动后恢复按钮不挤掉输入框', customNarrow.inputWidth >= 70
        && customNarrow.contained, JSON.stringify(customNarrow))
      await clickControl(reset)
      const returned = await evaluate(`document.querySelector(${JSON.stringify(line)})?.value`)
      check('恢复默认还原宠物台词', returned === originalLine,
        JSON.stringify({ returned, originalLine }))
      let lineRestored = false
      for (let i = 0; i < 20 && !lineRestored; i += 1) {
        const shared = await (await fetch(BASE + '/api/live2d-pet/settings')).json()
        lineRestored = shared.overrides?.lines?.phase?.done === undefined
        if (!lineRestored) await sleep(100)
      }
      check('恢复台词会从共享设置删掉覆盖', lineRestored)
    }
    const fold = '#dsh-settings-probe [data-phase="done"] [data-phase-toggle="done"]'
    await clickControl(fold)
    const collapsed = await evaluate(`String(document.querySelector(${JSON.stringify(fold)})?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('#dsh-settings-probe [data-phase="done"] [data-phase-details]') === null
      && document.querySelectorAll('#dsh-settings-probe [data-phase="done"] [data-phase-chip]').length === 3)`)
    check('收起相位仍显示三类状态概览', collapsed === 'true', String(collapsed))
    await clickControl(fold)
    const expanded = await evaluate(`String(document.querySelector(${JSON.stringify(fold)})?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('#dsh-settings-probe [data-phase="done"] [data-phase-details]') !== null)`)
    check('展开相位仍能编辑台词和音符', expanded === 'true', String(expanded))
  }

  // 页面侧**没有未捕获异常** —— "整节崩掉"必然在这里留下痕迹。
  const errors = JSON.parse(await evaluate('JSON.stringify(window.__errors ?? [])'))
  check('页面里没有未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 300))

  // 顺带把显示层状态读口确认一遍（它是新加的，且设置页要用它）。
  const layerState = await evaluate('String(document.querySelector("#dsh-settings-probe [data-layer-status]")?.textContent ?? "(没有)")')
  check('显示层状态行渲染出来了', typeof layerState === 'string' && layerState !== '(没有)', String(layerState).slice(0, 120))

  // **缺二进制时必须有"能点的下一步"**。
  //
  // 这条是用户报出来的：他在设置里点了「桌面」，**什么都没发生**。原因是 exe 还没构建，
  // 插件拉起失败 —— 但它只在状态行留了半句话（"桌面端二进制不在"），没有动作可做，
  // 点之前点之后长得一样。所以断言"按钮在、且带下载标记"，而不是只断言卡片渲染出来了。
  const needsBinary = String(layerState).includes('二进制不在')
  if (needsBinary) {
    const download = await evaluate('String(document.querySelector("#dsh-settings-probe [data-layer-download]")?.textContent ?? "(没有)")')
    check('缺二进制时给出「下载桌面端」按钮（否则用户只能盯着看）',
      typeof download === 'string' && download.includes('下载'), String(download))
  } else {
    console.log('  （这台机器上二进制已在，跳过"下载按钮"那条）')
  }
}

socket.close()
killBrowser(browser)

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('SETTINGS-RENDER ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' ' + (results.length - failed.length) + '/' + results.length + '（端口 ' + PORT + '，harness ' + HERE + '）')
process.exit(failed.length === 0 ? 0 : 1)
