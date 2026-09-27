---
name: desktop-shell
description: >
  桌面端（Tauri 壳 + Node sidecar）的架构取舍、透明窗与逐像素穿透在 Windows 上的实测结论、
  不要用 Tauri IPC 的原因，以及怎么用 CDP + SetCursorPos + 窗口扩展样式验证"穿透"。
whenToUse: >
  改 dsh-live2d-pet-desktop/ 的壳、页面运行时或 sidecar 时；要在桌面上验透明/穿透/窗口行为时；
  准备给桌面端打包（M4）之前回顾已有结论时。
---

# 桌面端外壳

## 一句话架构

**壳（Tauri）只管窗口，sidecar（Node）管宠物，页面管渲染与判定。** 壳与 sidecar 之间
只有一条握手协议（sidecar 启动时 stdout 上的 `PET_SIDECAR {...}` 行），运行期只走两个
HTTP：壳 POST `/__desktop/probe` 问判定，页面 GET 插件自己的 `/api/live2d-pet/*`。

**页面与壳之间没有任何 IPC**，这是刻意设计的（原因见下面"不要用 Tauri IPC"）。

| 层 | 复用 | 为什么 |
|---|---|---|
| 宠物逻辑 | `dsh-live2d-pet/lib/index.js` **零改动** | 宠物发现 / `pet.json` 解析 / 模型引用闭包白名单是修过 bug、有回归测试的逻辑；翻成 Rust 就是第二份实现 |
| 渲染与互动 | `dsh-live2d-pet/lib/client.js` **零改动** | 网页端那 19 个 driver 因此仍然是桌面端的回归网 |
| 数据搬运 | `sidecar/server.mjs` | 起回环端口、挂插件真路由表、发页面、转发穿透判定 |

## 为什么是"全屏透明层"而不是一个小窗口

右键面板宽 **270px**、`right: calc(100% + 10px)` 锚在角色左侧；气泡悬在头顶。一个
300×300 的小窗会把它们裁掉。全屏层里布局与网页端**完全一致**，`client.js` 一格都不用
改。代价是穿透判定必须对——所以**窗口创建时就是"忽略光标事件"**，判定跑起来才打开：
失败时默认"不挡桌面"，而不是"挡住桌面"。

窗口参数（2026-09 实测通过）：`decorations:false` + `transparent:true` +
`always_on_top:true` + `skip_taskbar:true` + `shadow:false`，尺寸取 `work_area`
（不含任务栏，否则宠物会被任务栏盖住点不到），位置取工作区左上角。
窗口的扩展样式是 `0xC0138`：`WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_APPWINDOW`。

## Windows 上最硬的一条：穿透的坐标只能由壳给

`set_ignore_cursor_events(true)` 之后，Windows 把命中测试交给下层窗口，**页面收不到
鼠标移动**。于是"该不该忽略"这个判断本身成了鸡生蛋问题：

- Electron 有 `setIgnoreMouseEvents(true, { forward: true })`：它自己把移动消息额外喂给
  渲染进程，所以那边可以"听 pointermove → 判定 → 回传"。
- **Tauri 没有这个开关**（`set_ignore_cursor_events` 只有布尔值）。所以方向只能反过来：
  壳用 `GetCursorPos` 轮询（33ms）→ 把窗口客户区坐标发给 sidecar → 页面判定 → 壳据此切
  忽略状态。

坐标换算：`local = (screen - window_outer_position) / window.scale_factor()`。WebView2 的
CSS 像素就是逻辑像素，所以除以 DPI 比例即可。实测窗口原点 (0,0)、scale 1.0 时
`cursor == cursorLocal`，一一对上。

## 页面的判定要由**页面主动来领**，不能等 sidecar 去调

判定逻辑（`elementFromPoint` 看气泡/面板，命中遮罩看剪影）只存在于渲染进程；而壳只能
HTTP 问 sidecar。两边接不上，所以中间这一步由页面自己发起：

