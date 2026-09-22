# dsh-pet-live2d

给 **DSH**（DeepSeek Harness）Web GUI 用的 **Live2D 桌宠插件**：一只可以拖动、跟着鼠标看、
点她会害羞、还会跟着会话状态换动作的桌宠。

自带 **DS鲸鱼娘**（8 组动作 + 44 个表情/道具），开箱即用。更新日志见 [CHANGELOG.md](CHANGELOG.md)。

![桌宠](docs/preview.png)

## 功能

- **拖动 / 缩放**：位置和大小记在 localStorage，重启还在
- **跟随鼠标**：视线和头部跟着指针，移开（或窗口失焦）自动回正
- **点击反应**：点**头部**才挥锤撒娇，点身上其它地方只出气泡
- **事件穿透**：只有角色剪影吃鼠标事件，方形画布的透明处**穿透**到底下的页面，不挡 DSH 的 UI
- **跟着会话走**：订阅 DSH 的真实事件（`tools/*` 等），思考/工具/等待/完成/出错换动作与表情，
  长任务持续播放对应动画
- **待机摸鱼**：静置一会儿自己演一段（不会演「点击」「出错」这类专属动作）
- **都会自己收尾**：动作、定格、表情到点全部回到初始待机，不会卡住
- **全都可配**：20 个互斥槽位（装扮 + 表情），每个槽位一张可增删、带权重的条目表，
  条目之间还能配「同时 / 前提」关系；会话相位是同一套池子机制

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

### 必须自备 Cubism Core

