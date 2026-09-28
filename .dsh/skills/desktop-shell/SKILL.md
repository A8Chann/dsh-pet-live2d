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

## 多屏：窗口只覆盖**一块**屏，跟着光标搬

原实现只建在 `primary_monitor()` 的工作区上，于是**她只能待在主屏**：鼠标移到别的屏幕时
窗口收不到指针事件，跟随与穿透判定全都失效（用户报的"多屏幕无法移动到别的屏幕"）。

现在的做法（`pet_window.rs`）：

- **一个窗口**覆盖"光标所在那块屏的工作区"，光标跨屏时由跟随循环把它搬过去
  （`focus_monitor_at`，几何/尺寸都对着新屏的工作区设）。
- **不是每块屏一个窗口**：那等于好几个客户端实例，而"同一时刻只有一只"是硬约束
  （装扮、动作状态机、相位都在各自实例里，多开就各自演化）。一个窗口搬来搬去只有一份状态。
- **也不是"铺满整个虚拟桌面"**：试过，进程**直接崩**（事件日志 `0xc0000409` fail-fast，
  模块是 exe 自己）—— 8560×1440 且带负原点的透明 WebView2 会踩到某个边界。别试。
- 搬窗口那一帧**原点要在移动之后重新读**：先读再移的话局部坐标会差出一整块屏。
- 搬完给页面一点时间重抓轮廓（幅度判定按的是轮廓快照），期间判定走"穿透"（安全的一侧）。

验证：`tools/probe-multimonitor.ps1` —— 把光标依次移到**每块屏**的工作区中心，读窗口真实
矩形，和期望的工作区逐一比对。判据是**窗口矩形**，不是日志、不是自报字段。
（脚本带 UTF-8 BOM：Windows PowerShell 5.1 没有 BOM 时按 GBK 读 `.ps1`，中文注释会解坏。）

## 鼠标跟随：契约是**像素距离**，不是舞台比例

用户报"鼠标跟随范围有问题"。根因是**坐标契约错了**：原来把偏移按**舞台尺寸**归一化
（`(x - width/2) / (width/2)`），而

  * 网页端舞台就是可见视口（几百像素），所以"鼠标一动就到边缘"看着正常；
  * 桌面端舞台是**整块屏**（3440px），她只占右下角 300px —— 她附近的移动归一化后只有
    百分之几，看起来几乎不跟随。而且 `pointermove` 是 window 级监听，盒子外的移动被
    "超出 240px 就当她没在看"整段丢掉，于是盒子里外是**断的**。

现在：`updatePointer(dx, dy, rangePx)` 收**相对她中心的像素偏移**，`gazeRangePx`（默认
320，可调）就是"离她多远算看到最边上"，上下限夹在视口内。桌面端实测曲线：
60px→0.08、160px→0.43、320px→1.00，方向正确、连续。

**接口别混坐标系。** 这一版之前是 `updatePointer(x, y, width, height)`、内部拿 `width/2`
当中心 —— 调用方给的是视口坐标，于是 `(2386 - 320) / 320` 直接夹到满偏，"注视恒定 1.0"。
看出问题靠的是**在函数入口打印实参**：算错与传错是两回事，只看结果分不出来。

## 诊断页面的读口（比截图与猜测都快）

`tools/inspect-desktop-page.mjs` 一次取回：根节点上的 `data-*`（含 **`data-renderer`**
标明这一份是"页面里"还是"桌面窗口里"）、canvas 的渲染尺寸 vs CSS 尺寸、WebGL 上下文是否
丢失、`window.__errors`、以及一张截图。实测用它从"窗口可见但什么都看不到"一路查到
`visibility: hidden`（让位判据写反），两次调用就定位了。

跟随相关的中间量挂在 `window.__dshLive2dPet.gazeTrace()`（**进函数的实参** + 判据半径），
`tools/probe-gaze-range.mjs` 直接量曲线。

## 单文件便携 exe（M4 已打通，且**宿主半区翻成了 Rust**）

**发出去的是一个文件**：`dist/DSH桌宠.exe`（**8.94 MB**，不用安装，双击就跑）。

