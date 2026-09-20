# dsh-pet-live2d

给 **DSH**（DeepSeek Harness）Web GUI 用的 **Live2D 桌宠插件**：一只可以拖动、跟着鼠标看、
点她会害羞、还会跟着会话状态换动作的桌宠。

自带 **DS鲸鱼娘**（8 组动作 + 44 个表情/道具），开箱即用。

> **模型授权**：DS鲸鱼娘 由 B站@氵六青（[11272072](https://space.bilibili.com/11272072)）制作，
> **无偿分享**，已获作者转载授权。允许商用直播、自印物料；**禁止盗用与出售**。
> 模型版权归原作者，与本仓库的 MIT 插件许可无关。详见[许可](#许可)。

![桌宠](dsh-live2d-pet/docs/preview.png)

## 特性

- **拖动 / 缩放**：位置和大小记在 localStorage，重启还在
- **跟随鼠标**：视线和头部跟着指针，移开自动回正
- **点击反应**：只有点在**角色轮廓**上才算数（从渲染结果的 alpha 通道提取剪影），
  空白画布不响应
- **跟着会话走**：订阅 DSH 的会话事件，思考/工具/完成/出错切换不同动作与表情
- **面板**：列出模型声明的全部动作与表情，随时手动触发
- **待机摸鱼**：静置一会儿会随机自己演一段

## 安装

```bash
# 从仓库装（路径写法是 pnpm 的 #path: 协议，注意开头的斜杠）
dsh plugin --profile web add "github:A8Chann/dsh-pet-live2d#path:/dsh-live2d-pet"

# 或先克隆再装本地目录
git clone https://github.com/A8Chann/dsh-pet-live2d
dsh plugin --profile web add "link:./dsh-pet-live2d/dsh-live2d-pet"
```

### 必须自备 Cubism Core

`live2dcubismcore.min.js` 是 Live2D 株式会社的**专有运行时**，不能随插件分发。
去 [Live2D 官网](https://www.live2d.com/sdk/cubism/) 下载 Cubism SDK for Web，
把 `Core/live2dcubismcore.min.js` 放到：

```
%DSH_HOME%\pets\.runtime\live2dcubismcore.min.js
```

### 装上自带宠物

```powershell
# Windows
Copy-Item -Recurse -Force examples\ds-whale-girl "$env:USERPROFILE\.dsh\pets\"

# macOS / Linux
cp -R examples/ds-whale-girl ~/.dsh/pets/
```

然后重启 `dsh web`。

## 目录结构

```
dsh-live2d-pet/      插件包本身（这就是要装的东西）
  lib/                 宿主半区 + 浏览器半区 + vendor 分包
  src/                 vendor 分包入口（esbuild）
  docs/                截图
examples/
  ds-whale-girl/       可直接使用的宠物（复制进 %DSH_HOME%\pets 即可）
tools/
  build-pet.mjs        模型源包 -> 可安装宠物包
  browser-test/        无头浏览器端到端回归测试
model-packs/
  DS鼠控版/             宠物构建的源模型包
local-assets/         本地草稿（不发布）
```

## 加一只宠物

宠物放在 `%DSH_HOME%\pets\<id>\`，最小的样子：

```
%DSH_HOME%\pets\my-pet\
  pet.json            # 必需：renderer 必须是 "live2d"
  my.model3.json      # 入口模型
  model\  textures\  motions\  expressions\
  catalog.json        # 可选：中文显示名与分类
```

`pet.json` 里 `live2d.model` 指向 model3.json，插件启动时从模型里读出全部动作与表情，
所以**换模型不用改插件代码**。完整契约、动作语义（定格 / 前置动作 / 参数还原）见
[`dsh-live2d-pet/README.md`](dsh-live2d-pet/README.md)。

> ⚠️ 路径片段只允许 `[A-Za-z0-9._-]`，中文文件名会导致整个宠物加载失败。
> 需要的话用 `tools/build-pet.mjs` 转换。

## 开发

插件是**双半区包**，没有前端构建步骤：`lib/client.js` 是手写的 `__ModuleLoader__` 工厂，
改完直接生效（**重启 `dsh web`** 即可，bundle 不做热重载）。

只有 vendor 分包需要构建（改动 `src/vendor-entry.ts` 或升级依赖时）：

```bash
cd dsh-live2d-pet
npm install
npm run build:vendor
```

### 回归测试

`tools/browser-test/` 是一套无头 Edge + CDP 的端到端测试，直接在真实 WebGL 里跑插件，
覆盖状态机、点击剪影、注视、相位映射、渲染倍率、动作语义、表情面板等契约：

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

`drivers/` 下是开发过程中用过的一次性诊断脚本，留作参考，不在回归套件里。

## 许可

- 插件代码：**MIT** — 见 [`dsh-live2d-pet/LICENSE`](dsh-live2d-pet/LICENSE)
- 内置 `pixi.js` / `untitled-pixi-live2d-engine`：MIT
- DS鲸鱼娘模型：版权归 **B站@氵六青**，**无偿分享**，已获作者转载授权。
  允许商用直播、自印物料；**禁止盗用与出售**。
- Live2D Cubism Core：专有软件，需自行获取，不在本仓库内。
