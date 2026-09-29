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

## 多屏：她住在**一块固定的屏**上（别让她跟着鼠标跑）

第一版让她"跟着光标所在屏幕走"。**那是错的**，用户的原话是"宠物应该是在固定位置，我鼠标在
不同屏幕上宠物居然会跟随我的鼠标所在的屏幕"。她是桌面上的宠物，位置属于她自己。

现在的规则：

* **归属**：启动时落在光标当时所在的那块屏，之后**不再因鼠标移动而改变**；
* **换屏入口只有两个**：启动时、托盘「屏幕」子菜单（一块屏一项，标出分辨率与相对位置，
  当前那块打点 —— 3 块屏时"循环切换"等于让用户猜）；
* 指针移到别的屏 → 窗口一动不动，视线到屏幕边缘就贴边（靠 `gazeRangePx` 收紧）。

验证：`tools/probe-multimonitor.ps1` —— 先断"窗口正好落在某一块屏的工作区上"，再断
"光标走遍**每一块**屏、窗口矩形一个像素都不变"。**判据是窗口矩形**，不是日志/自报字段。

两个几何上的硬约束（都实测过）：

* **别铺满虚拟桌面**：`8560×1440` 且带负原点的透明 WebView2 会让进程直接崩
  （事件日志 `0xc0000409` fail-fast，模块是 exe 自己）。
* **别每块屏一个窗口**：那等于好几个客户端实例，而"同一时刻只有一只"是硬约束
  （装扮、动作状态机、相位都在各自实例里）。

## 跟随：桌面端必须由**壳喂全局光标**

`pointermove` 只在指针**落在这个窗口上**时才由浏览器送来。用户一操作别的程序，落点不在
我们这个窗口上，页面**一个事件都收不到** —— 症状就是用户报的
**"只有焦点在宠物上才有跟随"**。全屏透明层在这里帮不上忙：事件不是被挡住，而是压根没
发生在这个窗口上。

而壳本来就在**每 33ms 读一次全局光标**（穿透判定必须知道指针在哪）。所以：

| 环节 | 做什么 |
|---|---|
| 壳 | `GET /__desktop/cursor` 返回**本窗口 CSS 像素**（全局坐标 − 窗口原点，再除缩放） |
| 页面 | 自己的 33ms 循环里顺路问一次，转交 `window.__petPointer(x, y)` |
| 插件 | 两个来源走**同一条** `onMove`：DOM 事件 + 壳喂的全局位置；读口带 `source`（`dom`/`shell`） |

桌面端**不要**做 `mouseleave`/`blur` 的"回正"：那边"离开窗口"不代表指针不存在，恰恰相反，
用户在别处动鼠标时她**应该**跟着。

**验证这条只能用真实光标**（`SetCursorPos`）：CDP 的合成事件恰恰是"假装指针在这个窗口上"，
用它验等于没验 —— 这一轮就是因此把问题漏掉的（此前所有 driver 都用合成事件，全部只覆盖
DOM 路径）。`tools/probe-desktop-follow.mjs` 用真实光标在她四周移动并读 `source=shell`。

## 跟随范围：一道**正圆距离**曲线（不是方形、不是椭圆，也没有硬边界）

跟随强度由**到她的圆形距离比** `u = hypot(dx, dy) / range` 决定，只有一条曲线：

| 距离比 u | 强度 | 感受 |
|---|---|---|
| 0 → 1（= `gazeRangePx`，220px） | 0 → 1 成比例 | 附近跟得灵 |
| 1 → `gazeWatchingRatio`（2.7） | 1 → 0 缓动衰减 | "渐渐不感兴趣" |
| ≥ 2.7 | 0，视线回正（`data-gaze=center`） | 当她没在看 |

