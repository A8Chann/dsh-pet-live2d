# DSH_Pet_Live2d 项目规则

给 DSH Web GUI 做 Live2D 桌宠插件（`dsh-live2d-pet/`）+ 配套验证工具（`tools/`），
外加桌面端（`dsh-live2d-pet-desktop/`：单文件便携 exe，Tauri 壳 + 同进程 Rust 宿主半区）。
模型是 B站@氵六青 的 DS鲸鱼娘（Cubism 5，1 个 .moc3、8 组动作、44 个表情）。

## 核心规则

- 回复用用户的语言（中文）；代码注释、commit message 也用中文。
- 验证一律用**确定性信号**（读引擎在帧内写进模型的参数值），不要用截图逐像素/哈希比对；driver 必须以退出码收尾，不允许只打印不断言。
- 动引擎代码前先确认帧内写入顺序，避免参数"永远关不掉"、动作结束不还原这类不可逆状态。
- **量"单个动作/参数本身的行为"，去干净试验台，不要在跑着的宠物身上量**：
  `dsh-live2d-pet-desktop/tools/motion-lab/` + `tools/lab.mjs`（原始 `.moc3` + 原始
  `motion3.json`，自己解析曲线、自己推进时间，**无插件任何一层**）。
  在宠物身上量会被会话相位、槽位定格、**保姿势录像回放**、面板遮挡一起污染 ——
  我在"自拍不抬手"上为此连错四轮。细节见 skill：verification-signals。
- **含中文的文件绝不用 PowerShell 读改写**（`Get-Content` / `Set-Content` / `-replace` 全算）：
  它按 ANSI/GBK 读、按 UTF-8 写，**会把中文注释与中文字符串数据一起毁掉**，而且毁完还能编译
  通过（字符串变成 `\u{fffd}` 才报错，早一步只是显示成乱码）。改文件只用 write/edit 工具；
  真被毁了用 `dsh-live2d-pet-desktop/tools/repair-encoding.mjs` 试着逆转，逆转不了就重写。
  （2026-09 为改一个测试断言踩过：一次往返毁掉 `catalog.rs` 117 行，最后整文件重写。）
- **内联 JS 永远不要经 PowerShell 传**：`node -e "…"` 里的引号、`||`、`\d`、反引号会被
  PowerShell 先解析一遍，症状是 `Missing argument`/`Unexpected token`/脚本被吃掉半截。
  要跑脚本就**写成 `.mjs` 文件**（edit/write 工具），再 `node 文件`。
  同理：**不要用 PowerShell 手拼服务进程的命令行** —— 见下面那条。
- **重启 DSH 只走 `dsh-live2d-pet-desktop/tools/restart-dsh.mjs`**：它把参数当**数组**传给
  `spawn`（不经 shell 拼接），起来后自证 `/api/live2d-pet/catalog` 是 200。
  我手拼过一次 `Start-Process -ArgumentList`，`--profile web` 被吃成 `--profile`
  （profile 退回 minimal）⇒ **插件全没加载，页面变成 "Failed to load plugins"**。
- **提交前跑 `node dsh-live2d-pet-desktop/tools/check-client-tdz.mjs`**：它能抓出
  "在声明之前引用 `const`"这类**加载期 TDZ**。这类错 `node --check` 看不出来（不是语法错），
  症状是整个插件 import 失败、页面白屏报 "Failed to load plugins"。
  （我踩过：`const SHARED_KEYS = { overrides: OVERRIDE_KEY }` 写在 `OVERRIDE_KEY` 声明之前。）

## 文档分工（别把 README 写成开发日志）

| 写什么 | 写哪儿 |
|---|---|
| 用户要用的（安装 / 怎么用 / 设置说明 / 槽位表 / 宠物契约 / 接口 / 许可） | `dsh-live2d-pet/README.md`，**精简** |
| 用户可见的**变化**（新功能、语义变更、升级注意） | `dsh-live2d-pet/CHANGELOG.md`（随包发布，市场/Release 读它） |
| 工程记录（踩坑、帧序、测量陷阱、验证写法、为什么这么改） | `.dsh/skills/<主题>/SKILL.md`，**按主题归位** |
| 项目的硬规则 + 本索引 | 这个 `AGENTS.md` |

判断标准：**"用户读完能不能用上"** —— 不能就是工程记录，进 skill。
外层 `README.md` 是门面（功能表 / 安装 / 更新日志指针），和内层对齐、不重复细节。

## skill 索引

- 写验证 driver、断言"某效果是否真的生效"时，调用 skill：verification-signals
- **量单个动作/参数的行为**（"这条曲线到底驱动哪块几何"、"这个动作本身怎么演"）时：
  先跑 `dsh-live2d-pet-desktop/tools/lab.mjs`（干净试验台，见下），再调用 skill：verification-signals
