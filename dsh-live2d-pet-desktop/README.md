# dsh-pet-live2d-desktop

**把 [dsh-live2d-pet](../dsh-live2d-pet/) 这只桌宠从 DSH 的网页搬到你自己的桌面上** ——
一只真的站在桌面上、不挡其它窗口、跟着 DSH 会话状态换动作的 Live2D 宠物。

> **状态：M0 已通过（Windows 实测）**。已验证：透明常驻窗、逐像素穿透、真 `lib/client.js`
> 渲染、右键面板、跟随 DSH 相位。还没做：拖动整窗、托盘、打包。
> 完整结论与踩坑记录在 [`../.dsh/skills/desktop-shell/SKILL.md`](../.dsh/skills/desktop-shell/SKILL.md)。

<p align="center">
  <img src="shots/pet-on-desktop.png" alt="桌宠站在真实桌面上（透明区能看见壁纸）" width="380">
  <br>
  <sub>屏幕实拍：只有角色吃鼠标事件，方形画布的透明处直接透到壁纸</sub>
</p>

## 它和网页版是什么关系

**不是重写，是换壳。** 插件已经被切成两半，桌面端把这两半原样搬过来：

| 层 | 谁 | 复用程度 |
|---|---|---|
| 宠物逻辑 | `dsh-live2d-pet/lib/index.js`（宿主半区） | **零改动**：宠物发现、`pet.json` 解析、模型引用闭包、资产路由、Cubism Core 缓存全走它 |
| 渲染与互动 | `dsh-live2d-pet/lib/client.js`（浏览器半区） | **零改动**：拖动、注视、摸头摸尾巴、槽位装扮、相位动作、右键面板都是那一份 |
| 桌宠该有的壳 | `src-tauri/`（本目录） | 新写的：透明置顶窗口、逐像素穿透 |
| 数据搬运 | `sidecar/` | 新写的：把插件路由挂在回环端口上，页面照旧 `fetch` / `EventSource` |

这么切的好处很实在：**网页端的 19 个回归 driver 仍然是桌面端的回归网**——
`lib/client.js` 怎么改都还在被验；桌面端要修的只有"壳"这一层。

## 跑起来

```bash
cd dsh-live2d-pet-desktop

npm install          # React UMD（页面用，与网页端同一份产物、同一版本）
npm run prep         # 把 UMD 铺到 sidecar/page/react/

npm run dev          # 起壳（默认挂真的桌宠；默认尝试连本机 3080 的 DSH）
npm run dev:spike    # 起壳，但页面是极简气球——只验"透明 + 穿透 + 性能"
```

前置：Node 18+（sidecar）、Rust stable + MSVC 工具链（壳）、WebView2 运行时（Win10/11 自带）。
连不上 DSH 不是错误：宠物照样站着、照样自己摸鱼，只是不跟着会话换相位。想彻底关掉：
`PET_DESKTOP_DSH=none`。

只想验 sidecar，不想起 GUI：

```bash
npm run sidecar      # 固定 8791 端口
npm run ping         # 另一终端：把 ping / 目录 / 资产 / 判定四个接口都问一遍
```

## 壳的四个决定（都是踩过才知道的）

1. **全屏透明层，不是一个小窗口。** 右键面板宽 270px、锚在角色左侧，气泡悬在头顶；
   一个 300×300 的小窗会把它们裁掉。全屏层里布局与网页端**完全一致**，`client.js`
   一格都不用改。代价是穿透判定必须对——所以窗口初始状态就是"忽略光标事件"，判定
   跑起来才打开：失败时默认**不挡桌面**，而不是挡。
2. **坐标由壳给，不听 `pointermove`。** 窗口一旦设成忽略光标事件，Windows 就把命中
   测试交给下层窗口，页面根本收不到鼠标移动（Electron 是靠 `forward: true` 额外喂消息
   解决的，Tauri 没有这个开关）。所以方向只能是壳 `GetCursorPos` 轮询 → 问页面 → 切状态。
3. **页面与壳之间没有 IPC。** 判定走 HTTP（`/__desktop/probe`），壳的状态走一个 JSON 文件，
   插件的资产走 `/api/live2d-pet/*`。两边都只跟 sidecar 说话——**换壳（比如换 Electron）时
   页面与 sidecar 可以原样搬走**。顺带绕开了一个坑：Tauri 对 loopback 页面默认拒绝自定义
   命令（`not allowed. Plugin not found`），要走通得开远程 IPC 权限，那正好和"发布版别留
   后门"相反。