**为什么不是方形**：横竖分别比较的话，四个角"比看上去更远"，斜着走会提前掉出范围。
**为什么最后是正圆而不是椭圆**：椭圆（竖直半径更大）确实能照顾"她贴屏幕底边、页面正中就
离她 546px"这个几何，但用户要的是"远近由**一个**半径决定"—— 多一个竖直半径只是多一个要
调的旋钮。正圆的上限因此是**视口的一半**（半径超过视野没有意义）。

偏转强度也用同一个半径归一化（不额外压范数）：`nx = shape(dx/range)`、`ny = shape(dy/range)`，
合成长度天然 ≤ 1（正圆），无需再夹。

**三点都踩过**：

* 第一版是"超过阈值立刻回正"的硬边界 —— 于是她要么满偏斜眼盯着、要么啪一下回正，
  用户看到的分别是"全屏都在追踪"和"突然不看了"。**视野要有过渡**。
* 第二版判据用 `hypot(dx, dy) > 阈值`（正圆）但阈值取 420 → 桌面端**整条曲线全是 0**：
  页面正中就比她高 546px。
* 满偏半径处**注视幅度是 0.85 而不是 1.0**：死区造成的理论值
  （`shape(1.0) = (1 - 0.12) / 0.88 = 0.852`）。断言别按"应该 1.0"写。

**探针必须沿一条从她出发的射线采样**，不能固定 y 只动 x —— 固定 y 量到的是"竖直那一大截"
而不是横向距离。这一轮为此算错过两次，症状都是"曲线全 0 或全是很小"。
`tools/probe-live-state.mjs` 现在沿左下 150° 采样，并打印半径 / 距离比 / 强度 / 是否被跳过。

## 可摸区域：它和"判定算不算她"必须是**同一套栅格**

用户报"右下角有一大片奇怪的可触摸区域，那里明明什么都没有"。定位靠把**形状采出来**：
`tools/probe-hit-area.mjs` 把舞台铺成网格，逐点问两件事 —— `document.elementFromPoint()`
（跟着 `clip-path` 走，回答"能不能摸到"）与 `window.__dshLive2dPet.hitsMask()`
（回答"判定算不算她"）。差集就是那片空白（网格图里的 `?` 格）。

**根因**：尾巴那一层原来是**几何并集**（包围盒 128×162px，占舞台 43%×54%；凸包、逐块矩形
也都试过，都还是"多算"），而 `hitsMask` 用的静态轮廓是**栅格**（还是"一格膨胀"的保守版）。
两套几何不一致，差集就成了"能摸到、判定却不算她"的区域。

**一次定案的判据**：`window.__petNoTailLayer = true` 把那一层关掉再量一遍 —— 实测
**14 格 → 0 格**。所以那片空白完全是尾巴层造成的，与轮廓、与判定都无关。

**修法**：让尾巴也从**模型空间的三角面**重采一份与静态轮廓同规格的栅格（同一个模型包络盒
归一化、格子边长同量级、输出 `M x y h w v h h-w Z` 与 `maskPath()` 同形）。改完 `?` 格 14 → **0**。

两条踩过的坑：

* **探针的坐标口径**：API 上的 `hitsHead/hitsTail` 收的是**舞台局部**坐标（组件那层减了
  rect），直接喂 client 坐标会一律返回 false —— 实测"1024 格全都不算"，白跑一轮。
* **探针要按时间取交集**：这一层每 120ms 跟着尾鳍重算，只在某一瞬间可摸的格子不算"那片
  区域"。`probe-hit-area` 现在采 6 次取"每次都成立"。

## 摸头 vs 摸尾巴：路由是**尾巴优先**（按用户要求从"头优先"翻回来）

图层顺序（尾巴盖住头发）是 **.moc3 里烤好的** —— `model3.json` 只有 Moc/Textures/Physics/
DisplayInfo/Motions/Expressions，**没有部件顺序表**，改不了。能改的是**判定路由**。

历史与判据（`tools/probe-head-tail-overlap.mjs`，网格 32×32、5 次取交集）：

