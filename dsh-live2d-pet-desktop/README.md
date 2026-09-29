# dsh-pet-live2d-desktop

**把 [dsh-live2d-pet](../dsh-live2d-pet/) 这只桌宠从 DSH 的网页搬到你自己的桌面上** ——
一只真的站在桌面上、不挡其它窗口、跟着 DSH 会话状态换动作的 Live2D 宠物。

**发出去的是一个文件：`DSH桌宠.exe`（8.94 MB，不用安装）。** 双击就跑：不需要装
Node、不需要装 DSH、不需要装插件 —— 宠物本体（模型 + 贴图 + 动作）就嵌在 exe 里。

<p align="center">
  <img src="shots/pet-on-desktop.png" alt="桌宠站在真实桌面上（透明区能看见壁纸）" width="380">
  <br>
  <sub>屏幕实拍：只有角色吃鼠标事件，方形画布的透明处直接透到壁纸</sub>
</p>

## 怎么用

| 想干什么 | 怎么做 |
|---|---|
| 看见她 | 双击 exe（托盘里会出现她的图标，桌宠没有任务栏按钮） |
| 换个动作 / 换装扮 | 在她身上**右键** |
| **改设置** | 右键 →「设置」页签（桌面端专属）**或**托盘 →「设置…」 |
| 藏起来 / 显示 | 托盘图标**左键单击**＝显示；托盘菜单 →「藏起来」 |
| 归位（回到右下角） | 托盘菜单 →「归位」，或右键面板底部的「归位」 |
| 退出 | 托盘菜单 →「退出」 |

**跟着 DSH 走**（可选）：本机跑着 `dsh web`（默认 `127.0.0.1:3080`）时她会自动连上，
思考 / 用工具 / 等你批准 / 完成 / 出错都换动作与表情；DSH 没开就自己摸鱼，互不打扰。
想彻底关掉：`DSH桌宠.exe --dsh none`。

**第一次启动**会把随包宠物解包到 exe 旁边的 `DSH桌宠-data\plugin\`，再按内容指纹同步进
`%DSH_HOME%\pets\ds-whale-girl\`（与网页端插件同一份规矩：你改过的那份一个字都不碰）。

## 架构：三层，一个进程

```
DSH桌宠.exe（一个进程）
  ├── 壳(Tauri)     窗口：透明、置顶、不进任务栏、穿透轮询、托盘
  ├── host(Rust)    宠物扫描 → catalog、资产路由（引用闭包白名单）、相位流(SSE)、页面分发
  └── 页面(WebView) 跑的就是 lib/client.js