```
壳 --POST /__desktop/probe---------------> sidecar（把任务挂起来，**响应挂着不结束**）
                                          <--GET  /__desktop/probe/pending-- 页面（每 20ms 领一次）
                                          <--POST /__desktop/probe/answer--- 页面（算完就回）
壳 <--------200 {interactive, reason}------- sidecar（页面答完 / 2.5s 超时）
```

**踩过的坑（假红第一名）**：第一版是"能答就答、答不了立刻回 `pending` 占位"。看着合理，
但页面领到任务要 10–20ms，而壳每 33ms 来一次——于是壳的**每一次**请求都落在"还没答"的
窗口里，永远读到 `pending`、永远判 false，症状是"判定完全没生效"。**要等，不要回占位符。**

排查顺序（这次的顺序，省时间）：先确认页面里 `probe(x,y)` 本身对不对（CDP 直接算一遍），
再确认 `answered` 计数在涨（sidecar 的 `/__desktop/ping`），最后才怀疑壳。这次就是先看到
`lastReason:"pending"` 才定位到"回得太早"。

## 不要用 Tauri IPC（对 loopback 页面）

页面是从 `http://127.0.0.1:<port>/` 加载的，属于**远程源**：Tauri v2 默认拒绝自定义命令
（实测 `shell_state not allowed. Plugin not found`）。要走通得开远程 IPC 权限——那正好和
"发布版别留后门"相反。两条替代路：

- **壳 → 页面**：不需要。
- **页面/驱动 → 壳**：壳每 33ms 把状态写进 `.run/shell-state.json`（临时文件 + `rename`
  原子替换），sidecar 读出来挂成 `GET /__desktop/shell`。

换来的是"换壳"这件事继续成立：谁能写一个 JSON、谁能发一个 HTTP，谁就能当壳。

## 验证"穿透"：只有真动光标 + 读窗口扩展样式才算验过

`tools/desktop-driver.mjs`（全链）+ `tools/probe-through.ps1`（铁证）的分工：

1. 从 WebView2 的 CDP 端口接管页面。壳要带 `PET_DESKTOP_CDP=<port>` 才开调试端口，
   **默认关着**（发布版不该在本机留一个谁都能接管的端口）。
2. `PowerShell Add-Type` + `SetCursorPos` **真的挪系统光标**。不挪光标就是假验证——
   判定链根本不会动。
3. 读**窗口的扩展样式**：`WS_EX_TRANSPARENT`(0x20) 是操作系统做命中测试时看的那一位，
   壳里的 `ignored` 只是我们的**意图**。实测（气球页）：

   | 位置 | exStyle | WS_EX_TRANSPARENT | WS_EX_LAYERED | WindowFromPoint |
   |---|---|---|---|---|
   | 空白 | `0xC0138` | ✔ | ✔ | 下层别的进程 |
   | 实心 | `0x40118` | ✘ | ✘ | 下层别的进程（此刻我们不是 topmost 候选） |

   注意 Tauri 是通过**同时增删 `WS_EX_TRANSPARENT` 与 `WS_EX_LAYERED`** 来切这个状态的，
   所以断言要看 `WS_EX_TRANSPARENT` 这一位，不要拿整个 exStyle 去比。
4. 每步读壳的 `shell_state`（`cursorLocal` / `interactive` / `ignored` / `probes` /
   `changes` / `probeErrors`），把"判定 → 忽略状态"这条链对到底；`changes` 只在**跨越
   边界**时涨，静止 1.2 秒不涨就是"没抖"。
5. 退出码收尾（0/1/2），不允许只打印不断言。

轮询要轮询**期望值**（等 `interactive === true`），不要轮询"稳定"（主仓库
`docs-and-workflow` skill 里为此假红过）。

## 页面侧的垫片（照抄 tools/browser-test 那套）