| 时期 | 只算头 | 只算尾巴 | 两者都算 | 重叠占角色 |
|---|---|---|---|---|
| 作者换路由时 | — | — | — | **86.6%**（尾鳍把 16 块全算，其中 11 块是没显形的配件） |
| 现在（尾鳍按贴图收窄到 5 块） | 262 | 17 | 29 | **9%** |

作者当初改"头优先"是因为重叠 86.6%：先判尾巴等于"点在头部也给尾巴反应"。**那个前提已经没了**
（9%），而用户看到的是"尾巴画在头发上面"—— 点在**看得见的尾鳍**上他要摸尾巴。所以现在路由是
尾巴优先；代价是那 29 格（头部区域里的一小片）归尾巴。改回去只需把两个分支换回来
（`client.js` 里那段注释写了原因与数字）。

`cdp-interact` 那条路由断言的输入点**本来就是"只算头、不算尾巴"**的点（`headPoint` 的定义
如此），所以两种路由下它都该给摸头台词 —— 换路由时**不需要**放宽它。

## PowerShell 脚本必须带 UTF-8 BOM

Windows PowerShell 5.1 **没有 BOM 就按 ANSI/GBK 读 `.ps1`**，中文注释解成乱码，而乱码里
一个引号/括号就会让整份脚本报出**指向正常行**的语法错。write/edit 工具默认不写 BOM，
所以每改一次 `.ps1` 都要补：`node tools/ensure-ps1-bom.mjs`（`--check` 给提交前用）。

另外：`$home` 是 PowerShell 的**只读内置变量**，脚本里别拿它当普通变量名（赋值会报错并
留空，整轮结果都变成家目录字符串）。

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

### ⚠️ 挂载模式只转发 **API**，页面的 `client.js` 仍是 exe 内嵌的那份

**这是最容易误判的一条**，我为此把"设置不同步"查到了错方向：

```
挂载模式的数据流：
  /api/live2d-pet/*                 → 转发给 DSH（宿主的 JS 实现说了算）
  /plugins/dsh-pet-live2d/client.js → **serve_embed("client.js")**，exe 里那份
                                       （host/http.rs 里那一行是硬编码的）
```

后果：**改了 `lib/client.js` 之后，只让页面 F5 是没用的 —— 必须重建 exe**。
不重建的话，DSH 页面跑新代码、桌面端跑上次构建时的旧代码，症状是"同一份代码、
两个界面行为不一样"，而人会本能地去桌面端找"它特有的 bug"。

**查法**（很好用，一眼看出它发的是哪一份）：

```js
fetch('/plugins/dsh-pet-live2d/client.js', { cache: 'no-store' })
  .then(r => r.text())
  .then(t => JSON.stringify({ bytes: t.length, hasNewCode: t.includes('新写的函数名') }))
// bytes 与磁盘上那份（Get-Item lib/client.js）对不上 ⇒ 发的是旧的
```

**踩过的实例**：用户报"桌面的设置与 DSH 里的设置没有同步"。共享存档那部分改对了，
但端到端验证一直红 —— 因为桌面端页面拿到的 `client.js` 里**根本没有**新写的
`persistShared`。重建 exe 之后立刻通过。

验证在 `tools/probe-attach.mjs`（15/15）：catalog / 模型描述 / Cubism Core / vendor 与上游
**逐字节相同**、SSE 相位转发得到、页面渲染正常、上游不可达时 502 且 `mode=attach`。

### 两个测试环境的坑（都是这次踩的）

- **一个 exe 只能跑一份**：WebView2 的 user-data-dir 是独占的，第二份进程直接退出
  （`Get-Process` 只数到 1 个）。任何"两个实例同时跑"的驱动设计都不成立，要**顺序**做。
- **端口别问进程表**：`Get-NetTCPConnection -OwningProcess` 在中文进程名 / 受限环境下会
  返回空。**从页面 URL 推端口**最稳：页面是壳的宿主发的，`http://127.0.0.1:<port>/` 里那个
  端口一定是它（一个实例给一个独立 CDP 端口，映射就是确定的）。