`live2dcubismcore.min.js` 是 Live2D 株式会社的**专有运行时**，不能随插件分发。
去 [Live2D 官网](https://www.live2d.com/sdk/cubism/) 下载 Cubism SDK for Web，把
`Core/live2dcubismcore.min.js` 放到 `%DSH_HOME%\pets\.runtime\live2dcubismcore.min.js`。

### 宠物：随包自带

插件包里就带着一只可用的宠物（`pets/ds-whale-girl/`，CC BY-NC-SA 4.0）。**第一次运行时
宿主半区会把它复制进 `%DSH_HOME%\pets\`**，所以装完插件、重启 `dsh web` 就能看见。
只在目标**不存在**时复制 —— 你自己改过或换过的宠物目录永远优先，不会被覆盖。

## 怎么用

- **右键点宠物** 呼出面板：「动作」「装扮」两个页签，底部是大小滑杆和「归位」。
  平时画面上没有常驻 UI。
- **改配置** 去 **DSH 设置页 → 桌宠**（面板只负责"点一下换个样子"）。

## 设置说明

### 摸鱼：每个槽位一张条目表

摸鱼 = 静置一会儿之后，宠物自己换个样子。**每个槽位各掷一次骰子**（不是"这次只动一两个"），
条目上的权重就是"多久动一次"。

- 一张表里的条目可以**增删**：`＋ 名字` 是虚线药丸，行尾 `×` 删掉。
  宠物给的那套只是**建议**，你加进来的运行时真的会抽到。
- 摸鱼默认盯**宠物声明的那几个槽位**（这只宠物是七个：右手 / 左手 / 情绪 / 脸红 / 嘴部 /
  眼部 / 自拍，写在 `pet.json` 的 `live2d.fidgetSlots` 里），其余槽位在卡片底部点一下就
  加进来（`＋ 槽位`）。
- **「默认」＝回到默认**（把这个槽位清空）。`默认 10 : 脸红 1` = 大约每 11 次摸鱼脸红一次、
  其余时间回到没有。想让某个槽位**完全不动**，把它的条目删光或权重归 0。

### 会话相位：同一套池子

每个会话相位（`thinking` / `tool` / `waiting` / `done` / `failed`）下面是"槽位 → 条目表"，
机制和摸鱼一样。相位表**一开始就列出全部相位**，显示的是**有效池子**：

| 行头标记 | 含义 | 那一行有什么 |
|---|---|---|
| 默认 | 你没改过，用的是宠物默认 | 没有 `×` |
| 已改过 | 你改过，用的是你的 | 有 `×` = 恢复默认 |

改动**只在真的编辑时才落盘**，所以"看一眼"不会留下覆盖 —— 以后宠物更新了默认值，
没改过的相位照样吃得到。

### 关系：同时（pairs）与前提（requires）

条目下面缩进那一层是**关系**，两种刻意用不同前缀：

| 关系 | 含义 | 例 |
|---|---|---|
| **同时** `pairs` | 抽中它 / 选了它就**一起点亮** | 喵喵手 → 贴纸 = 猫猫 |
| **前提** `requires` | 必须先处于那个状态才**播得出来** | 挤番茄酱 → 左手 = 蛋包饭 |

- 两者都能加能删（行尾 `×`，条目下面的 `＋ 关系` 里按「同时 / 前提」分组选目标）。
- **摸鱼抽签时前提是闸门**：前提不成立的条目不进池子。前提可能靠同一轮里别的槽位满足
  （挤番茄酱要蛋包饭），所以抽签会**抽到稳定为止**（最多三轮）。
- **手动点选时前提由插件补上**：点「自拍」会先把手机掏出来，跟点「挤番茄酱」会把蛋包饭
  端上来是同一套 —— 不会"点了没反应"。
- 关系跟着**选项**走（不是池子里的某一条）：同一个姿势在摸鱼表、相位池、右键面板里看到的
  是同一份关系，改一处三处一起变。

### 装扮：穿在身上的东西

眼镜 / 发饰 / 魔爪 / 巴菲（桌面摆设）/ 桌布 / 手机换色 这六个槽位是**装扮**，和"这一轮临时挑的
表情"不是一回事：

| 场景 | 临时表情 | 装扮 |
|---|---|---|
| 会话相位开始 / 结束 | 由相位接管，相位结束就撤掉 | **不动** |
| 点「归位」 | 清空 | **保留** |
| 重启 / 刷新页面 | 回到默认 | **从 localStorage 穿回来** |

## 这只宠物有什么

44 个表情归入 **20 个互斥槽位**（换过宠物 / 改过配置的话，以设置页和 `pet.json` 为准）。
分类依据是**模型作者在 cdi3 里自己写的分组和中文名**（例如 `ParamGroup29` 被作者命名为
「C款动作开关」，里面正好是一组互斥的手部状态），不是按文件名猜的。

| 槽位 | 不选 | 可选项 |
|---|---|---|
| 眼镜 | 无 | 圆眼镜 / 方眼镜 / 椭圆眼镜 / 墨镜 |
| 贴纸 | 无 | 猫猫 / 兔兔 / 蝴蝶结 |
| 发饰 | 戴着 | 摘掉发箍 / 单边马尾 |
| 桌布 | 白色 | 黑色 |
| 魔爪 | 无 | 粉魔爪 / 白魔爪 |
| 鲸鱼 | 无 | 头顶鲸 / 放桌上 |
| 桌面摆设 | 无 | 巴菲 |
| 右手 | 无 | 掏出手机 / 喵喵手 / 双手比耶 / 挤番茄酱 / 写本本 |
| 自拍 | 无 | 自拍 / 快速自拍 |
| 左手 | 无 | 撤回 / 画笔 / 橡皮 / 蛋包饭 |
| 眼部 | 默认 | 星星眼 / 爱心眼 / 呆呆眼 / 晕晕 / 阴暗 |
| 情绪 | 平静 | 开心兴奋 / 悲伤 / 大哭 / 生气 / 调皮 / 闭眼口水 / 吐魂 |
| 嘴部 | 闭嘴 | 吐舌 / 吹泡泡糖 |
| 符号 | 无 | 问号 / 感叹号 / 流汗 |
| 氛围：花花 | 无 | 情绪花花 |
| 氛围：心跳 | 无 | 心跳 |
| 氛围：冒爱心 | 无 | 冒爱心 |
| 脸红 | 否 | 脸红 |
| 其他 | 无 | 手机换色 |
| 点菜 | 无 | 点菜按下 |

**一个选项可以带多个表达式**（「白魔爪」= 桌面粉魔爪 + 魔爪换色），**选择常驻**（不会过几秒
自己消失；自动清理只留给"反应"和"会话相位"）。

## 做一只自己的宠物

宠物放在 `%DSH_HOME%\pets\<id>\`，最小结构：

```
%DSH_HOME%\pets\<id>\
  pet.json          # 清单（renderer: live2d）
  c_0120.model3.json
  model\            # .moc3 / physics3 / cdi3
  textures\         # 贴图
  motions\          # .motion3.json
  expressions\      # .exp3.json
  catalog.json      # 可选：动作/表情的中文名与分类
```

```jsonc
{
  "petManifestVersion": 2,
  "id": "ds-whale-girl",
  "displayName": "DS鲸鱼娘",
  "renderer": "live2d",
  "license": "...",
  "live2d": {
    "model": "c_0120.model3.json",   // 相对于本目录
    "scale": 1,                      // 在自适应缩放上乘算
    "translate": { "x": 0, "y": 0 },
    // 槽位：一个槽位 = 一个互斥组，`none` 是"不选"
    "expressionSlots": [
      { "id": "eyes", "label": "眼部", "none": "默认",
        "options": [{ "label": "爱心眼", "expressions": ["爱心眼"], "pairs": { "heart": "冒爱心" } }] }
    ],
    // 会话相位 -> 槽位 -> 选项（读成"每个槽位一条、权重 1"的池子）
    "looksByPhase": { "done": { "whale": "头顶鲸", "mood": "开心兴奋" } },
    // 摸鱼默认盯哪些槽位（用户还能再加；不写就是"手/情绪/脸红/嘴/眼"那五个兜底）
    "fidgetSlots": ["rhand", "lhand", "mood", "cheek", "mouth", "eyes", "selfie"],
    // 可选；模型自己表达不了的「作者意图」
    "motionOptions": {
      "OpenCase":   { "hold": true },
      "Selfie":     { "prepend": "OpenCase" },
      "SprayWater": { "preset": { "jingyu": 1 } }
    },
    "motionGuards": { "SprayWater": { "whale": ["头顶鲸", "放桌上"] } }
  }
}
```

- **动作和表情列表以 `.model3.json` 里声明的为准**，插件启动时从模型读出 —— 换模型 / 改模型
  文件立刻生效，不用改插件代码。
- `motionOptions`：`hold`（停在最后一帧）/ `persist`（定格且不自动放手）/ `prepend`（先播前置
  动作）/ `preset`（开播前把某些参数写死）。不写就是"播一次然后回待机"。
- `motionGuards`：动作的前提，形如"槽位 = 标签白名单"。**白名单形式没法自动满足，只能拦**
  （喷水要鲸鱼，而鲸鱼有"头顶"和"放桌上"两种）——所以"能自动补上"的前提请写在选项的
  `requires` 上（形如"槽位 = 某一个标签"）。
- 路径片段只允许 `[A-Za-z0-9._-]`，中文文件名会让整个宠物加载失败。

动作与表情的**语义**（定格 / 前置动作 / 参数还原 / 表情叠加）见 skill `cubism-engine`。

## 宿主 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/live2d-pet/catalog` | 已安装宠物 + 各自的动作/表情清单 + 运行时 URL |
| GET | `/api/live2d-pet/asset/<id>/<path>` | 只服务 `model3.json` **引用闭包**内的文件（白名单 Set 比对 + realpath 包含，`..` 永远匹配不上） |
| GET | `/api/live2d-pet/runtime/live2dcubismcore.min.js` | 用户自备的 Cubism Core |
| GET | `/api/live2d-pet/runtime/live2d-vendor.js` | 插件内置的 MIT vendor 分包（pixi.js + 引擎），按需懒加载 |

API 与资产路由默认只答本机回环请求。

## 架构与二次开发

```
dsh-live2d-pet/
  package.json          dsh.client.platform = web -> 双半区包
  cordis.patch.yml      bundle patch：插一行 live2d-pet
  lib/
    index.js            宿主半区：宠物发现 / 引用闭包资产路由 / 运行时分发
    client.js           浏览器半区：手写 __ModuleLoader__ 工厂，无构建步骤
    live2d-vendor.js    pixi.js + untitled-pixi-live2d-engine 的 IIFE（esbuild 产物）
  src/vendor-entry.ts   vendor 分包入口（npm run build:vendor 重新生成）
```

Vendor 分包**懒加载**：只有真正挂载宠物时才注入，页面首屏不为它买单。

```bash
npm install             # pixi.js / engine / esbuild
npm run build:vendor    # 改动 src/vendor-entry.ts 或升级依赖时
```

改完 `lib/client.js` **重启 `dsh web`**（bundle 不做热重载）。回归测试在仓库的
`tools/browser-test/`：无头 Edge + CDP，在真实 WebGL 里跑 16 个 driver 的完整契约。

```bash
cd ../../tools/browser-test && npm install && npm run suite
```

> **开发记录不在这个 README 里**：踩坑、测量陷阱、帧序、验证写法按主题放在仓库的
> `.dsh/skills/` 下（`cubism-engine` / `client-state` / `verification-signals` /
> `browser-cdp` / `docs-and-workflow`），入口见仓库根的 `AGENTS.md`。
> 用户可见的变化写 [CHANGELOG.md](CHANGELOG.md)。

### 排查

宠物根节点上挂着诊断读口（`window.__dshLive2dPet`），常用几个：`expressions()`（当前钉住的
表情）、`slotSelections()`（各槽位选了什么）、`drawn(id)`（这一帧真正写进模型的参数值）、
`fidgetTally()`（摸鱼抽签统计）、`effectiveRelations()` / `settingsOverrides()`（有效关系与
存档覆盖）、`ambientDebug()` / `keptPoseDebug()`（氛围回放与姿势保持的内部状态）。

## 许可

- 插件代码：MIT
- vendor 分包：pixi.js（MIT）+ untitled-pixi-live2d-engine（MIT），可随包分发
- Cubism Core：Live2D 专有，**用户自备，本插件不内置**
- DS鲸鱼娘模型：**CC BY-NC-SA 4.0**（署名 · **非商业** · 相同方式共享），见
  [`pets/ds-whale-girl/LICENSE`](pets/ds-whale-girl/LICENSE)。

  版权链：**上善无形**（鲸鱼娘角色原作，原创 OC「溟月」）→ **ZipZipPipe**（DeepSeek 女仆二创）
  → **氵六青**（本模型）。氵六青已授权本项目转载开源，但该授权**不解除基础版权**，
  所以 **NC / SA 依然有效**；商业使用需分别取得三人授权。完整说明见 [`../NOTICE.md`](../NOTICE.md)。
