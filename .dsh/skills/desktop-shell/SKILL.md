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

## 单文件便携 exe（M4 已打通）

**发出去的是一个文件**：`dist/DSH桌宠.exe`（~55MB，不用安装，双击就跑）。四样东西
在里面：壳（Tauri/WebView2）、**sidecar 的独立二进制**、**sidecar 的资源**（插件宿主
半区 + 随包宠物 + React + Cubism Core + 页面）、图标。

### 为什么用 deno compile 而不是把宿主半区翻成 Rust

`lib/index.js` 里的宠物发现、`pet.json` 归一化、模型引用闭包、随包宠物按内容指纹同步，
是修过好几个 bug、有回归测试的逻辑；**翻一遍就是第二份实现**，而且两边会慢慢分叉。
`deno compile` 把它连同 Node 兼容层一起编成一个 exe —— **JS 一行不改**，宠物行为与
网页端天然一致。实测现有 sidecar 源码在 deno 2.9.7 下**直接跑通**（catalog 与 node 版
逐字段相同，`node:http` / `node:fs` / `node:crypto` 的 `createHash` 都在）。

三个坑：

1. **`deno compile` 没有 `--strip`**（试过，报 unexpected argument）。更意外的是
   **`llvm-strip --strip-all` 也压不动它**：86.3MB 进、86.3MB 出（装了 `llvm-tools`
   再用 `rust-strip` 走了一遍，结果一样）。所以那 86MB **不是符号，是 V8 运行时本体**
   —— 想变小只能不装 JS 运行时（把宿主半区翻成 Rust，约 10MB），代价是第二份实现。
   实测产物：sidecar 86.3MB + 资源 5.6MB → **成品 exe 95.5MB**。
2. **`--include <目录>` 必须显式给**：资源是运行期用拼出来的路径读的，静态分析看不见。
   不给的症状是"开发时好好的、打包后 404 / Module not found"。
3. 独立二进制里**不要把 `import.meta.url` 那套当判据**。试过 `Deno.mainModule` 与
   "dev 的 embed 目录在不在"，两个都不可靠 —— 编译产物里的**虚拟文件系统也能
   `existsSync`**，于是误判成开发期，然后去读一个不存在的仓库路径
   （症状：`Module not found: .../dsh-live2d-pet/lib/index.js`）。改成**壳显式告知**：
   `PET_DESKTOP_EMBED` 在 = published。

### 壳与 sidecar 的分工（解包这件事只能壳做）

壳先把资源解包到运行期目录、把 `PET_DESKTOP_EMBED` 指对，**才能**拉起 sidecar——
sidecar 用 `pluginRoot()` 推 `pets/` 目录（它只认文件系统），所以插件那份副本必须真的
在磁盘上，且布局与真包一致。

运行期目录**便携优先**：exe 旁边可写就用 `.\DSH桌宠-data\`（U 盘、绿色版带着走），
不可写才退到 `%LOCALAPPDATA%\<identifier>\runtime\`。判据是**真的写一次试试**，不是猜
路径权限。解包有 `.unpacked` / `.stamp` 标记（内容是"文件数|sidecar 大小"），换一版
exe 才重解。

### 资源清单要有两份（一份给壳、一份给 sidecar）

`tools/prep-embed.mjs` 生成 `sidecar/embed-manifest.mjs`（JS，sidecar 解包时按它读）；
`src-tauri/build.rs` 再把同一份清单翻译成 Rust（`embed_files.rs`，`include_bytes!` 要的是
**字面量路径**，没法在运行期拼）。两边不一致时的症状是"打包后少了几个文件"，所以
build.rs 会比对清单条数与实际嵌入条数并 `cargo:warning` 报出来。

### 资源体积（实测）

| 项 | 大小 |
|---|---|
| sidecar 独立二进制（strip 也没用，见上） | 86.3 MB |
| embed 资源（78 个文件） | 5.57 MB |
| ├ 插件宿主半区 + 随包宠物 | 4.12 MB |
| ├ vendor 分包（pixi + 引擎） | 783 KB |
| ├ Cubism Core（本机缓存那份，内嵌后离线可用） | 202 KB |
| ├ React UMD（**生产版**：139KB；开发版 1.16MB） | 139 KB |
| └ 页面 | 12 KB |
| **成品 `dist/DSH桌宠.exe`** | **95.5 MB** |

React 用生产版：单文件 exe 里体积要算，而桌宠出问题读的是我们自己的 `data-*` 读口与
驱动，不需要 React 的警告。

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
   ⚠️ **挪完要轮询"期望的判定结果"，并且挪不成就重挪**，判据**不要**写成"壳读到的坐标
   等于目标"：这台机器上同时跑着别的桌面应用（实测前台是 DSH Desktop），它会动光标，
   把外部干扰当回归就白查一轮。
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

## 驱动要"模拟真实操作"，不要自己造事件

设置菜单的驱动（`tools/probe-settings.mjs`）踩到的：checkbox 上 `box.checked = x` +
派发 `change` 事件，**React 根本不认**——DOM 的 `checked` 变了、插件里的开关没动、
`localStorage` 也没写。React 对 checkbox 的 `onChange` 其实是挂在 **click** 上的。
改成 `box.click()` 立刻通过。

同一类教训在转圈那三条断言上（`tools/browser-test/cdp-interact.mjs`）：合成的画圈窗口
原来调成 6000ms，机器吃力时画完 3.2 圈要 6 秒以上，累计被**整轮作废**，`total` 停在
0.59 弧度，三条一起假红而单跑就绿。修法是**把窗口调到与机器速度无关**（60 秒）——
这个窗口只用来证明"窗口可配"，真实触发判定不靠它。

## 设置菜单：桌面端把设置正文接进右键面板

桌面端**没有 DSH 的客户端壳**，所以 `ctx.slots`（设置页那一节）挂不上 —— 设置正文在
网页端有家，在桌面端没有。做法是**在右键面板加第三个页签**（桌面端专属）：

- 守卫是页面运行时留下的标记 `window.__petDesktop`（`desktopNow()`），
  **网页端行为一个字不变**（那边仍然没有这个页签）；
- 页签激活时面板加宽一档（270 → 342px，`[data-panel][data-wide]`），因为设置正文是表格；
- 设置正文外面套一层 `data-settings`，把已有的设置样式作用域带进来（那套样式本来就为
  窄容器收过一列）；
- 托盘 →「设置…」用窗口事件 `pet://settings` 打开它，"归位"用 `pet://reset`。

注意这块**改的是插件的浏览器半区**（`dsh-live2d-pet/lib/client.js`），所以网页端的
19 个 driver 是它的回归网 —— 改完必须跑一遍 `run-suite.mjs`。

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

## 已完成 / 还剩什么

**M0（透明 + 穿透 + 复用插件）**、**M2（跟着 DSH 走）**、**M3（设置菜单进右键面板）**、
**M4（单文件便携 exe + 托盘）** 都已落地并实测通过。

还剩：

- **拖动整窗**：现在拖动还是"窗口内挪位置"，位置也还是相对窗口存的（换分辨率会偏）。
  正确做法是"拖宠物 = 移动窗口"、位置存屏幕坐标。
- **托盘菜单按状态灰掉**：`pet_window::is_visible` 已经写好，还没接。
- **开机自启**、多显示器选择。
- **体积**：95MB 里 86MB 是 V8 运行时（`deno compile` 压不动）。想去掉只能把宿主半区
  翻成 Rust（约 10MB），但那会带来第二份实现。
- **非 Windows**：没验过不吹。