## macOS：能构建、不能在本机验（2026-09 做的那一轮）

**macOS 目标只能在 macOS 上构建。** 依赖里有要编 Objective-C 的 crate（`objc2-*`），
所以在这台 Windows 上连 `cargo check --target aarch64-apple-darwin` 都过不去：
`cc-rs` 找不到 `cc` 就 `error occurred in cc-rs: failed to find tool "cc"`。
**别在这上面耗时间** —— 装了 rustup target 也没用，缺的是 macOS SDK。
结论：mac 那份唯一的产地是 CI（`.github/workflows/desktop-mac.yml`，`macos-14`），
它跑 `cargo test --lib` —— 那是 mac 目标第一次真正被编译的地方。

因为本地编不了，**策略是"让 mac 与 Windows 共用同一条代码路径，mac 专属代码压到最少"**。
下面每条都是"不这么做就踩坑"：

### 1. `tauri-build` 的 feature allowlist 只认顶层 `[dependencies]`

`tauri.conf.json` 里写了 `macOSPrivateApi: true`，就必须在 Cargo.toml 里有
`macos-private-api` 这个 feature，否则构建直接失败：

```
The `tauri` dependency features on the `Cargo.toml` file does not match the allowlist
defined under `tauri.conf.json`. ... add the `macos-private-api` feature
```

坑在**它怎么找**：`find_dependency()` 先看顶层 `[dependencies]`，**只有顶层没有才翻
`[target.*.dependencies]`**。我们顶层有 `tauri`，所以写在 `[target.'cfg(target_os =
"macos")'.dependencies]` 里的那份它**根本看不见** ⇒ Windows 上照样报错。
写在顶层也正是 `tauri dev/build` 自己会做的（它改的就是这一行）。
代价：Windows 构建也会带上它牵扯到的 `wry/transparent` + `wry/fullscreen`
（`tauri-runtime/macos-private-api` 本身是空 feature）⇒ **改完必须回归**：
`npm run build:portable`（含对拍 + 壳全链 + 网页端 suite）。

### 2. macOS 的全局光标：CoreGraphics，不是 NSEvent

穿透判定要"操作系统光标在哪"（窗口忽略事件之后页面收不到鼠标移动，这是鸡生蛋问题）。
非 Windows 原来直接返回 `None` ⇒ 建窗时那个"忽略光标事件"永远打不开 ⇒ **她点不到**。

* **用 `CGEventCreate(NULL)` + `CGEventGetLocation`**：CoreGraphics 没有"只能主线程"的
  约束，也**不需要**辅助功能/录屏权限（只读当前指针位置，不装事件监听）。
* **不要用 NSEvent**（tao 内部就是这么读的）：那是 AppKit，而穿透轮询跑在**后台线程**上。
* 口径：`CGEventGetLocation` 是**逻辑点**、原点 = 主屏左上角，与 `CGDisplayBounds`
  **同一套空间**（tao 的屏幕框就是它乘上该屏缩放）。Windows 的 `GetCursorPos` 是**物理
  像素**。两者与 `outer_position()`（物理）的关系不同，所以换算写成一条带 `k` 的公式：

  ```rust
  local = (cursor * k - window_origin) / scale   // macOS: k = scale；Windows: k = 1
  ```

* 这段换算是**唯一能在本机对两个平台都验**的代码，所以把它拆成纯函数
  `pointer_local_with(..., logical: bool)` 并配 4 个单元测试（含"缩放为 0 不能出 NaN"——
  NaN 会让 `local < 宽度` 恒 false，症状正是最难查的那种"她永远点不到"）。
* 挑屏（"她该出现在光标所在那块屏"）同理：**两边都换算到同一空间再比** ——
  Windows 都比物理像素；macOS 把屏框 ÷ 该屏自己的缩放，除回 `CGDisplayBounds` 那个点空间。