桌面端没有 DSH 的模块表，所以页面要自己给：

- `window.__ModuleLoader__.load({id, factory})` 垫片 + `window.React` / `window.ReactDOM`
  （React 用 **UMD 产物**，由 `tools/vendor-react.mjs` 从 `node_modules` 铺到
  `sidecar/page/react/`，**不进仓库**；版本与 `tools/browser-test` 保持一致）。
- 给插件的 ctx 桩：`{ effect(fn){...}, slots: undefined, logger }`。`slots` 故意不给——
  插件那一节本来就 try/catch 兜着（老宿主没有这个 slot），右键面板不受影响。
- 页面静态资源一律 `cache-control: no-store`：桌面端没有构建步骤，改完刷新就该生效。
- 驱动遇到"文档已加载完但读口不在"要**主动重载一次**：那是壳上一轮留下的旧文档，
  拿它跑就是拿昨天的代码跑（这次假红过一次）。

## 跟着会话走（M2 已打通）

桌面端不拥有 DSH 的进程，所以拿不到 `ctx.on(...)`；但**插件宿主半区已经把 12 个 DSH 事件
折成了 9 个相位**并通过 SSE 推出来。sidecar 订阅 `http://127.0.0.1:3080/api/live2d-pet/events`
（`--dsh` / `PET_DESKTOP_DSH`，传 `none` 关掉），把相位喂给本地 hub 即可。这样桌面上演的
相位语义与网页端**必然一致**（tool → thinking 的 1200ms 防抖、done 的 3.5s 回落都发生在
DSH 那边，不是第二份实现）。连不上不是错误：宠物照样站着、照样自己摸鱼。

实测：`probe-phase.mjs` 观察 20 秒，`data-phase` 在 `tool` 与 `thinking` 之间跟着真实的
工具调用往返（当时的"工具"就是这个驱动自己）。

## 常驻开销（Windows，debug 构建，3440×1440@100%）

| 项 | 实测 |
|---|---|
| 渲染帧率 | **144 fps**（读 `requestAnimationFrame`，模型 PSD 600×600 的 canvas） |
| CPU | 待机动画每 10 秒 0.44 秒 CPU 时间 ≈ **4.4% 单核** |
| 壳进程内存 | ~49 MB |
| WebView2 进程树 | 6 个进程，合计 ~593 MB（**debug 构建**；release 会明显小） |
| 穿透轮询 | 33ms 一轮，`probeErrors` 长期为 0 |

## 环境与工具链（本机实测）

- 本机**没有** `cargo` 在 PATH 上：装完 rustup 之后在 `%USERPROFILE%\.cargo\bin`。
  后台任务里要自己拼 PATH，否则 `cargo` 直接 CommandNotFound（这次就踩了）。
- `winget install Rustlang.Rustup` 能静默装好（stable-x86_64-pc-windows-msvc，配 VS 2022
  Community 的 MSVC 工具链；`vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 指到它）。
- WebView2 运行时是系统组件（本机 155.x），Win10/11 自带；`cdp` 端口用
  `additional_browser_args("--remote-debugging-port=N")` 打开。
- 首编 ~6 分钟（417 个 crate），增量 ~10–20 秒。
- 多显示器：本机是 3440×1440 主屏 + 左右各一块 2560×1440；窗口按**主屏工作区**铺
  （3440×1392，差的那 48px 是任务栏）。

## 还剩什么（M1/M3/M4）

- 拖动还是"窗口内挪位置"：桌面版应该是"拖宠物 = 移动窗口"。位置也还是相对窗口存的，
  换分辨率会偏。→ 让窗口跟着宠物走，并把坐标存成屏幕坐标。
- 托盘、开机自启、多显示器选择。
- 右键面板里嵌 `PetSettingsBody`（用 desktop flag 守卫，网页端行为不变）。
- 打包：NSIS/MSI + 随包 node（sidecar 现在依赖机器上的 `node`）。
