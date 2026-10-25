// 对白布局用真实 DOM 尺寸、头部几何与命中测试验证，截图只供人工看样式。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, BASE, PROFILES, SHOTS } from './paths.mjs'
import { waitReady, killBrowser, pageErrors } from './ready.mjs'

const port = 9427
const profile = join(PROFILES, '_cdp-speech-' + process.pid)
mkdirSync(profile, { recursive: true })
const browser = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=' + port,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
  '--no-default-browser-check', '--user-data-dir=' + profile, '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws
try {
  let page
  for (let i = 0; i < 120 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.type === 'page') } catch {}
    if (!page) await sleep(100)
  }
  assert.ok(page, '浏览器 CDP 已就绪')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const send = (method, params = {}) => new Promise(resolve => {
    const next = ++id; pending.set(next, resolve); ws.send(JSON.stringify({ id: next, method, params }))
  })
  const ev = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!result.result?.exceptionDetails, JSON.stringify(result.result?.exceptionDetails))
    return result.result?.result?.value
  }
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  assert.equal(await waitReady(ev), true, '模型与点击遮罩已就绪')
  const read = () => ev(`(() => {
    const el = document.querySelector('[data-bubble][data-placed]'); if (!el) return null;
    const b = el.getBoundingClientRect(), root = el.parentElement.getBoundingClientRect();
    const css = getComputedStyle(el), tail = getComputedStyle(el, '::after');
    return { text: el.textContent, x: b.x, y: b.y, right: b.right, bottom: b.bottom,
      rootTop: root.top, side: el.dataset.side, width: b.width,
      viewport: [innerWidth, innerHeight], targetX: parseFloat(el.style.left), targetY: parseFloat(el.style.top), font: css.fontSize, border: css.borderTopWidth,
      pointer: css.pointerEvents, tail: tail.content, role: el.getAttribute('role'),
      hitBubble: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el };
  })()`)
  const settled = async () => {
    for (let i = 0; i < 80; i++) {
      const b = await read();
      if (b && Math.abs(b.x - b.targetX) < 1 && Math.abs(b.y - b.targetY) < 1) return b;
      await sleep(25);
    }
    assert.fail('对白缓动未到达目标位置');
  };
  const phase = async name => {
    await ev('window.__dshLive2dPet.phaseNow(' + JSON.stringify(name) + ')')
    const line = await ev('window.__dshLive2dPet.effectiveLines().phase[' + JSON.stringify(name) + ']')
    for (let i = 0; i < 80; i++) {
      const b = await read()
      if (b?.text === line) return b
      await sleep(50)
    }
    assert.fail('相位台词未显示：' + name)
  }
  const inside = b => {
    assert.ok(b.x >= 11 && b.y >= 11 && b.right <= b.viewport[0] - 11 && b.bottom <= b.viewport[1] - 11,
      '气泡留在视口内：' + JSON.stringify(b))
    assert.equal(b.pointer, 'none', '对白不拦截鼠标')
    assert.equal(b.hitBubble, false, '气泡中央命中穿透')
  }
  const first = await phase('thinking')
  inside(first)
  // 确定性几何：气泡矩形内不出现角色的不透明像素（压住头发也算失败）。
  const overlap = JSON.parse(await ev(`(() => {
    const root = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect();
    const bubble = document.querySelector('[data-dsh-live2d-pet] [data-bubble]').getBoundingClientRect();
    let hit = 0, total = 0;
    for (let iy = 0; iy < 5; iy++) for (let ix = 0; ix < 7; ix++) {
      const x = bubble.left + 4 + (bubble.width - 8) * ix / 6;
      const y = bubble.top + 4 + (bubble.height - 8) * iy / 4;
      total++;
      if (window.__dshLive2dPet.hitsMask(x - root.left, y - root.top, root.width, root.height)) hit++;
    }
    return JSON.stringify({ hit, total });
  })()`))
  assert.equal(overlap.hit, 0, '气泡矩形压到角色像素：' + JSON.stringify(overlap))
  console.log('PASS 气泡不压角色（' + overlap.total + ' 个采样点）')
  assert.equal(first.font, '14px')
  assert.ok(parseFloat(first.border) >= 1 && parseFloat(first.border) <= 1.5)
  assert.equal(first.role, 'status')
  assert.equal(first.tail, '""', '尾巴伪元素存在')
  assert.ok(first.bottom > first.rootTop + 10, '对白靠近头部，进入画布透明留白')
  console.log('PASS 相位台词、漫画描边、尾巴、头部位置和鼠标穿透')
  const clip = await ev(`(() => {
    const r = document.querySelector('[data-dsh-live2d-pet]').getBoundingClientRect();
    const x = Math.max(0, r.left - 150), y = Math.max(0, r.top - 90);
    return { x, y, width: Math.min(innerWidth - x, r.width + 180), height: Math.min(innerHeight - y, r.height + 110), scale: 1 };
  })()`)
  writeFileSync(join(SHOTS, 'speech-comic.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip })).result.data, 'base64'))
  for (const [label, right, bottom, expected] of [['左边缘', '950px', '0px', 'right'], ['右上角', '0px', '650px', 'left']]) {
    await ev(`(() => { const root = document.querySelector('[data-dsh-live2d-pet]'); root.style.right = '${right}'; root.style.bottom = '${bottom}'; dispatchEvent(new Event('resize')); })()`)
    const b = await settled(); inside(b); assert.equal(b.side, expected)
    console.log('PASS ' + label + '自动换边与边界避让')
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false })
  await ev(`(() => { const root = document.querySelector('[data-dsh-live2d-pet]'); root.style.right = '0px'; root.style.bottom = '0px'; dispatchEvent(new Event('resize')); })()`)
  await phase('done'); inside(await settled())
  // 让位的那一份不许画气泡：只藏根节点时，fixed 气泡会自己 visible（实测 root hidden、
  // bubble visible）。这里把 owner 改成 desktop（写心跳），页面这份应立刻让位且不挂气泡。
  const layerHome = join(PROFILES, '_layer-home-' + (process.env.PET_PORT ?? '8793'))
  mkdirSync(layerHome, { recursive: true })
  writeFileSync(join(layerHome, 'pet-desktop.json'), JSON.stringify({
    mode: 'desktop', desktopPid: 999999, at: Date.now() + 3600000,
  }))
  let yielded = null
  for (let i = 0; i < 60; i += 1) {
    const raw = await ev(`(() => { const r = document.querySelector('[data-dsh-live2d-pet]');
      if (r === null) return null; return JSON.stringify({ layer: r.dataset.layer, vis: getComputedStyle(r).visibility }) })()`)
    yielded = raw === null ? null : JSON.parse(raw)
    if (yielded !== null && yielded.layer === 'desktop' && yielded.vis === 'hidden') break
    await sleep(100)
  }
  assert.ok(yielded !== null && yielded.vis === 'hidden', '页面这份应让位：' + JSON.stringify(yielded))
  await ev('window.__dshLive2dPet.phaseNow("thinking")')
  await sleep(1200)
  const ghost = await ev(`(() => { const el = document.querySelector('[data-dsh-live2d-pet] [data-bubble]');
    if (el === null) return 'absent'; return getComputedStyle(el).visibility })()`)
  assert.ok(ghost === 'absent' || ghost === 'hidden', '让位后不该出现可见气泡：' + ghost)
  console.log('PASS 让位的那一份不画气泡（' + ghost + '）')
  assert.deepEqual(await pageErrors(ev), [], '页面无异常')
  console.log('PASS 窄视口重新布局、切换台词、页面无异常')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  ws?.close()
  killBrowser(browser)
}