```

**页面一行没改**：它认的是 `/api/live2d-pet/*` 与 `/__desktop/*` 两组路径，谁在背后答它
并不关心。这是刻意的 —— 网页端的 19 个 driver 因此仍然是桌面端的回归网。

| 层 | 谁 | 复用程度 |
|---|---|---|
| 浏览器半区 | `dsh-live2d-pet/lib/client.js` | **零改动语义**（只多了一个桌面端守卫，见下） |
| 宿主半区 | `src/host/`（Rust） | **重写**：见"为什么翻 Rust" |
| 随包宠物 | `dsh-live2d-pet/pets/` | 编译期嵌进 exe，运行时解包 |

## 两种运行模式：独立 / 挂载

同一个 exe，一个启动参数决定"宠物数据从哪来"：

| 模式 | 怎么起 | 宠物数据 / 相位 | 什么时候用 |
|---|---|---|---|
| **独立**（默认） | `DSH桌宠.exe` | 本机 Rust 宿主扫 `%DSH_HOME%\pets`，自己发资产；相位订阅 DSH | **DSH 没开也要她在** —— 这就是这个模式存在的理由 |
| **挂载** | `DSH桌宠.exe --attach http://127.0.0.1:3080` | 全部转发给 DSH 里的插件；本机**不碰**宠物目录 | 你已经装了网页插件，只想把她挪到桌面上 |

**挂载模式是"改 bug 只改一处"的落点**：这时本机的宠物扫描、catalog、资产路由一次都不
参与，页面拿到的每个字节都来自 DSH 里的 `lib/index.js` —— 那边修好了，桌面这只跟着好。
事件走同一条路（`/api/live2d-pet/events` 直接转发），所以挂载时**不需要**本机那条相位桥。

两条边界：

- **挂载模式下 DSH 必须是活的**。连不上上游时它**故意报 502**，不静默退回本机宿主 ——
  静默兜底会把"挂载没成功"伪装成"挂载成功"（页面上照样有宠物，但它其实来自本机扫描）。
  真兜底是用户的显式选择：不加 `--attach` 就是独立模式。
- **一个 exe 只能跑一份**（WebView2 的 user-data-dir 是独占的），别指望同机开两个。

## 和 DSH 网页插件的关系

两边跑的是**同一个 `lib/client.js`**（摸头、摸尾巴、槽位装扮、相位动作、右键面板、
设置正文全是它），所以**行为类 bug 只改一处、两边一起好**：

| 改动落在哪 | 要改几处 |
|---|---|
| 客户端（`lib/client.js`）：渲染、动作状态机、判定、界面 | **一处**（网页端与桌面端共用） |
| 宿主（catalog / 资产路由 / 宠物扫描）：`lib/index.js` 与 `src-tauri/src/host/` | 两份 —— 但**挂载模式下只有一份在干活**，独立模式下才需要两边同步 |
| 壳（窗口行为） | 本来就不同，谈不上改两次 |

改了宿主契约（`pet.json` 字段语义、资产 URL 形状）时，跑 `tools/probe-catalog.mjs`
让两份实现当场对拍。

### 为什么翻 Rust（以及代价）

原来那套是"Tauri 壳 + Node sidecar"，用 `deno compile` 把 sidecar 编成独立二进制嵌进
exe。**跑通了，但 exe 有 95MB**：其中 86MB 是 V8 运行时本体 —— `deno compile` 没有
`--strip`，`llvm-strip --strip-all` 实测也压不动（86.3MB 进、86.3MB 出）。

翻成 Rust 之后 **8.94 MB**。代价是**第二份实现**，而两份实现一定会分叉 —— 所以配了
一条**对拍驱动**（见下）：把 JS 版宿主半区与 Rust 版放在一起，逐字段比 catalog、逐字节
比资产。翻错了立刻红，而不是等用户发现装扮少了一个槽位。

顺带白拿的三件事：没有子进程要收尸（不再可能留孤儿）、壳的状态不必再绕一个
`shell-state.json`（同进程直接读内存）、启动不需要解包 86MB。

## 构建

```bash
cd dsh-live2d-pet-desktop
npm run build:portable      # 一键产出 dist/DSH桌宠.exe
```

顺序很简单（资源在**编译期**由 `src-tauri/build.rs` 嵌进去）：

1. `cargo build --release`；
2. 拷到 `dist/DSH桌宠.exe`；
3. 起壳 → 对拍 + 壳全链 → 网页端回归（`--skip-suite` 可跳过）。

开发时不必每次 release：

```bash
npm run dev          # 改页面/客户端 JS 后重新构建即可生效
npm run dev:spike    # 换成极简气球页：只验"透明 + 穿透 + 性能"
```

前置：Rust stable + MSVC、WebView2 运行时（Win10/11 自带）。
**不需要 Node 运行时、不需要 deno**（构建期只用 node 跑工具脚本）。
React UMD 从 `tools/browser-test/node_modules` 取（与 DSH 客户端同一个版本）。

### 图标

```bash
npm run icon -- --source <你的图.png>     # 默认用 src-tauri/icons/icon.png
```

产出多尺寸 `icon.ico`（16/24/32/48/64/128/256）与托盘的 `32x32.png`。

## 桌面端专属：设置菜单

桌面端没有 DSH 的客户端壳，`ctx.slots`（设置页那一节）挂不上 —— 所以设置正文在**右键
面板的第三个页签**里，和 DSH 设置页那一节是**同一个组件、同一份存档**：

- 页签只在桌面端出现（守卫是页面运行时留下的 `window.__petDesktop` 标记）；
- 打开设置页签时面板自动加宽一档（270 → 342px），因为设置正文是表格；
- 托盘 →「设置…」等于替用户点开它。

**网页端行为一个字都没变**：那边仍然没有这个页签。

## 验证（都是确定信号，不做截图比对）

```bash
# 起壳（验证驱动都接管壳里的 WebView）
PET_DESKTOP_CDP=8823 ./dist/DSH桌宠.exe      # PowerShell: $env:PET_DESKTOP_CDP="8823"

node tools/probe-attach.mjs      # 15/15 挂载模式：逐字节同上游 + 相位转发 + 不兜底（要 DSH 在跑）
node tools/probe-catalog.mjs     # 7/7  独立模式对拍：JS 参照 vs Rust，逐字段 + 58 个资产逐字节
node tools/desktop-driver.mjs    # 16/16 壳：透明 + 穿透（读窗口扩展样式）+ 判定链
node tools/probe-settings.mjs    # 9/9  设置菜单：页签 / 正文 / 真的改得动设置 / 托盘事件
node tools/page-driver.mjs       # 8/8  页面：插件挂载、canvas、无脚本错误
node tools/probe-phase.mjs       # 相位端到端：真实 DSH 事件 → data-phase
node tools/probe-anim.mjs        # 待机动画：页内连续采样引擎参数与帧率
node tools/probe-through.ps1 -X 150 -Y 320   # 穿透"铁证"：WS_EX_TRANSPARENT 那一位
```

`probe-catalog.mjs` 是这次翻实现的关键：它同时跑两份真实宿主，比 catalog 的每个字段与
闭包里每个资产的每个字节。**浮点给 1e-9 相对容差**（Node 与 Rust 读同一个十进制小数可能
差 1 ULP），其余一律严格相等。

## 目录

```
sidecar/page/        页面（编译期被 build.rs 嵌进 exe）
  index.html         桌宠页面（React UMD + __ModuleLoader__ 垫片 + 插件浏览器半区）
  runtime.js         桌面端运行时：判定 + 给插件的 ctx 桩
  desktop.js         反向通道：页面来领探针任务
  boot.js            等插件注册 → apply → 挂状态读口
  spike.html         极简气球页（只验壳能力）
  hover.js           spike 页的判定实现
src-tauri/
  src/lib.rs         装配：运行期目录、启动宿主、建窗、穿透轮询、相位桥
  src/host/          **宿主半区（Rust）**
    catalog.rs       宠物扫描 / pet.json 归一化 / 引用闭包 / cdi3 部件 / 随包宠物同步
    http.rs          进程内 HTTP：资产、运行时、SSE 相位流、页面、桌面端接口
    shared.rs        同进程共享状态（穿透判定、壳状态、相位）
    embed.rs         编译期嵌入的资源查表与解包
    dsh_link.rs      订阅运行中 DSH 的相位流（裸 TcpStream 逐行读 SSE）
  src/pet_window.rs  透明置顶窗口
  src/tray.rs        托盘图标与菜单
  build.rs           把插件/页面/宠物/React/Cubism Core 嵌成 Rust 源码
tools/
  build-portable.mjs 一键出单文件 exe
  probe-catalog.mjs  **对拍驱动**（JS 参照 vs Rust）
  desktop-driver.mjs 壳的全链驱动
  probe-settings.mjs 设置菜单驱动
  probe-phase.mjs    相位端到端
  probe-anim.mjs     待机动画与帧率
  probe-through.ps1  穿透"铁证"
  page-driver.mjs    只验页面
  probe-core.mjs     脚本加载诊断
  make-icon.mjs      多尺寸 ico + 托盘图
  shot.ps1           截屏
  paths.mjs          工具脚本的共享路径
```

## 读口（排查用）

| 读口 | 在哪 | 看什么 |
|---|---|---|
| **启动日志** | `%DSH_HOME%\pet-desktop.log` | 起手参数、显示层偏好、**"显示 / 让位"的结论与原因**、起不来时的错误 |
| 运行期目录 | exe 旁边 `DSH桌宠-data/` | 解包出来的随包插件 |
| `GET /__desktop/ping` | 宿主（端口从进程上找） | 活着吗、发现几只宠物、探针问答数、DSH 连上没有 |
| `GET /__desktop/shell` | 宿主 | 壳的状态（窗口几何、DPI、光标、判定、切换次数、探针错误数） |
| `window.__petDesktop.diag()` | 页面（devtools） | 启动成功没、判定理由、命中元素、错误 |
| `window.__dshLive2dPet.settingsOverrides()` | 页面 | 设置存档（开关 / 相位 / 台词覆盖） |

## 双击了，但没看到她？

**先看 `%DSH_HOME%\pet-desktop.log`** —— 每次启动它都记了结论：

| 日志里写的是 | 意思 | 怎么办 |
|---|---|---|
| `显示层决定：她在桌面上` | 她在显示，可能只是被别的窗口盖住 / 在另一块屏上 | 托盘图标 → 「归位」 |
| `显示层决定：按偏好让位（mode=inline）` | 你在 DSH 设置里选了「页面内」，桌面这只让位了 | 设置里选「桌面」。（**手动双击 exe 现在会自动切成「桌面」**，不再静默让位） |
| `已经有一只桌宠在跑（pid …）` | 一只只能跑一份（WebView2 数据目录独占） | 用托盘里那只；想换一只先「退出」再启动 |
| `**起不来**：…` | 启动失败（Windows 上还会弹框，框里写明程序路径） | 框/日志里有完整错误：建窗被拒 / WebView2 忙 / 权限 |

三条容易误判的：

- **一只只能跑一份**：插件已经拉起一只时，再双击 exe 那份会撞 `0x800700AA 请求的资源在使用中`
  —— 现在它会**自动重试 3 次**，仍不行就明确告诉你"已经有一只了"，而不是报"起不来"。
- Windows 11 默认把新托盘图标收进**溢出区**（任务栏那个 `^`），别以为进程没起来。
- **不要在 DSH 会话里启动这个 exe**（比如在某个终端里敲它、或让 agent 帮你跑）：那个进程在
  DSH 的文件沙箱里，**写不进 `%DSH_HOME%`、也建不了 `%LOCALAPPDATA%` 下的 WebView2 数据
  目录**，症状正是 `0x800700AA`（还会连日志都写不出来）。要她出现在桌面上，就在资源管理器里
  **双击**，或者用 DSH 设置里的「桌面」让宿主进程去拉起（那条路是沙箱外的）。

## 已知限制

- **拖动还是"窗口内挪位置"**：桌面版应该是"拖动整只宠物 = 移动窗口"。位置也还是相对
  窗口存的，换分辨率会偏。
- **托盘菜单的"显示/隐藏"不会按状态灰掉**（`pet_window::is_visible` 已经写好，还没接）。
- **托盘图标在 Windows 11 默认收进溢出区**（系统行为，不是坏了）。
- **宿主半区现在是两份实现**：Rust 一份、`lib/index.js` 一份（网页端在用）。改宠物契约
  （`pet.json` 的字段语义）时要**两边一起改**，然后跑 `probe-catalog.mjs`。
- **只在 Windows 上验过**。这套透明 + 逐像素穿透在 Windows 上的每一环都有驱动盯着；
  macOS 那一份**构建**已经通了（见下），但"能不能点、跟不跟手"还没人在真机上验过；
  Linux 连构建都还没有。

## 平台支持

| 平台 | 构建 | 验证 | 说明 |
|---|---|---|---|
| Windows x64 | ✅ 本机 / CI | ✅ 驱动齐全（对拍 + 壳全链 + 网页端 suite） | 单文件 `DSH桌宠.exe`，随插件包分发 |
| macOS arm64 | ✅ CI（`.github/workflows/desktop-mac.yml`，`macos-14`） | ❌ **未在真机验证** | 出 `DSH桌宠.app`（ad-hoc 签名）+ 裸二进制（npm 子包用） |
| macOS x64 / Linux | ❌ | ❌ | 平台表与子包清单已按平台写好，加一个矩阵项 / 一次移植即可 |

macOS 那份的三条硬事实（写下来免得下次重新踩）：

1. **只能在 macOS 上构建**：依赖里有要编 Objective-C 的 crate，本机（Windows）连
   `cargo check --target aarch64-apple-darwin` 都过不去（缺 `cc` 与 macOS SDK）；
2. **没签名、没公证**：第一次打开会被 Gatekeeper 拦，要右键→打开，或者
   `xattr -dr com.apple.quarantine <路径>`；想双击就开得有 Apple Developer ID；
3. **不进程序坞**靠 `ActivationPolicy::Accessory`（Windows 那个 `skip_taskbar(true)` 在
   macOS 上**没有实现**），`.app` 里另外用 `LSUIElement` 兜一层。

## 许可

与主仓库一致：插件与壳的代码 MIT；随包的 DS鲸鱼娘模型 **CC BY-NC-SA 4.0**（署名 ·
非商业 · 相同方式共享），完整说明见 [`../NOTICE.md`](../NOTICE.md)。

**Cubism Core（Live2D 株式会社的专有运行时）**：构建时会把本机缓存过的那份嵌进 exe，
让离线也能用；插件本身仍然走"从官方 CDN 取一次再缓存"那条路，仓库里不分发它。