### 走过的两条路（体积 vs 实现份数）

| 路线 | exe | 代价 |
|---|---|---|
| Tauri 壳 + **Node sidecar**（deno compile 成独立二进制内嵌） | **95.5 MB** | 体积极差：86MB 是 V8 运行时本体 |
| Tauri 壳 + **同进程 Rust 宿主半区** | **9.15 MB** | 宿主半区成了**第二份实现**，必须配自动对拍 |

deno 那条路**跑通了**（catalog 与 node 版逐字段相同、页面 8/8、壳 16/16），但两件事把它
判了死刑：

1. **`deno compile` 没有 `--strip`**（试过，报 unexpected argument）；
2. **`llvm-strip --strip-all` 也压不动它**：86.3MB 进、86.3MB 出（装了 `llvm-tools` 再用
   `rust-strip` 走一遍，结果一样）。那 86MB **不是符号，是 V8 运行时**。

所以"必须 10MB"只能翻实现。翻完的实测：**8.94 MB**（含 5.52MB 嵌入资源）。

### 翻实现的关键：先写对拍，再动手

两份实现一定会分叉，唯一的解药是**一个能自动发现分叉的判据**。`tools/probe-catalog.mjs`
同时跑两份**真实**宿主：

* JS 版：node 直接跑 `dsh-live2d-pet/lib/index.js` 的 `buildRoutes()`（网页端在用的那份，
  一行没改），挂在临时端口上；
* Rust 版：壳里正在跑的那个宿主（端口从进程上找）。

比三件事：**catalog 的每个字段**（数组按下标比 —— 顺序会影响界面排序与抽签）、
**闭包里每个资产的每个字节**、**闭包外的路径两边都拒**。浮点给 1e-9 相对容差
（Node 与 Rust 读同一个十进制小数可能差 1 ULP，如 `0.20000004768371582` vs `…85`），
其余一律严格。

它抓到的三个真 bug（都是"看着没问题"的那类）：

1. **块作用域**：`let mut motions` 写在了 `if let` **里面** —— JS 是函数作用域，Rust 是块
   作用域，出块就没了，`json!` 直接少掉整个字段。症状是"动作菜单与装扮整段消失"。
   这类差异在 C 系语言背景的人手里很容易漏，**对拍一眼就现行**（`"js":[...], "rust":"(缺失)"`）。
2. **`json!` 静默吞字段**：把 `motions` / `expressions` 写在 `json!` 里时，两个字段**整个
   消失**（同一个宏里别的字段都在、两个 Vec 明明有内容、`print` 都正常）。改成
   `value.as_object_mut().insert(...)` 后行为确定 —— 遇到"宏里少了字段"别再猜，直接手工插。
3. **JSON 对象的键顺序**：serde_json 默认 BTreeMap（字典序），于是
   `FileReferences.Motions` 变成 BubbleGum / Hammer / Idle…，而 JS 的 `Object.entries()`
   给的是文件里的声明顺序（Idle 在前）。加 `serde_json = { features = ["preserve_order"] }`
   才对得上 —— 右键面板「动作」页签的顺序就是这个。

### 同进程带来的简化（相比 sidecar）

- **不需要文件协议**：壳的状态以前要写 `shell-state.json` 让 sidecar 读（跨进程），现在
  直接读内存里的 `Host::shared`；
- **不需要收尸**：没有子进程，也就不可能留孤儿（以前退出要 `taskkill /T` 整棵树）；
- **不需要解包 86MB**：启动快了一大截；
- 页面**一行没改**：它认的还是 `/api/live2d-pet/*` 与 `/__desktop/*` 两组路径。

### 资源嵌入（build.rs 一次搞定）

`src-tauri/build.rs` 扫描并生成 `OUT_DIR/embed_files.rs`（`include_bytes!` 只吃**字面量
路径**，清单必须在构建期定下来）：浏览器半区、vendor 分包、页面、React UMD（生产版优先
139KB）、Cubism Core（本机缓存那份），以及**随包宠物**（65 个文件，运行时解包到 exe 旁边
的 `DSH桌宠-data/plugin/`，宿主按文件系统扫它）。

### 资源体积（实测）

