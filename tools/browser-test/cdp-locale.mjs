// 语言来源回归：宠物文案跟着 `navigator.language` 走，**不跟 `<html lang>` 走**。
//
// 为什么值得一条独立 driver：DSH 的网页入口写死 `<html lang="en">`，桌面端宠物页写死
// `<html lang="zh">`。客户端如果读 `documentElement.lang`，结果就是网页端的中文用户
// 看到英文、桌面端的英文用户永远看不到英文（PR #14 review 在真机上实测过）。
//
// 这条用 Chromium 的 `--accept-lang` 改 `navigator.language`，真的走一遍：
//
//   en-US → 英文（覆盖层生效）
//   zh-CN → 中文（清单原文）
//
// 两个用例还分别把 `<html lang>` 设成**另一个宿主写死的值**（en 用例配 zh、zh 用例配
// en），证明客户端确实不看它；这样以后谁把来源改回 `documentElement.lang || …`，
// 这条就会红，而不是像"两边都不设 lang"那样恰好也绿。
//
// ⚠️ 两个坑：`Emulation.setLocaleOverride` 只改 `Intl` 的 locale，**不改**
// `navigator.language`（实测 navigator.language 仍是 en-US），别拿它测这条路径；
// `--accept-lang` 是进程启动参数，改语言要换进程，所以每个用例单独起一个浏览器。
//
// 顺手断言身份字段不变：`data-slot-option` 仍是清单原文（选项标签是身份，不是显示）。
//
//   node cdp-locale.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from './paths.mjs'
import { killBrowser, openPanel, pageErrors, waitReady } from './ready.mjs'
import { waitForBoot } from './wait-for.mjs'

const EDGE = browserPath()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === '' ? '' : '  ← ' + detail))
  if (!ok) failures.push(label)
}

/** 在独立浏览器里加载一个用例：可指定 locale override 与测试钩子 URL。 */
async function runCase(name, acceptLanguage, url) {
  const port = 9461 + ['en', 'zh', 'hook'].indexOf(name)
  const profile = join(PROFILES, '_cdp-locale-' + name)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  // detached：让 killBrowser 的进程组 kill 真的有组可杀（POSIX 上 -pid 才成立）。
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port, '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader', '--accept-lang=' + acceptLanguage, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + profile, '--window-size=1280,860', 'about:blank'],
  { stdio: 'ignore', detached: true })
  let ws = null
  try {
    let page
    for (let i = 0; i < 120 && page === undefined; i += 1) {
      try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page') } catch { /* retry */ }
      if (page === undefined) await sleep(250)
    }
    if (page === undefined) throw new Error('拿不到 CDP 页面')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let nextId = 0
    const pending = new Map()
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) } } }
    const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
    const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.navigate', { url })
    // 等导航提交（旧页面的 title 也是 done，不能只看 title）。
    for (let i = 0; i < 200; i += 1) {
      const href = await ev('location.href')
      if (href === url) break
      await sleep(50)
    }
    const booted = await waitForBoot(ev)
    const ready = booted ? await waitReady(ev) : false
    const localeNow = await ev('window.__dshLive2dPet && window.__dshLive2dPet.locale && window.__dshLive2dPet.locale()')
    const htmlLang = await ev('document.documentElement.lang')
    const greet = await ev('JSON.stringify(window.__dshLive2dPet.effectiveLines().greet)')
    // 面板默认停在「动作」页，切到「装扮」才看得到槽位（tab 文案是插件 UI，PR2 才翻）。
    await openPanel(ev)
    await sleep(250)
    await ev('(() => { const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-tabs] button"));'
      + ' const b = bs.find((x) => /^(装扮|Outfit)/.test(x.textContent)); if (b) b.click(); return !!b })()')
    await sleep(250)
    const read = await ev('(() => {'
      + ' const group = document.querySelector("[data-dsh-live2d-pet] [data-panel] [data-slot=\\"glasses\\"]");'
      + ' if (!group) return null;'
      + ' const title = group.querySelector("span");'
      + ' const option = group.querySelector("button[data-slot-option=\\"圆眼镜\\"]");'
      + ' return JSON.stringify({ slot: title ? title.textContent : null,'
      + '   option: option ? option.textContent : null, identity: option ? option.getAttribute("data-slot-option") : null }); })()')
    const errors = await pageErrors(ev)
    const parsed = read === null || read === undefined ? null : JSON.parse(read)
    return { booted, ready, localeNow, htmlLang, greet: JSON.parse(greet ?? 'null'), errors, ...(parsed ?? {}) }
  } finally {
    try { ws?.close() } catch { /* closed */ }
    killBrowser(edge)
  }
}

const en = await runCase('en', 'en-US', BASE + '/?hook=off&htmlLang=zh')
check(en.booted === true && en.ready === true, '页面在 en-US 下就绪', JSON.stringify({ booted: en.booted, ready: en.ready }))
check(en.localeNow === 'en', 'navigator.language=en-US → en', String(en.localeNow))
check(en.htmlLang === 'zh', '夹具确实把 <html lang> 设成宿主的 zh（桌面端）', String(en.htmlLang))
check(en.option === 'Round glasses', '宿主的 lang=zh 不影响英文判定', String(en.option))
check(en.option === 'Round glasses', '装扮选项按钮显示英文', String(en.option))
check(en.slot === 'Glasses', '槽位标题显示英文', String(en.slot))
check(en.identity === '圆眼镜', 'data-slot-option 仍是清单原文（身份不变）', String(en.identity))
check(Array.isArray(en.greet) && en.greet[0] === "Hi there! I'm the whale girl~", '台词使用英文覆盖层', JSON.stringify(en.greet))

const zh = await runCase('zh', 'zh-CN', BASE + '/?hook=off&htmlLang=en')
check(zh.localeNow === 'zh', 'navigator.language=zh-CN → 中文', String(zh.localeNow))
check(zh.htmlLang === 'en', '夹具确实把 <html lang> 设成宿主的 en（网页端）', String(zh.htmlLang))
check(zh.option === '圆眼镜', '宿主的 lang=en 不影响中文判定', String(zh.option))
check(zh.option === '圆眼镜', '中文界面里选项按钮仍是中文', String(zh.option))
check(zh.slot === '眼镜', '中文界面里槽位标题仍是中文', String(zh.slot))
check(Array.isArray(zh.greet) && String(zh.greet[0]).indexOf('你好') === 0, '中文台词', JSON.stringify(zh.greet))

// 钩子路径：页面在模块求值前写 window.__petLocale，必须优先于 navigator.language。
const hooked = await runCase('hook', 'zh-CN', BASE + '/?lang=en&htmlLang=zh')
check(hooked.localeNow === 'en', 'window.__petLocale 钩子优先于 navigator.language', String(hooked.localeNow))
check(hooked.option === 'Round glasses', '钩子路径也走英文显示', String(hooked.option))

const errors = [...(en.errors ?? []), ...(zh.errors ?? []), ...(hooked.errors ?? [])]
check(errors.length === 0, '页面没有未捕获异常', JSON.stringify(errors).slice(0, 200))

console.log('')
if (failures.length > 0) { console.log('LOCALE FAIL —— ' + JSON.stringify(failures)); process.exit(1) }
console.log('LOCALE OK —— 语言来源是 navigator.language（zh 原样 / 其它语言用宠物覆盖层），身份字段不变')
