# dsh-pet-live2d

**给 DSH（DeepSeek Harness）Web GUI 用的 Live2D 桌宠插件** —— 一只可以拖动、跟着鼠标看、点她会害羞、
还会跟着会话状态换动作与表情的桌宠。自带 **DS鲸鱼娘**（8 组动作 + 44 个表情/道具），装完即用。

<p align="center">
  <img src="dsh-live2d-pet/docs/banner.png" alt="大肥鱼 pet-live2d —— Give your AI agent a face." width="100%">
</p>

<p align="center">
  <a href="https://github.com/A8Chann/dsh-pet-live2d/releases"><img src="https://img.shields.io/github/v/release/A8Chann/dsh-pet-live2d?style=flat-square&amp;label=release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/dsh-pet-live2d"><img src="https://img.shields.io/npm/v/dsh-pet-live2d?style=flat-square&amp;label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pet-live2d"><img src="https://img.shields.io/npm/dm/dsh-pet-live2d?style=flat-square&amp;label=downloads" alt="downloads"></a>
  <a href="https://github.com/A8Chann/dsh-pet-live2d/stargazers"><img src="https://img.shields.io/github/stars/A8Chann/dsh-pet-live2d?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/A8Chann/dsh-pet-live2d/forks"><img src="https://img.shields.io/github/forks/A8Chann/dsh-pet-live2d?style=flat-square" alt="Forks"></a>
  <a href="https://dshfind.com/zh/plugins/A8Chann/dsh-pet-live2d?ref=badge"><img src="https://dshfind.com/api/badge/A8Chann/dsh-pet-live2d?lang=zh" alt="dshfind"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-4c6ef5?style=flat-square" alt="DSH">
  <img src="https://img.shields.io/badge/platform-Web%20GUI-8a2be2?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/Live2D-Cubism%205-ff69b4?style=flat-square" alt="Cubism 5">
  <a href="NOTICE.md"><img src="https://img.shields.io/badge/license-MIT%20%2B%20CC%20BY--NC--SA%204.0-2ea44f?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/github/last-commit/A8Chann/dsh-pet-live2d?style=flat-square" alt="Last commit">
</p>

<p align="center">
  <strong>拖动定位 · 视线跟随 · 摸头互动 · 会话相位 · 右键换装 · 事件穿透</strong><br>
  <em>20 个互斥槽位 · 摸鱼随机演出 · 双半区插件，装完即用</em>
</p>

<div align="center">