| 项 | 大小 |
|---|---|
| 嵌入资源（76 个文件） | 5.52 MB |
| ├ 随包宠物（65 个文件：moc3 + 贴图 + 动作 + 表情） | 4.06 MB |
| ├ vendor 分包（pixi + Live2D 引擎） | 783 KB |
| ├ Cubism Core（本机缓存那份，内嵌后离线可用） | 202 KB |
| ├ React UMD（**生产版**；开发版 1.16MB） | 139 KB |
| └ 页面 + 客户端半区 | 360 KB |
| **成品 `dist/DSH桌宠.exe`** | **9.15 MB** |

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

## 挂载模式：`--attach <dsh-url>`（"改 bug 只改一处"的落点）

同一个 exe，一个参数决定宠物数据从哪来：

| 模式 | 宠物数据 / 相位 | 什么时候用 |
|---|---|---|
| 独立（默认） | 本机 Rust 宿主扫 pets、自己发资产；相位订阅 DSH | **DSH 没开也要她在**（这个模式存在的唯一理由） |
| 挂载 `--attach` | 全部转发给 DSH 里的插件；本机不碰宠物目录 | 只想把插件那只挪到桌面上 |

实现：`host/http.rs` 的 `relay_to_upstream()` —— 裸 socket 转发 `API + "/*"`，双向搬运。
两个坑：

1. **上游可能回 chunked**（DSH 的资产路由走 `node:http` 的默认分块），那种情况**不能**
   把 `content-length` 再抄一遍，得把分块剥壳、只透传体；回给客户端时统一声明
   `connection: close`（我们不知道上游会不会继续写）。
2. **连不上上游时故意报 502，绝不退回本机实现**。第一版写的是"转发失败就落到本机兜底"，
   看着更稳健，实则把"挂载没成功"伪装成"挂载成功"（页面上照样有宠物，但它来自本机扫描）。
   验证驱动里那条负向断言（指向死端口 → 必须失败）就是为了钉住这个决定。

顺带：挂载时**不要**再跑本机的相位桥（`PET_DESKTOP_DSH=none`）、**不要**解包随包宠物
（宠物归 DSH 那边的插件管），否则两个壳会去写同一个 `%DSH_HOME%\pets`。

验证在 `tools/probe-attach.mjs`（15/15）：catalog / 模型描述 / Cubism Core / vendor 与上游
**逐字节相同**、SSE 相位转发得到、页面渲染正常、上游不可达时 502 且 `mode=attach`。

### 两个测试环境的坑（都是这次踩的）

- **一个 exe 只能跑一份**：WebView2 的 user-data-dir 是独占的，第二份进程直接退出
  （`Get-Process` 只数到 1 个）。任何"两个实例同时跑"的驱动设计都不成立，要**顺序**做。
- **端口别问进程表**：`Get-NetTCPConnection -OwningProcess` 在中文进程名 / 受限环境下会
  返回空。**从页面 URL 推端口**最稳：页面是壳的宿主发的，`http://127.0.0.1:<port>/` 里那个
  端口一定是它（一个实例给一个独立 CDP 端口，映射就是确定的）。

## 已完成 / 还剩什么

**M0（透明 + 穿透 + 复用插件）**、**M2（跟着 DSH 走）**、**M3（设置菜单进右键面板）**、
**M4（单文件便携 exe + 托盘）**、**M5（挂载模式）** 都已落地并实测通过；宿主半区已翻成
Rust，exe 8.94 MB。

还剩：

- **拖动整窗**：现在拖动还是"窗口内挪位置"，位置也还是相对窗口存的（换分辨率会偏）。
  正确做法是"拖宠物 = 移动窗口"、位置存屏幕坐标。
- **托盘菜单按状态灰掉**：`pet_window::is_visible` 已经写好，还没接。
- **开机自启**、多显示器选择。
- **宿主半区是两份实现**：Rust 一份、`lib/index.js` 一份（网页端在用）。改宠物契约
  （`pet.json` 字段语义）必须**两边一起改**，然后跑 `probe-catalog.mjs` —— 这条是纪律，
  不是建议。
- **非 Windows**：没验过不吹。
