// 两节界面**真的渲染得出来**吗 —— 纯 node 版本（不需要浏览器）。
//
// 为什么要有它：`cdp-settings-render.mjs` / `cdp-plugin-page.mjs` 是真的渲染，但它们要无头
// 浏览器；而**DSH 会话的沙箱里起不了无头浏览器**（Mojo 命名管道被拦，见 browser-cdp skill）。
// 于是那两条 driver 在会话里跑不了，而"渲染这一节会不会当场抛"这种事又必须有人盯着 ——
// 这个文件用 `react-dom/server` 把两节各渲染一次，把**结构性**的那一半钉死在纯 node 里：
//
//   * 组件树渲染不抛（这是 `layerRef is not defined` 那类"宠物正常、只有那一节崩"的形态）；
//   * 卡片的**集合**与控件的**集合**（防止有人把设置页整份搬到插件页、或漏挂一个开关）；
//   * 两处「恢复默认」的措辞不同（插件页只挑了四项，按钮得说"全部"）。
//
// 它**不验**布局/样式/点击（那些归两条 CDP driver）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import react from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PLUGIN } from './paths.mjs'

const store = new Map()
const noop = () => {}
const window = {
  location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  addEventListener: noop,
  removeEventListener: noop,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  // 拿注册用的假槽位系统：`register` 的身份是 `key ?? id`（list 槽用 id，keyed 槽用包名）。
  __ModuleLoader__: {
    load: ({ factory }) => {
      window.plugin = factory((id) => id === 'react'
        ? react
        : { createRoot: () => ({ render: noop }) })
    },
  },
}
const document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute: noop, appendChild: noop }),
  head: { appendChild: noop },
  body: { appendChild: noop },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
}

const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
const seam = '  exports.apply = apply;'
assert.equal(source.split(seam).length, 2, '客户端测试入口只能有一处')
runInNewContext(source.replace(seam, `  exports.testPage = { applyPluginPage, applySettings, PetSettingsSection, PetPluginConfig };\n${seam}`), {
  window,
  document,
  console,
  Map,
  Set,
  fetch: () => Promise.resolve({ status: 404 }),
})

const captured = {}
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, callback) => callback(),
    register: (meta, render) => {
      captured[meta.key ?? meta.id] = render
      return meta.key ?? meta.id
    },
  },
}
const page = window.plugin.testPage
// 注册身份就是**组合包的包名** —— 页面按它派发，写错就整节不渲染（不是抛错）。
page.applyPluginPage(ctx)
page.applySettings(ctx)
assert.equal(typeof captured['dsh-pet-live2d'], 'function', '插件页那一节按包名注册上了')
assert.equal(typeof captured['pet-settings'], 'function', '设置页那一节还挂在 pet-settings 上')

const pluginPage = renderToStaticMarkup(react.createElement(captured['dsh-pet-live2d']))
const settings = renderToStaticMarkup(react.createElement(captured['pet-settings']))
const attrsOf = (html, name) => [...html.matchAll(new RegExp(name + '="([^"]+)"', 'g'))].map((m) => m[1])

// ---- 插件页那一节 ------------------------------------------------------------
assert.ok(pluginPage.includes('data-pet-plugin-page'), '插件页那一节有话事属性')
assert.ok(pluginPage.includes('data-pet-settings'), '复用设置正文的样式作用域')
assert.deepEqual(attrsOf(pluginPage, 'data-card'), ['plugin-flags', 'plugin-tuning', 'plugin-layer'],
  '三张卡：常用开关 / 手感 / 显示位置')
assert.deepEqual(attrsOf(pluginPage, 'data-flag'),
  ['bubbleEnabled', 'soundEnabled', 'patEnabled', 'tailEnabled', 'spinEnabled', 'outfitArchive'],
  '六个常用开关')
assert.deepEqual(attrsOf(pluginPage, 'data-input'),
  ['gazeRangePx', 'gazeWatchingRatio', 'fidgetQuietMs', 'soundVolume'],
  '只挑四根滑杆（不是把设置页整份搬过来）')
assert.equal(attrsOf(pluginPage, 'data-layer-mode').length, 3, '显示位置三个选项')
assert.ok(pluginPage.includes('当前宠物') && pluginPage.includes('显示位置'), '状态行说了"她在哪"')
assert.ok(pluginPage.includes('设置 → 桌宠'), '末行指向完整设置那一处')
assert.ok(pluginPage.includes('全部恢复默认'), '只挑了四项时按钮说"全部"')

// ---- 设置正文（同一份 store 的另一个入口，改 `settingsCard` / `TuningControls` 的回归网）----
const settingCards = attrsOf(settings, 'data-card')
for (const key of ['sound', 'phases', 'pools', 'outfit', 'interact', 'bubble']) {
  assert.ok(settingCards.includes(key), '设置正文还有「' + key + '」这张卡')
}
assert.ok(attrsOf(settings, 'data-input').length >= 16,
  '设置正文仍然是整份滑杆（' + attrsOf(settings, 'data-input').length + ' 根）')
assert.ok(settings.includes('恢复默认'), '设置正文里那个按钮仍然是「恢复默认」')

console.log('OK  插件页那一节与设置正文都渲染得出来（结构断言 ' + (6 + attrsOf(settings, 'data-input').length) + ' 项）')
console.log('PLUGIN-PAGE-NODE OK')
