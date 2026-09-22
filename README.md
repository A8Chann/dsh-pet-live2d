# dsh-pet-live2d

给 **DSH**（DeepSeek Harness）Web GUI 用的 **Live2D 桌宠插件**：一只可以拖动、跟着鼠标看、
点她会害羞、还会跟着会话状态换动作的桌宠。

自带 **DS鲸鱼娘**（8 组动作 + 44 个表情/道具），开箱即用。

> **许可分两类**：**代码 MIT，美术资源 CC BY-NC-SA 4.0**。
> 鲸鱼娘角色形象原作是 **上善无形** 的原创 OC「溟月」，**ZipZipPipe** 做了 DeepSeek 女仆二创，
> **氵六青** 做了本仓库所用的 Live2D 模型。氵六青已授权本项目转载开源，
> 但**这不解除基础版权** —— **非商业（NC）与相同方式共享（SA）依然有效**。
> 详见 [NOTICE.md](NOTICE.md)。

![桌宠](dsh-live2d-pet/docs/preview.png)

## 特性

- **拖动 / 缩放**：位置和大小记在 localStorage，重启还在
- **跟随鼠标**：视线和头部跟着指针，移开自动回正
- **点击反应**：点**头部**才挥锤撒娇，点身上其它地方只出气泡
- **事件穿透**：只有角色剪影吃鼠标事件，方形画布的透明处**穿透**到底下页面（不挡 DSH 的 UI）
- **跟着会话走**：订阅 DSH 的真实事件（`tools/*` 等），思考/工具/完成/出错换动作与表情，
  长任务会**持续播放**对应动画
- **右键面板**：宠物身上点右键呼出全部功能（动作 / 装扮 / 大小 / 归位）；平时画面上没有
  常驻 UI，鼠标划过也不显示。面板跟随 DSH 的**浅色 / 深色主题**
- **待机摸鱼**：静置一会儿会随机自己演一段（不会演「点击」和「出错」的专属动作）
- **都会自己收尾**：动作、定格、表情到点全部自动回到初始待机，不会卡住
- **全都可配**：20 个互斥槽位（装扮 + 表情）、每个槽位一张条目表（可增删、带权重、
  条目之间还能配「同时 / 前提」关系），会话相位也是同一套池子机制
- **设置界面**：挂在 **DSH 设置页 → 桌宠** 那一节（卡片 / 药丸 / 权重条，浅色深色都能用）

## 怎么用

- **右键点宠物** 呼出面板：「动作」「装扮」两个页签，底部是大小滑杆和「归位」。平时画面上没有常驻 UI。
- **改配置**（摸鱼池 / 相位池 / 关系 / 手感）去 **DSH 设置页 → 桌宠**。
- 完整说明（设置怎么配、这只宠物有哪些槽位、宠物契约、HTTP 接口）见
  [`dsh-live2d-pet/README.md`](dsh-live2d-pet/README.md)。

## 更新日志

见 [dsh-live2d-pet/CHANGELOG.md](dsh-live2d-pet/CHANGELOG.md)。

## 安装

```bash
# 从 npm 装（推荐；插件和自带宠物一起下好）
dsh plugin --profile web add dsh-pet-live2d

# 或从仓库装（# 后面是 pnpm 的 path: 协议，注意那个斜杠）
dsh plugin --profile web add "github:A8Chann/dsh-pet-live2d#path:/dsh-live2d-pet"

# 或先克隆再装本地目录
git clone https://github.com/A8Chann/dsh-pet-live2d
dsh plugin --profile web add "link:./dsh-pet-live2d/dsh-live2d-pet"
```

### Cubism Core：不用手动装

`live2dcubismcore.min.js` 是 Live2D 株式会社的**专有运行时**，不能随插件分发 —— 但**你也不
用自己去找**：插件第一次用到它时，宿主半区会去 [Live2D 官方 CDN](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)
取一份（校验过再发出去），并**缓存到本地**：

```
%DSH_HOME%\pets\.runtime\live2dcubismcore.min.js
```