### 3. `skip_taskbar` 在 macOS 上是空函数

`tauri-runtime-wry` 的 macOS 分支：

```rust
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn skip_taskbar(self, _skip: bool) -> Self { self }   // 什么都不做
```

tao 也只给 Windows/Linux 写了实现。mac 上要藏得靠**激活策略**：
`app.set_activation_policy(tauri::ActivationPolicy::Accessory)`（`ActivationPolicy` 只有
macOS 才有，用 `#[cfg(target_os = "macos")]` 包起来），`.app` 里再叠一层 `LSUIElement`。

### 4. `.app` 里不要往包内写数据

`resolve_runtime_dir` 的"便携优先"（exe 旁边 `DSH桌宠-data/`）在 `.app` 里是**有害**的：
`Contents/MacOS/` 用户可写，于是随包宠物会被解包进包里 ⇒ **代码签名当场失效**，下次启动
被 Gatekeeper 拒。判据是"可执行文件在不在 `….app/Contents/MacOS/` 里"，
在包里就走 `app_local_data_dir()`。

### 5. 主目录变量两个平台不同名

`DSH_HOME` 没设时：Windows 是 `%USERPROFILE%`，macOS/Linux 是 `$HOME`。只认前者的话 mac
上退化成**当前工作目录**下的 `.dsh`（宠物目录找不到，还会在人家随便哪个 cwd 里乱写）。
`lib.rs` 与 `build.rs` 都要按这个规则取（`build.rs` 嵌 Cubism Core 时也走它）。

### 6. 打包与 CI 的几处细节

* `tools/build-portable.mjs` 现在**平台感知**：Windows 出 `dist/DSH桌宠.exe` 并跑验证；
  macOS 出裸二进制 + `DSH桌宠.app`（`sips`+`iconutil` 转图标、`codesign --sign -`
  ad-hoc 签名），**不跑验证**（那套驱动全是 Windows 的）。
* `tools/npm-prepare-subpackage.mjs --sub darwin-arm64`：平台子包表现在有两项，
  `declared` 标记这个子包**有没有发布** —— 没发布时主包 `optionalDependencies` 里不该有它
  （否则用户装主包会去找一个不存在的包）。发布顺序永远是**先子包、后主包**。
* CI 里两件容易被忽略的输入：`tools/browser-test` 的 `npm ci`（`build.rs` 要在编译期嵌
  React UMD，缺了只是 warning，跑起来才白屏）；Cubism Core 的路径（决定产物**要不要**
  自带离线 core —— 下载并嵌入等于随包分发专有运行时，所以默认关，留了 workflow input）。
* runner：Apple Silicon 用 `macos-14`；**Intel 要用 `macos-15-intel`**（`macos-13` 已下线，
  官方给的迁移标签就是它，可用到 2027-08）。
* `.app` 打包用 `ditto -c -k --keepParent`（`zip` 会丢可执行位/签名相关属性）。

### 7. 在这个环境里**起不了 GUI**（别再花时间复现）

想在本机跑一遍桌面端驱动时会撞上：

```
Failed to setup app: error encountered during setup hook: 建桌宠窗口失败：拒绝访问。 (os error 5)
EXITCODE=-1073740791
```

**这不是构建坏了。** 判定它的那次对照实验值得记住：把 **npm 上已发布的 3.0.1 exe**
（`registry.npmjs.org/dsh-pet-live2d-desktop-win32-x64/-/…-3.0.1.tgz`，构建路径是别人机器上
的 `C:\Users\aymb0\.cargo\…`）拉到同一环境里跑 —— **一模一样地失败在同一行**。
所以"建窗被拒"是 DSH 会话这个执行环境本身的性质（进程树/会话没有可用的交互桌面），
与你的改动无关。换着法子试过且都**没用**：沙箱内 `Start-Process`、`node spawn detached`、
`schtasks`（带不带 `/IT` 都一样）、把 `TEMP`/`DSH_HOME`/`WEBVIEW2_USER_DATA_FOLDER`
指到工作区（Tauri 显式指定 WebView2 数据目录，那个环境变量会被覆盖 ⇒ 无效）。