- 改 Cubism 参数读写、动作/表达式、模型加载路径时，调用 skill：cubism-engine
- 改槽位/池子/关系结构、摸鱼或相位的抽签逻辑、设置界面的池子编辑器、localStorage 存档时，调用 skill：pet-domain-model
- 用 CDP 驱动浏览器、做点击穿透、等待模型加载、做 A/B 变体、驱动设置界面时，调用 skill：browser-cdp
- 改 lib/client.js 的组件状态、加 useEffect/useCallback、出现"功能没反应但不报错"时，调用 skill：client-state
- 改插件行为需同步文档，或要跑验证 / 提交前检查 / 发版 / 重启服务时，调用 skill：docs-and-workflow
- 改 `dsh-live2d-pet-desktop/`（壳 / Rust 宿主半区 / 单文件打包 / 托盘 / 透明与穿透）时，调用 skill：desktop-shell

### 干净试验台（量动作/参数只在这里量）

```bash
cd dsh-live2d-pet-desktop
node tools/lab.mjs actions                    # 每个动作：phone 参数随时间 + 位移最大的 drawable
node tools/lab.mjs param phone5 -10 10        # 把某参数推满量程，看它驱动哪块几何
node tools/lab.mjs seek Selfie 1.6            # 把某动作推进到某时刻，看参数与几何
node tools/lab.mjs raw "<一段 JS>"             # 直接在试验台页面里求值
```

它只加载**原始** `.moc3` + 原始 `motion3.json`，自己解析曲线、自己推进时间 ——
没有宠物插件的任何一层（会话相位 / 槽位定格 / 保姿势录像 / 面板遮挡全都不会来捣乱）。

## 桌面端的三条硬纪律

**① 宿主半区有两份实现**（网页端 `dsh-live2d-pet/lib/index.js`，桌面端
`dsh-live2d-pet-desktop/src-tauri/src/host/`）。改 `pet.json` 的字段语义、加新字段、
改资产路由形状时，**必须两边一起改**，然后跑 `dsh-live2d-pet-desktop/tools/probe-catalog.mjs`
（它拿两份真实宿主逐字段对拍）。这条是纪律，不是建议 —— 两边分叉的症状是"网页端正常、
桌面端少一段"，很难往实现差异上想。

**② 挂载模式（`--attach`）下，只有插件 API 转发给 DSH；页面的 `client.js` 仍然由壳自己
发** —— `host/http.rs` 里写死了 `path == "/plugins/dsh-pet-live2d/client.js"` →
`serve_embed("client.js")`，发的是**编译进 exe 的那一份**。

```
挂载模式的数据流：
  /api/live2d-pet/*                → 转发给 DSH（宿主的 JS 实现说了算）
  /plugins/dsh-pet-live2d/client.js → **exe 内嵌的那份**（不是 DSH 的！）
```

所以：**改了 `lib/client.js` 之后，只 F5 是没用的 —— 必须重建 exe**，
否则桌面端跑的还是上一次构建时的客户端，而 DSH 页面跑的是新的。
症状是"同一份代码、两个界面行为不一样"，非常容易误判成"桌面端有 bug"。
（2026-09 用户报"桌面的设置与 DSH 里的设置没有同步"，根因之一就是这条：
桌面端那份客户端里根本没有新写的同步代码。）

**③ macOS 那份产物只能在 macOS 上构建，而且本项目的会话里起不了 GUI**：

- mac 目标连 `cargo check --target aarch64-apple-darwin` 都过不去（依赖里有要编
  Objective-C 的 crate，本机没有 `cc`/macOS SDK）⇒ mac 代码唯一的编译器是 CI
  （`.github/workflows/desktop-mac.yml`：`cargo test --lib` + `build-package`）。
  所以 mac 相关改动**不要声称本地验过**。
- **在 DSH 会话里启动桌宠，一定失败**：`Failed to setup app: ... 拒绝访问 (os error 5)`
  （建窗/建 WebView2 环境被拒）。这不是构建坏了 —— **已发布的 3.0.1 exe 在同一环境里
  一模一样地失败**（对照实验做过）。想验 GUI 只能在真实交互会话里双击，或让用户跑。
- 因此：桌面端的 GUI 行为（透明 / 穿透 / 托盘 / 窗口）**改动后必须由人在真机确认**；
  能自动验的只有宿主机半区（`probe-catalog.mjs` 对拍）、单元测试、以及进程外读口。

## 设置的存储纪律

两个界面**不是同一个 origin**（桌面端在 `http://127.0.0.1:<壳的随机端口>`，DSH 在
`http://127.0.0.1:3080`），浏览器按 origin 隔离 `localStorage` —— **任何"应该跨窗口一致"
的状态都不能只放 localStorage**，否则表现就是"两边设置不同步"，而根因是"根本没有共享存储"。

规矩：

| 哪类状态 | 放哪 |
|---|---|
| 跨窗口该一致的（可调项 / 相位池子覆盖 + 开关 / 装扮） | `%DSH_HOME%\pet-settings.json`（`lib/settings.js` + `GET\|POST /api/live2d-pet/settings`） |
| 每个窗口各不相同的（位置、大小） | `localStorage`（各窗口各一份才对） |
| "谁在管这只宠物" | `%DSH_HOME%\pet-desktop.json`（`lib/display.js`，Rust 侧 `host/display.rs` 逐字对应） |

新增跨窗口状态的步骤：`settings.js` 加键 → 路由透传（`buildRoutes` 已经带上）→
客户端 `persistShared({…})` 写、启动 + 每 3 秒轮询读 → 跑
`tools/probe-cross-origin-sync.mjs`。