之后离线也能用。只有当这台机器**访问不了外网**时，才需要手动下载
[Cubism SDK for Web](https://www.live2d.com/sdk/cubism/)、把
`Core/live2dcubismcore.min.js` 放到上面那个路径。

### 宠物：随包自带，不用手动装

插件包里就带着一只可用的宠物（`dsh-live2d-pet/pets/ds-whale-girl/`，CC BY-NC-SA 4.0）。
**第一次运行时宿主半区会把它复制进 `%DSH_HOME%\pets\`**，所以装完插件、重启 `dsh web` 就能看见。

只在目标**不存在**时复制 —— 你自己改过或换过的宠物目录永远优先，不会被覆盖。
想手动来一遍也行：

```powershell
# Windows
Copy-Item -Recurse -Force dsh-live2d-pet\pets\ds-whale-girl "$env:USERPROFILE\.dsh\pets\"

# macOS / Linux
cp -R dsh-live2d-pet/pets/ds-whale-girl ~/.dsh/pets/
```
## 目录结构

```
dsh-live2d-pet/      插件包本身（这就是要装的东西）
  lib/                 宿主半区 + 浏览器半区 + vendor 分包
  src/                 vendor 分包入口（esbuild）
  docs/                截图
  pets/
    ds-whale-girl/      随包自带的宠物（首次运行自动复制进 %DSH_HOME%\pets）
tools/
  build-pet.mjs        模型源包 -> 可安装宠物包
  browser-test/        无头浏览器端到端回归测试
model-packs/
  DS鼠控版/             宠物构建的源模型包
local-assets/         本地草稿（不发布）
```

## 加一只宠物

宠物放在 `%DSH_HOME%\pets\<id>\`，最小结构是 `pet.json` + 一个 `*.model3.json` +
`model\ textures\ motions\ expressions\`（`catalog.json` 可选，只影响显示名）。

`pet.json` 里 `live2d.model` 指向 model3.json，插件启动时从模型里读出全部动作与表情，
所以**换模型不用改插件代码**。槽位 / 池子 / 相位 / 动作语义的完整契约见
[`dsh-live2d-pet/README.md`](dsh-live2d-pet/README.md#做一只自己的宠物)。

> ⚠️ 路径片段只允许 `[A-Za-z0-9._-]`，中文文件名会导致整个宠物加载失败。
> 需要的话用 `tools/build-pet.mjs` 转换。

## 开发

插件是**双半区包**，没有前端构建步骤：`lib/client.js` 是手写的 `__ModuleLoader__` 工厂，
改完直接生效（**重启 `dsh web`** 即可，bundle 不做热重载）。

> **工程记录不写在 README 里**：踩坑、帧序、测量陷阱、验证写法按主题放在
> [`.dsh/skills/`](.dsh/skills/)（`cubism-engine` / `pet-domain-model` / `client-state` /
> `verification-signals` / `browser-cdp` / `docs-and-workflow`），
> 硬规则与索引见 [`AGENTS.md`](AGENTS.md)。README 只写"用户读完能用上"的东西，
> 用户可见的变化写 [`CHANGELOG`](dsh-live2d-pet/CHANGELOG.md)。

只有 vendor 分包需要构建（改动 `src/vendor-entry.ts` 或升级依赖时）：

```bash
cd dsh-live2d-pet
npm install
npm run build:vendor
```

### 回归测试

`tools/browser-test/` 是一套无头 Edge + CDP 的端到端测试（16 个 driver），直接在真实 WebGL
里跑插件，覆盖状态机、点击剪影、注视、相位映射、渲染倍率、动作语义、装扮合成、
设置界面（含 DSH 设置页那一节）等契约。断言一律读**引擎在帧内写进模型的参数值**，
不做截图逐像素/哈希比对：

```bash
cd tools/browser-test
npm install          # 提供 React UMD
npm run suite        # 起测试服 -> 跑全部 driver -> 输出 PASS/FAIL 表
```

单个 driver 也可以直接跑（需要先手动起 `node server.mjs`）：

```bash
node server.mjs &    # 默认 8793
node cdp-motion.mjs
```

> 设置界面现在只挂在 DSH 设置页那一节里，所以 driver 用
> `window.__pluginSections["pet-settings"]` 把那一节渲染进一个探针容器
> （`#dsh-settings-probe`）再操作它，见 `cdp-gaze.mjs` 里的 `openSettings()`。

`drivers/` 下是开发过程中用过的一次性诊断脚本，留作参考，不在回归套件里。

## 许可

**两类内容，两套许可** —— 完整说明见 [**NOTICE.md**](NOTICE.md)。

| 内容 | 许可 |
|---|---|
| 插件代码、`tools/` | **MIT** — 见 [`LICENSE`](LICENSE) |
| `pixi.js` / `untitled-pixi-live2d-engine` | MIT（打包进 `lib/live2d-vendor.js`） |
| `dsh-live2d-pet/pets/`、`model-packs/` 里的模型与贴图 | **CC BY-NC-SA 4.0** — 署名 · **非商业** · 相同方式共享 |

| 版权所有人 | 内容 |
|---|---|
| **上善无形** | 鲸鱼娘角色形象原作，原创 OC「溟月」 |
| **ZipZipPipe** | DeepSeek 女仆鲸鱼娘二次设计 |
| **氵六青** | 本仓库所用 Live2D 模型 |

⚠️ **可以**分享、改编；**必须**署名、**不得商用**、改编后须以同一协议分发。
商业使用需**分别**取得上述所有人的授权 —— 氵六青同意转载**不等于**可以商用。
- Live2D Cubism Core：专有软件，不在本仓库内；插件会在缺失时从 Live2D 官方 CDN 取一份并缓存到本地。