推论（也是纪律）：**桌面端 GUI 行为只能由人在真实交互会话里确认**。会话内能自动验的是
宿主机半区（`probe-catalog.mjs` 对拍）、`cargo test --lib`、以及一切进程外读口。

顺带两条本机启动细节，省得再踩：

- `Start-Process -RedirectStandardError/-RedirectStandardOutput` 在这台机器上**直接报**
  `Item has already been added. Key in dictionary: 'HTTP_PROXY' Key being added: 'http_proxy'`
  —— 环境里同时有大写与小写的代理变量，PowerShell 建环境字典时炸了。要抓 stderr 就包一层
  `.cmd`（`"%~1" > log 2>&1`），并且 **`.cmd` 里不能出现中文**（cmd 按 ANSI/GBK 读脚本，
  中文路径会烂）—— 用 `%~1` / `%~dp0` / 8.3 短路径，或先把 exe 复制到纯 ASCII 目录。
- 从会话里 `Start-Process` 出去的 GUI 进程会继承 stdout 管道 ⇒ 宿主命令**永远不返回**
  （看起来像卡死）。要么放后台作业，要么让子进程把输出重定向进文件。

### 8. 未验证清单（别在 README 里写成既成事实）

真机上没有验过的：透明窗在 macOS 上是否真的透（`macOSPrivateApi` 只是必要条件）、
逐像素穿透、全局跟随、托盘菜单、多屏归属、以及**整个渲染栈** —— Windows 跑的是
WebView2/Chromium，mac 是 WKWebView/WebKit，Pixi 8 + Cubism Core 在 WebKit 上从没跑过。
macOS runner 没有可交互窗口会话，这些在 CI 里也验不了；只有真机能回答。

## 「双击 exe，她没显示出来」（2026-09 用户报，两个根因叠在一起）

用户的原话：**"我直接跑 Release 里的 exe，桌宠没显示出来，但是我插件起的桌面是好的。"**

### 根因一：显示层偏好把"手动启动"的意图吃掉了

`%DSH_HOME%\pet-desktop.json` 当时是 `{"mode":"inline"}`。判定规则只有一条：

```
心跳新鲜（< 6 秒）且 mode ≠ "inline"  →  桌面端是 owner
否则                                  →  页面内是 owner
```

于是手动启动的那一份：起来 → 刷心跳 → 读到 `inline` → **1 秒内把自己 `hide()`**。
进程活着、托盘图标也在（Win11 还把它收进溢出区），用户看到的就是"什么都没发生"。
而插件那条路会先写 `mode: desktop` 再 `spawn(… '--attach', url)`，所以它看着一切正常。

**修法**：`host::display::manual_launch_overrides_inline(mode, launched_by_plugin, mode_forced_on_cli)`
—— 手动启动 + `mode=inline` ⇒ 把偏好写成 `desktop`（同一个共享文件，页面里那只立刻让位，
仍然只有一只）。**两个例外都不能改写**：

* 插件拉起的那份：`lib/display.js` 的 spawn 现在带 `--from-plugin`，壳据此严格尊重用户选择；
* `--dsh inline`（驱动专用，`probe-*.mjs` 要一个"绝不退回桌面"的环境）—— 命令行是圣旨。
  ⚠️ **漏掉这一条就是真回归**：驱动起来的环境会被壳自己翻成 desktop。

### 根因二：GUI 程序没有控制台，失败是**彻底静默**的

`main.rs` 上是 `windows_subsystem = "windows"`（release 双击不弹黑框），代价是 stderr 没去处。
建窗失败、WebView2 忙、panic —— 用户那边一律表现为"双击了，什么都没发生"。