4. **不把 `lib/index.js` 翻成 Rust。** 那份逻辑修过好几个 bug、有回归测试；翻一遍就是
   第二份实现。Node 在 DSH 用户的机器上必然存在。嫌两个进程重，等壳的结论出来再谈。

## 目录

```
sidecar/
  server.mjs         回环服务器：挂插件的真路由表 + 发页面 + 转发穿透判定
  dsh-link.mjs       订阅运行中 DSH 的相位流（断了自动重连）
  paths.mjs          路径（插件在 ../dsh-live2d-pet）
  page/
    index.html       桌宠页面（React UMD + __ModuleLoader__ 垫片 + 插件浏览器半区）
    runtime.js       桌面端运行时：判定 + 给插件的 ctx 桩
    desktop.js       反向通道：页面来领探针任务
    boot.js          等插件注册 → apply → 挂状态读口
    spike.html       极简气球页（只验壳能力）
    hover.js         spike 页的判定实现
src-tauri/
  src/lib.rs         装配：拉起 sidecar、建窗、穿透轮询、写状态文件
  src/pet_window.rs  透明置顶窗口
  src/sidecar.rs     node 子进程的生命周期与握手
tools/
  vendor-react.mjs      铺 React UMD
  make-icon.mjs         最小 ICO 生成器
  desktop-driver.mjs    壳的全链驱动（CDP + 真的挪光标 + 读窗口扩展样式）
  page-driver.mjs       只验页面（无头 Edge，不牵扯壳）
  probe-through.ps1     穿透的"铁证"：读 WS_EX_TRANSPARENT
  probe-anim.mjs        待机动画：页内连续采样引擎参数与帧率
  probe-phase.mjs       相位端到端：DSH 事件 → 桌面端的 data-phase
  ping.mjs              sidecar 自检
  shot.ps1              截屏（透明是否真透明，靠照片说话）
```

## 怎么验（都是确定信号，不做截图比对）

```bash
# 壳：透明 + 穿透 + 判定链（要壳带 PET_DESKTOP_CDP=8823 起来）
node tools/desktop-driver.mjs --page pet     # 16/16
node tools/desktop-driver.mjs --page spike   # 16/16

# 页面（无头 Edge，不牵扯壳）
npm run sidecar                              # 另一终端
node tools/page-driver.mjs --url http://127.0.0.1:8791

# 待机动画与帧率
node tools/probe-anim.mjs --ms 4000

# "跟着会话走"：跑起来之后随便让 DSH 干点活
node tools/probe-phase.mjs --seconds 20
```

## 读口（排查用）

| 读口 | 在哪 | 看什么 |
|---|---|---|
| `GET /__desktop/ping` | sidecar | sidecar 活着吗、发现几只宠物、探针问了/答了多少、DSH 连上没有 |
| `GET /__desktop/shell` | sidecar | 壳的状态（窗口几何、DPI、光标、判定、切换次数、探针错误数） |
| `.run/shell-state.json` | 磁盘 | 同一份状态的原始文件（壳每 33ms 写） |
| `window.__petDesktop.diag()` | 页面（devtools） | 启动成功没、判定理由、命中元素、错误 |
| `window.__petDesktopLink` | 页面 | 反向通道的往返次数与错误数 |

## 已知限制（M1 起）

- **拖动还是"窗口内挪位置"**：桌面版应该是"拖动整只宠物 = 移动窗口"。M1 做。
- **位置在不同分辨率下会偏**：窗口原点固定在工作区左上，而 `client.js` 存的是相对
  窗口的坐标。M1 改成"窗口跟着宠物走"。
- **托盘、开机自启、多显示器选择**：M1。
- **设置页**：桌面端暂时不挂 `PetSettingsBody`（那是 DSH 设置页的 slot）；右键面板照旧。
  M3 用 desktop flag 把它嵌进右键面板，网页端行为不变。
- **打包**：M4（NSIS/MSI + 随包 node；现在 sidecar 依赖机器上的 `node`）。
- **只在 Windows 上验过**。macOS/Linux 的透明与穿透是另一套（`set_ignore_cursor_events`
  在 Linux 上是 no-op），没验过不吹。

## 许可

与主仓库一致：插件代码 MIT；随包的 DS鲸鱼娘模型 **CC BY-NC-SA 4.0**（署名 · 非商业 ·
相同方式共享），完整说明见 [`../NOTICE.md`](../NOTICE.md)。`src-tauri/icons/icon.png`
与 `shots/` 里的截图取自仓库宣传图（同为 CC BY-NC-SA 4.0）。