[是什么](#是什么) · [快速上手](#快速上手) · [怎么玩](#怎么玩) · [跟着会话走](#跟着会话走) · [设置](#设置) · [加一只宠物](#加一只宠物) · [目录结构](#目录结构) · [开发与验证](#开发与验证) · [常见问题](#常见问题) · [交流群](#交流群) · [许可](#许可)

</div>

## 是什么

DSH 的 Web GUI 负责对话，而 **dsh-pet-live2d 是挂在这块界面上的一只桌宠**：她住在页面右下角，能拖、能缩、
跟着鼠标看，点她会有反应。更有意思的是她**订阅 DSH 的真实事件**（工具调用、审批请求、子代理、轮次结束……），
于是「在想」「在跑工具」「在等你批准」「出错了」这些状态会变成她的动作、表情和台词 —— 不用盯着日志看进度。

| 能力 | 原生 DSH Web GUI | 装了 dsh-pet-live2d |
|---|---|---|
| 界面陪伴 | 无 | 桌宠常驻页面，可拖动 / 缩放，位置和大小记在 localStorage |
| 状态可视化 | 文字与状态点 | 8 个会话相位，各有一套动作 + 表情 + 台词，长任务持续播放 |
| 互动 | 无 | 摸头 / 摸尾巴 / 绕着转圈都有反应，按模型的三角面判定，不是方框 |
| 换装 | 无 | 20 个互斥槽位、44 个表情/道具，右键面板现场换，装扮跨会话保留 |
| 挡不挡 UI | — | 只有角色剪影吃鼠标事件，方形画布的透明处**穿透**到底下页面 |
| 打扰程度 | — | 静置才会自己演一段；平时画面上**没有任何常驻 UI**，鼠标划过也不显示 |

> 另有**桌面端**（[`dsh-live2d-pet-desktop/`](dsh-live2d-pet-desktop/README.md)，Tauri 壳）：
> 把同一份宠物代码放进**透明置顶窗口**、逐像素穿透到壁纸。Windows x64 的单文件 exe
> 随插件包分发（装完在设置里选「桌面」）；macOS（Apple Silicon）的构建由 CI 产出，
> **尚未在真机验证** —— 平台支持与已知限制见它的 README。

## 快速上手

```bash
# 1. 从 npm 装（推荐：插件和自带宠物一起下好）
dsh plugin --profile web add dsh-pet-live2d

# 2. 或从仓库装（# 后面是 pnpm 的 path: 协议，注意那个斜杠）
dsh plugin --profile web add "github:A8Chann/dsh-pet-live2d#path:/dsh-live2d-pet"

# 3. 或先克隆再装本地目录
git clone https://github.com/A8Chann/dsh-pet-live2d
dsh plugin --profile web add "link:./dsh-pet-live2d/dsh-live2d-pet"
```

> 仓库根目录**没有** `package.json`：可安装的包在子目录 `dsh-live2d-pet/` 里，所以从 Git 装必须带
> `#path:/dsh-live2d-pet`。从 npm 装不用管这些。

**装完之后会发生什么：**

1. **宠物随包自带**。插件包里就带着那只鲸鱼娘，第一次运行时宿主半区把它复制进 `%DSH_HOME%\pets\`，
   重启 `dsh web` 就能看见。只在目标**不存在**时复制，或者内容与随包分发的那份**逐字节相同**时才同步升级 ——
   你自己改过的那份**一个字都不会动**。
2. **Cubism Core 不用手动装**。`live2dcubismcore.min.js` 是 Live2D 株式会社的专有运行时，不能随插件分发；
   插件第一次用到它时去 [Live2D 官方 CDN](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)
   取一份（校验过再发出去），缓存到 `%DSH_HOME%\pets\.runtime\`，之后离线也能用。
3. **重启 `dsh web`**。bundle 不做热重载，重启之后她就站在那儿了。

| 项目 | 要求 |
|---|---|
| DSH | `>= 0.1.5-rc.1`，装在 `web` profile 上 |
| 浏览器 | 支持 WebGL 的现代浏览器（无头 Edge / Chrome 也跑得动，见回归测试） |
| 操作系统 | 跟着 DSH 走：Windows / macOS / Linux 是同一套 Web 端代码 |
| 网络 | 只在第一次取 Cubism Core 时需要外网；取不到就按 FAQ 手动放一份 |

```bash
dsh plugin --profile web update dsh-pet-live2d   # 升级（宠物默认值会一起同步）
dsh plugin --profile web remove dsh-pet-live2d   # 卸载（%DSH_HOME%\pets\ 里的宠物不会被删）
```

## 怎么玩

- **拖动 / 缩放**：拖到哪就是哪，大小从 160px 到 760px（默认 300px，右键面板底部的滑杆调），
  两者都记在 localStorage，重启还在。
- **右键面板**：呼出「动作」「装扮」两个页签 + 大小滑杆 + 「归位」。面板跟随 DSH 的浅色 / 深色主题。
- **跟着鼠标看**：视线和头部跟着指针走，移开（或窗口失焦）自动回正。
- **点击反应**：点**头部**才挥锤撒娇，点身上其它地方只出气泡 —— 判定读的是模型自己的几何
  （当前帧变形后的三角面 + 作者在 cdi3 里写的部件名），不是画出来的区域。
- **事件穿透**：只有角色剪影吃鼠标事件，方形画布的透明处穿到底下的页面，不挡 DSH 的 UI。
- **都会自己收尾**：动作、定格、表情到点全部回到初始待机，不会卡住。
- **待机摸鱼**：静置一会儿会自己随机演一段（不会演「点击」「出错」这类专属动作）。

| 互动 | 怎么触发 | 默认反应 |
|---|---|---|
| 摸头 | 点在**头部**（含头发、耳朵等 21 个部件） | 重锤出击 / 问号 / 星星眼 随机一个，不脸红 |
| 摸尾巴 | 点在**看得见的鲸鱼尾鳍**上（按贴图认那 5 块 drawable，可点区域跟着尾鳍摆动走） | 吐魂 / 问号 随机一个 |
| 转圈转晕 | 鼠标**绕着她转圈**（默认 2 圈、1.6 秒内） | 演「晕晕」 |

三个互动各自可开关，反应也能改；共用的三句台词在设置页的「气泡」卡里。

<p align="center">
  <img src="dsh-live2d-pet/docs/panel.jpg" alt="右键面板：动作 / 装扮两个页签，底部是大小滑杆与归位" width="620"><br>
  <sub>右键呼出面板：「动作 8」是模型自带的动作，「装扮 20」是 20 个互斥槽位；底部是大小滑杆和「归位」</sub>
</p>

<p align="center">
  <img src="dsh-live2d-pet/docs/looks.jpg" alt="六种造型：默认待机 / 爱心眼 / 星星眼吐舌 / 调皮猫猫手 / 重锤出击 / 挤番茄酱" width="620"><br>
  <sub>同样的她，换一套槽位就是另一个样子（44 个表情/道具里的一小部分）</sub>
</p>

## 跟着会话走

她订阅的是 DSH 的真实事件，不是猜的：

| 相位 | `thinking` | `tool` | `waiting` | `asking` | `helper` | `queued` | `done` | `failed` |
|---|---|---|---|---|---|---|---|---|
| 什么时候 | 模型在想 / 刚开工 | 在调工具 | 有操作等你批准 | 它问了你一句、等你回答 | 起了子代理 | 你发的话排队了 | 这一轮说完 | 出错了 |

- 事件来源：`agent/status`、`tools/pre-execute` 与 `tools/post-execute`、`approval/request`、
  `user-questions/request`、`subagent/start` 与 `subagent/end`、`agent/inbox/inserted`、
  `agent/turn-stopping`、`agent/error`。
- **相位是「接管」不是「叠加」**：相位点名的槽位按抽签换上，没点名的槽位让位收回；
  **装扮槽永远归你**；会话结束后你原来的样子回来（让位不是删除）。
- 每个相位的动作、表情、台词都能改，也能给每个槽位配权重和「同时 / 前提」关系。

## 设置

完整的配置都在 **DSH 设置页 → 桌宠** 那一节（卡片 / 药丸 / 权重条，浅色深色都能用）；
**侧栏「插件」→ 本插件** 的卡片上另有一节常用开关（气泡 / 提示音 / 三个互动 / 记住装扮）、
四根手感滑杆和「显示位置」，写的是同一份配置。

- **摸鱼**：每个槽位一张条目表，可增删、带权重 —— 权重就是「多久动一次」。
- **会话相位**：八个相位两列概览、点开一个再编辑台词与动作池；动作改动只在真的编辑时才落盘。
- **关系**：条目之间配「同时」（一起点亮）与「前提」（必须先处于那个状态才播得出来）。
- **互动**：摸头 / 摸尾巴 / 转圈各自的候选反应，行尾标明来历（宠物默认 / 内置默认 / 已改过）。
- **气泡**：会话台词在相位里改，互动等其他台词在气泡卡里改（一组用 `|` 分隔多个变体）；位置、停留时长及总开关也在气泡卡。
- **手感**：拖动、缩放、注视、点击、摸鱼开关等。
- **会话提示音**：独立卡片控制总开关和音量（拖滑杆即试听）；每相位可静音、**试听**或上传 MP3 / WAV / OGG（按宠物分别保存），移除上传即可回到宠物默认音符。

完整的设置说明、20 个槽位的选项表、宠物契约与 HTTP 接口见
[`dsh-live2d-pet/README.md`](dsh-live2d-pet/README.md)。

## 加一只宠物

宠物放在 `%DSH_HOME%\pets\<id>\`，最小结构是 `pet.json` + 一个 `*.model3.json` +
`model\`、`textures\`、`motions\`、`expressions\`（`catalog.json` 可选，只影响显示名）。

`pet.json` 里 `live2d.model` 指向 model3.json，插件启动时从模型里读出全部动作与表情，所以
**换模型不用改插件代码**。

> ⚠️ 路径片段只允许 `[A-Za-z0-9._-]`，中文文件名会让整个宠物加载失败 —— 用
> `tools/build-pet.mjs` 转换（仓库里随包的宠物就是 `model-packs/DS鼠控版` 过一遍它的产物）。

槽位 / 池子 / 相位 / 动作语义的完整契约见
[`dsh-live2d-pet/README.md#做一只自己的宠物`](dsh-live2d-pet/README.md#做一只自己的宠物)。

## 目录结构

```
dsh-live2d-pet/          插件包本身（就是要装的东西）
  lib/                     宿主半区 + 浏览器半区 + vendor 分包
  src/                     vendor 分包入口（esbuild）
  docs/                    图片（门面横幅 / 面板实拍 / 清晰度对比 / 交流群二维码）
  pets/
    ds-whale-girl/          随包自带的宠物（首次运行自动复制进 %DSH_HOME%\pets）
  CHANGELOG.md             用户可见的变化（市场页与 Release 读它）
dsh-live2d-pet-desktop/  桌面端壳（Tauri，M0）：同一份宠物代码放进透明置顶窗
tools/
  build-pet.mjs            模型源包 -> 可安装宠物包
  browser-test/            无头 Edge + CDP 的端到端回归测试
  make-release.mjs         按 CHANGELOG 生成 GitHub Release
  verify-npm-package.mjs   发布前校验 npm 包里的内容
  market-pr.mjs            给 awesome-dsh-plugin 提收录 PR
model-packs/               宠物构建用的源模型包（DS鼠控版）
.dsh/skills/               工程记录，按主题归位；硬规则与索引见 AGENTS.md
```

## 开发与验证

插件是**双半区包**，没有前端构建步骤：`lib/index.js` 是宿主半区（宠物发现 / 引用闭包资产路由 /
运行时分发），`lib/client.js` 是手写的 `__ModuleLoader__` 工厂，改完**重启 `dsh web`** 即可生效。
只有 vendor 分包需要构建（改动 `src/vendor-entry.ts`，或升级 pixi.js / 引擎时）：

```bash
cd dsh-live2d-pet
npm install
npm run build:vendor
```

回归测试在 `tools/browser-test/`：**4 个纯 Node 的测试 + 20 个无头 Edge + CDP 的 driver**，
在真实 WebGL 里跑插件，覆盖状态机、点击剪影、注视、相位映射、渲染倍率、动作语义、装扮合成、
设置界面等契约。断言一律读**引擎在帧内写进模型的参数值**，不做截图逐像素 / 哈希比对：

```bash
cd tools/browser-test
npm install          # 提供 React UMD
npm run suite        # 起测试服 -> 并发跑全部 driver -> 输出 PASS/FAIL 表
```

> 设置界面只挂在 DSH 设置页那一节里，所以 driver 用 `window.__pluginSections["pet-settings"]`
> 把那一节渲染进探针容器（`#dsh-settings-probe`）再操作它，见 `cdp-gaze.mjs` 里的 `openSettings()`。
> 官方「插件」页那一节同理，键是**包名**（`__pluginSections["dsh-pet-live2d"]`，容器
> `#plugin-page-probe`），见 `cdp-plugin-page.mjs`。宿主侧的展示元信息（标题 / 描述 / 图标）
> 由 `dsh-live2d-pet-desktop/tools/probe-plugin-page-meta.mjs` 用宿主自己的读取器验。
> `drivers/` 下是开发过程中用过的一次性诊断脚本，留作参考，不在回归套件里。

> **工程记录不写在 README 里**：踩坑、帧序、测量陷阱、验证写法按主题放在
> [`.dsh/skills/`](.dsh/skills/)（`cubism-engine` / `pet-domain-model` / `client-state` /
> `verification-signals` / `browser-cdp` / `docs-and-workflow`），硬规则与索引见
> [`AGENTS.md`](AGENTS.md)；用户可见的变化写 [`CHANGELOG`](dsh-live2d-pet/CHANGELOG.md)。

## 常见问题

| 问题 | 答案 |
|---|---|
| 装完重启了，没看见宠物？ | 看宿主日志里有没有 `[live2d-pet]`，并确认 `%DSH_HOME%\pets\ds-whale-girl\` 存在。目录被删干净之后重启会重装一份。 |
| 一直转圈 / 拿不到运行时？ | 这台机器访问不了 Live2D 官方 CDN。手动下载 [Cubism SDK for Web](https://www.live2d.com/sdk/cubism/)，把 `Core/live2dcubismcore.min.js` 放到 `%DSH_HOME%\pets\.runtime\`。 |
| 她挡住 DSH 的按钮了？ | 不会：只有剪影吃鼠标事件，透明处穿透到底下页面。真挡住了就拖走，或右键 →「归位」。 |
| 我改过 `pet.json`，升级会覆盖吗？ | 不会。同步按**内容指纹**判定，逐字节等于随包那份才更新；想拿回随包版本，删掉目录再重启。 |
| 自己做的宠物加载失败？ | 先查文件名：路径片段只允许 `[A-Za-z0-9._-]`，中文会让整个宠物加载不了；再照 `pet.json` 契约逐项对一遍。 |
| 支持别的模型吗？ | 支持，放 `%DSH_HOME%\pets\<id>\` 即可，动作与表情从 `*.model3.json` 读，插件代码不用改。 |
| 插件包为什么有好几 MB？ | 里面装着那只宠物（moc3 + 贴图 + 8 组动作 + 44 个表情）。想换成自己的，替换 `pets/` 就行。 |

## 交流群

<p align="center">
  <strong>🐟 大肥鱼 pet-live2d 交流群</strong><br>
  QQ 群号 <b>974641848</b><br>
  <sub>装不上、模型不对劲、想投稿自己的宠物 —— 都欢迎进群说</sub>
</p>

<p align="center">
  <img src="dsh-live2d-pet/docs/qq-group.png" alt="大肥鱼 pet-live2d 交流群二维码（群号 974641848）" width="240">
</p>

## 更新日志

用户可见的变化都写在 [`dsh-live2d-pet/CHANGELOG.md`](dsh-live2d-pet/CHANGELOG.md)
（市场页与 GitHub Release 读的就是它）。当前 **v2.3.4**：摸尾巴终于点得到了 ——
尾巴的判定从「名字里带尾/鳍/翅的 15 个部件」按贴图收窄到真正的尾鳍五块 drawable，
可点区域也跟着摆动走。

## 许可

**两类内容，两套许可** —— 完整说明见 [**NOTICE.md**](NOTICE.md)。

| 内容 | 许可 |
|---|---|
| 插件代码、`tools/` | **MIT** — 见 [`LICENSE`](LICENSE) |
| `pixi.js` / `untitled-pixi-live2d-engine` | MIT（打包进 `lib/live2d-vendor.js`） |
| `dsh-live2d-pet/pets/`、`model-packs/` 与 `docs/` 里的模型、贴图与截图 | **CC BY-NC-SA 4.0** — 署名 · **非商业** · 相同方式共享 |
| Live2D Cubism Core | Live2D 株式会社专有，**不在本仓库内**；缺失时插件从官方 CDN 取一份并缓存到本地 |

| 版权所有人 | 内容 |
|---|---|
| **上善无形** | 鲸鱼娘角色形象原作，原创 OC「溟月」 |
| **ZipZipPipe** | DeepSeek 女仆鲸鱼娘二次设计 |
| **氵六青** | 本仓库所用 Live2D 模型 |

⚠️ **可以**分享、改编；**必须**署名、**不得商用**、改编后须以同一协议分发。
商业使用需**分别**取得上述所有人的授权 —— 氵六青同意转载**不等于**可以商用。

<div align="center">

**喜欢这只桌宠？点个 Star，她会开心。** ⭐

[报告 Bug](https://github.com/A8Chann/dsh-pet-live2d/issues) · [请求功能](https://github.com/A8Chann/dsh-pet-live2d/issues) · [Releases](https://github.com/A8Chann/dsh-pet-live2d/releases) · [更新日志](dsh-live2d-pet/CHANGELOG.md) · [交流群](#交流群)

</div>
