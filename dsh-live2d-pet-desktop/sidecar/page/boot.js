// 桌面端启动：等插件浏览器半区注册好，用最小 ctx 应用它，然后把状态挂出来。
//
// 这一段和 tools/browser-test/harness.js 是同一个套路（那套 harness 已经用 19 个
// driver 跑通过），差别只有一个：桌面端不建"假设置页宿主"，`slots` 直接不给。
//
// runtime.js 是 index.html 里的普通 <script>，已经先跑过了（它建 window.__petDesktop）。
const started = Date.now()

async function waitForExports(timeoutMs) {
  while (Date.now() - started < timeoutMs) {
    const table = window.__pluginExports
    if (table !== undefined && table['dsh-pet-live2d'] !== undefined) return table['dsh-pet-live2d']
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

async function main() {
  const plugin = await waitForExports(15000)
  if (plugin === undefined) {
    throw new Error('插件浏览器半区没有注册：' + (window.__bootError ?? '未知原因'))
  }
  const desktop = window.__petDesktop
  try {
    plugin.apply(window.__petCtx())
    desktop.diagApplied = true
  } catch (error) {
    desktop.diagError = String((error && error.stack) || error)
    throw error
  }
  // 主进程的读口：driver 从这里断言"插件真的挂上了"。
  window.__desktopBoot = {
    ok: true,
    applied: true,
    ms: Date.now() - started,
    canvas: () => document.querySelector('[data-dsh-live2d-pet] canvas') !== null,
  }
}

main().catch((error) => {
  window.__desktopBoot = { ok: false, error: String((error && error.stack) || error) }
  console.error('[desktop] 启动失败', error)
})