**修法**（`src/logbook.rs` + `lib.rs` 的 `install_panic_hook`）：

* 启动过程写 `%DSH_HOME%\pet-desktop.log`（stderr 照旧打，开发时不用改习惯），
  其中**最重要的一行是"显示层决定"**：`她在桌面上` / `按偏好让位（mode=inline）` /
  `窗口是用户在托盘里藏起来的`；
* panic 钩子：写日志 + Windows 上弹 `MessageBoxW`（不引依赖，windows-sys 已有）指向日志路径。

**排查顺序因此固定下来**：用户说"没反应"→ 先读 `%DSH_HOME%\pet-desktop.log`
（每次启动都留了结论），再看 `pet-desktop.json` 的 mode，最后才怀疑二进制。

### 顺带学到的

* **"用户手动启动" vs "按设置拉起" 是两种意图**，原来的实现把它们混为一谈（都只读偏好文件）。
  凡是"按共享状态决定行为"的地方都要问一句：**这次启动是谁发起的、他想要什么**。
* 时间戳自己算（`logbook::format_utc_ms`，Hinnant 的 `civil_from_days`）比引 chrono 便宜，
  而且**能在本机跑单元测试** —— 在验不了的平台上，这类纯函数是唯一能钉死的东西。

### 第二报：报错框里是 `0x800700AA 请求的资源在使用中`

用户双击后拿到的是我新加的报错框（说明诊断生效了），但里面是 **WebView2 建不起来**。
这个错误码的意思是 **user-data-dir（`%LOCALAPPDATA%\<identifier>\EBWebView`）被占用**，
而它同时暴露了另外两个静默失败：**`%DSH_HOME%\pet-desktop.log` 没生成、偏好也没被改写**
（那个构建把两处写失败都吞掉了）。

那一刻能同时解释这三件事的只有一个：**那个进程在 DSH 的文件沙箱里**（写不进 `%DSH_HOME%`
与 `%LOCALAPPDATA%`）。所以先问清"你是怎么启动的"：**从 DSH 会话里跑**（终端/agent/工具）
就会这样；**资源管理器里双击**、或**插件拉起**（DSH 宿主进程是沙箱外）就正常。
我自己那一整个下午的 `拒绝访问 (os error 5)` / `0x800700AA` 也是同一个根因 —— 对照实验是
"连 npm 上已发布的 3.0.1 exe 也一样失败"。

这一轮补的四件事（都是"让失败自己说话"或"把常见失败变成正常行为"）：

| 改动 | 为什么 |
|---|---|
| 启动时先看**心跳**判"已经有一只了" → **优雅退出**（手动双击时给个信息框） | user-data-dir 独占是硬约束，报"起不来"是错的表达；判据用心跳不用 pid（pid 会被重用） |
| 建窗失败**重试 3 次**（每次 1.5 秒） | 上一只刚退、目录还没放开是常见情形，等一下就好 |
| 日志写不进 `%DSH_HOME%` 就**退到 exe 旁边**，两处都失败把原因带进弹框 | 写失败被吞掉过一次，代价是一整轮"为什么没日志" |
| 插件 `stop()` 在 Windows 上 `taskkill /T` | `child.kill()` 只杀壳，`msedgewebview2.exe` 子进程会留着占目录 ⇒ 下一次启动撞 0x800700AA |

日志里现在也带 **exe 的完整路径**：同一台机器上可能同时存在 Release 下的、`dist/` 里刚构建的、
插件管的三份，"跑的到底是哪一份"不该靠猜（这次猜了很久）。

### 第三报（真正的根因）：**DSH 会话里产出的文件带 Low 完整性标签**

用户的框还在，但这次的日志落在了 **exe 旁边**（`dist\pet-desktop.log`）而不是
`%DSH_HOME%` —— 说明 `%DSH_HOME%` 那处写入是被**拒绝**的。兜底路径救回了现场，
而我把"首选位置为什么写不进"也记进了日志：

