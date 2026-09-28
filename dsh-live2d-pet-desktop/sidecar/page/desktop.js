// 桌面端与 sidecar 之间那条**反向**通道：页面来领探针任务。
//
// 为什么是这个方向：壳没法直接问页面（窗口忽略光标事件之后页面收不到鼠标移动，而
// Tauri 对远程源又默认拒绝自定义命令），所以壳只能问 sidecar；可判定逻辑偏偏只存在
// 于页面的渲染进程里。于是中间这一步只能由**页面主动去领**：
//
//     壳 --POST /probe--> sidecar（把任务挂起来）<--GET /probe/pending-- 页面
//     壳 <--响应---------- sidecar <--POST /probe/answer-- 页面（带上判定结果）
//
// 代价是每个任务多一趟往返（本机回环，实测远小于一帧）。好处是**页面不需要任何权限**：
// 它只是对同源服务器发两个普通 fetch，和它取资产用的是同一条路。
//
// 节奏：没有任务时 20ms 一次（50 次/秒的空轮询），有任务在等时 0——响应回来立刻领下一个。
// 空轮询的成本在本机回环上是噪声级别，换来的是"不需要 shell 与页面之间那条 IPC"。
(function () {
  const PENDING_URL = '/__desktop/probe/pending'
  const ANSWER_URL = '/__desktop/probe/answer'
  const CURSOR_URL = '/__desktop/cursor'
  const COMMANDS_URL = '/__desktop/commands'
  const IDLE_MS = 20
  let inflight = false
  let rounds = 0
  let errors = 0
  let lastAt = 0

  const stat = {
    get rounds() { return rounds },
    get errors() { return errors },
    get lastAt() { return lastAt },
  }
  Object.defineProperty(window, '__petDesktopLink', { value: stat, configurable: true })

  async function loop() {
    if (inflight) return
    inflight = true
    let wait = IDLE_MS
    try {
      // **托盘菜单进来的命令**（设置 / 归位 / …）。
      //
      // 走 HTTP 而不是 Tauri 的 `window.emit()`：那个**不发 DOM 事件**、只走 IPC，而外部
      // 页面没有 `window.__TAURI__`（`withGlobalTauri: false`）—— 页面里
      // `addEventListener("pet://settings")` 永远收不到东西，菜单项于是"点了没效果"。
      try {
        const queued = await fetch(COMMANDS_URL, { cache: 'no-store' }).then((r) => r.json())
        if (queued && Array.isArray(queued.commands) && queued.commands.length > 0
          && typeof window.__petCommand === 'function') {
          for (const command of queued.commands) window.__petCommand(command)
        }
      } catch {
        /* 读不到就算了：命令是"锦上添花"，不该拖垮判定循环 */
      }
      // **先问全局光标**（每轮都问，跟有没有判定任务无关）。
      //
      // 为什么必须由壳喂：`pointermove` 只在指针落在这个窗口上时才由浏览器送来，所以用户
      // 一操作别的程序，页面就**一个事件都收不到** —— 唯一的症状就是"只有焦点在宠物上才有
      // 跟随"。壳每 33ms 本来就在读全局光标（穿透判定要用），这份数据现成的。
      try {
        const cursor = await fetch(CURSOR_URL, { cache: 'no-store' }).then((r) => r.json())
        if (cursor && cursor.ok === true && typeof window.__petPointer === 'function') {
          window.__petPointer(cursor.x, cursor.y)
        }
      } catch {
        /* 读不到就不喂：跟随退回 DOM 事件那条路 */
      }
      const pending = await fetch(PENDING_URL, { cache: 'no-store' }).then((r) => r.json())
      if (pending && pending.ok === true && pending.seq !== undefined) {
        lastAt = Date.now()
        const verdict = typeof window.__petDesktopProbe === 'function'
          ? window.__petDesktopProbe({ x: pending.x, y: pending.y, screenX: pending.screenX, screenY: pending.screenY })
          : { interactive: false, reason: 'page-runtime-missing' }
        await fetch(ANSWER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            seq: pending.seq,
            interactive: verdict?.interactive === true,
            reason: verdict?.reason ?? '',
          }),
        }).then((r) => r.json())
        rounds += 1
        // 刚干完活：立刻再领一次，别白等一个间隔。
        wait = 0
      }
    } catch {
      errors += 1
      wait = 200
    } finally {
      inflight = false
      setTimeout(loop, wait)
    }
  }

  setTimeout(loop, 50)
})()