```
[logbook] 首选日志位置写不进（已改用 …\dist\pet-desktop.log）：C:\Users\HWX\.dsh\pet-desktop.log：拒绝访问。 (os error 5)
```

同一台机器、同一个用户，从 PowerShell（High 完整性 / 管理员）写 `C:\Users\HWX\.dsh` 是**成功**的，
ACL 也没问题（`SYSTEM / Administrators / <本地 SID>` 都是 FullControl）。真正的线索是
`icacls` 的那一行：

```
dist\DSH桌宠.exe   Mandatory Label\Low Mandatory Level:(I)(NW)     ← ★
```

**在 DSH 会话里写出来的文件会带 `Low` 完整性标签**（沙箱给工作区里的新文件打的就是它），
而那个 exe 正是我在会话里构建/复制出来的。被标成 Low 的 exe：**双击起来后进程就是 Low
完整性**，按 no-write-up 规则**写不进任何 Medium 对象** ⇒ `%DSH_HOME%` 拒绝访问、
`%LOCALAPPDATA%\<id>\EBWebView` 建不起来（WebView2 报 `0x800700AA 资源在使用中`）。
插件从 npm 下载到 `%DSH_HOME%\bin\` 的那份（普通进程写的、没有标签）因此一切正常 ——
**同一个版本、同一个二进制，只差一个标签**。

**判据（A/B 实测，别再靠推理）**：把同一个 exe 标成 Low 与 Medium 各跑一次（计划任务
`schtasks /create … /f` + `schtasks /run`，注意 `.cmd` 里**不能放中文路径** —— ASCII 编码会
把路径吃掉，白白得到一次假失败）：

| exe 标签 | `%DSH_HOME%` 里有日志 | 偏好被改写 |
|---|---|---|
| Low | ✗ | ✗ |
| Medium | ✓ | ✓ |

**修法与护栏**：`tools/integrity.mjs` 的 `ensureNotLowIntegrity()` —— 检查 `icacls` 的
Mandatory Label 行，是 Low 就 `/setintegritylevel Medium` 并复查，摆不正直接让构建失败。
已接进 `build-portable.mjs`（产物出库）与 `npm-prepare-subpackage.mjs`（发 npm 前）。
手动修一条命令：`icacls "<exe>" /setintegritylevel Medium`。

**这条的适用范围比桌面端大**：**任何"在会话里构建、再交给用户双击/运行"的产物都要过这一道**
（exe、脚本要用的二进制、放进 zip 的启动器……）。CI 里构建的不受影响（GitHub runner 是普通进程）。

## 已完成 / 还剩什么

**M0（透明 + 穿透 + 复用插件）**、**M2（跟着 DSH 走）**、**M3（设置菜单进右键面板）**、
**M4（单文件便携 exe + 托盘）**、**M5（挂载模式）** 都已落地并实测通过；宿主半区已翻成
Rust，exe 8.94 MB。**M6（macOS arm64 构建）**代码与 CI 就绪，行为未在真机验证。

还剩：

- **拖动整窗**：现在拖动还是"窗口内挪位置"，位置也还是相对窗口存的（换分辨率会偏）。
  正确做法是"拖宠物 = 移动窗口"、位置存屏幕坐标。
- **托盘菜单按状态灰掉**：`pet_window::is_visible` 已经写好，还没接。
- **开机自启**、多显示器选择。
- **宿主半区是两份实现**：Rust 一份、`lib/index.js` 一份（网页端在用）。改宠物契约
  （`pet.json` 字段语义）必须**两边一起改**，然后跑 `probe-catalog.mjs` —— 这条是纪律，
  不是建议。
- **非 Windows**：macOS arm64 只做到"能构建"，行为没验过；Intel Mac 与 Linux 连构建都
  还没有（平台表与子包清单已按平台写好，加矩阵项即可）。
