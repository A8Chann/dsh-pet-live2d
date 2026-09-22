---
name: cubism-engine
description: >
  Cubism 引擎的参数查找、帧内写入顺序、表达式管理器、资源 URL 解析与动作收尾/还原规则。
whenToUse: >
  改 Cubism 参数读写、叠加自定义参数、启停动作或表达式、加载模型资源（含 blob: / 相对路径）时
---

# Cubism / 引擎

## Cubism Core 怎么拿（别内置）

`live2dcubismcore.min.js` 是 Live2D 的专有运行时：**不要提交进仓库、不要随包分发**。
但也不需要让用户自己去找 —— **Live2D 自己托管了一份**，官方 SDK 文档就是让使用者在
页面里引这一行：

```
https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
```

带 `Access-Control-Allow-Origin: *`，实测 200 / `text/javascript` / 207155 字节。
现在的做法（`lib/index.js` 的 runtime 路由）：

1. 本地 `$DSH_HOME/pets/.runtime/live2dcubismcore.min.js` 有就用本地的（离线友好）；
2. 没有就**由宿主半区**去上面那个地址取一次 —— 浏览器不必出网，也不吃 CSP；
3. 取回来先校验（长度 + 含 `Live2DCubismCore` 符号，防被网关/登录页替换），
   再**缓存到 (1) 的路径**，之后离线也能用；
4. 两边都拿不到时返回 502，body 里带上该地址和落盘路径，别只丢一个 "missing"。

先"取不到就当 404"会让每个从市场装插件的人卡在同一个地方。

- **参数按名字查必须走 `core._model.parameters.ids`**（纯字符串数组）。
  引擎包装层的 `getParameterIndex(string)` 拿 CubismId 对象比较，传字符串**永远 miss**。
- **每帧顺序（实测，2026-09 用 3 个缝的采样钉死）**：一次 `internalModel.update()` 里
  `saveParameters()` / `update()` / `loadParameters()` **各一次，且 `loadParameters()` 是最后一个**。
  **要叠加自己的参数，必须挂在 `saveParameters()` 之后**（写进去 → `update()` 烘进模型 → 画出来），
  挂在它之前会被这一帧的快照吃进基线、下一帧再叠一次，于是**永远关不掉**。
- **帧外读到的是"基线"，不是"画面"。** 因为 `loadParameters()` 在帧尾，它把引擎自己的基线
  整片盖回 lived array。夹在两帧之间读 `core._model.parameters.values`，拿到的是**图层之前**的姿势：
  动作停了它还是 1、表情明明生效却读到 0。**要断言"画面里是什么"，只能用
  `window.__dshLive2dPet.drawn(id)`**（= 上一帧 `update()` 那一刻的值，控制器在钩子里存了一份）。
- **表达式管理器一次只持有一个 `currentExpression`**，在 `internalModel.motionManager.expressionManager`（**不是** `internalModel.expressionManager`）。要多个同时生效只能自己写参数。
- **引擎解析定义的 File 用 `new URL(file, modelUrl)`**：根相对路径可用，`blob:` 会被判成相对路径改写掉而加载不了。
- **本模型所有 motion3.json 都声明 `Loop: true`**，永远不触发 `motionFinish`；必须自己按 `Duration` 定时收尾，并以 `loop: false` 启动。
- 动作停下后**不会还原**它写过的参数；待机循环只驱动 247 个参数里的 89 个。一次性动作要在启动前快照、回待机时还原。

## 引擎的眨眼会被动作整个跳过

```js
const motionUpdated = this.updateMotions(coreModel, now)
...
motionUpdated || this.eyeBlink?.updateParameters?.(coreModel, dt)
```

**只要本帧有动作在驱动参数，眨眼就不执行。** 本模型所有 motion3 都声明
`Loop: true`，控制器又用 `loop:false` + 自己定时收尾、结束后立刻重播 Idle，
于是 `motionUpdated` 几乎永远为真 —— **引擎的眨眼一次都没跑过**。

修法：加载时 `options.eyeBlink = false`，自己按帧驱动
（闭合 70ms → 闭住 45ms → 张开 110ms，间隔 2.2–6.4s）。用**乘法**叠加而不是赋值：
钉住的表情可能已经眯着眼，眨眼要把它闭上；眼睛已经闭上时跳过，免得跟 wink 打架。

## 无条件 `stopAllMotions()` 会毁掉交叉淡入淡出

动作切换的过渡来自"新动作淡入 + **旧动作还在，淡出**"。先 `stopAllMotions()`
把旧动作瞬间清掉，就没有东西可以淡出 —— 每次切换都变成硬切。

只在**重播同一个 group+index** 时停（那是引擎自己会拒绝的唯一情况）。
判据：`blendCount() >= 2`（引擎里同时在混合的动作数）才是真的在过渡。

## 「只有待机在驱动」的参数，会在别的动作定格时塌回 0

这条坑了整整一轮，症状是**参数明明是对的、画面上却没有东西**。

模型里爱心的结构是这样的（cdi3 里作者自己分的组）：

| 组 | 参数 | 作用 |
|---|---|---|
| `ParamGroup20`「通用动画(循环)」 | `love`（爱心） | **开关**，0/1 |
| `ParamGroup16/18`「爱心左 / 爱心右」 | `j1..j57` | **每一颗爱心的位置**（58 个） |

而 `j*` **只有 `idle.motion3.json` 驱动**（89 条曲线里 56 条是 `j*`），

```
idle.motion3.json  | 曲线 89 | j*: 56 | love: 0
selfie / open-case / bubble-gum / ketchup / hammer | j*: 0 | love: 0
```

于是：`hold: true` 的动作（掏出手机 / 吹泡泡糖 / 自拍）**定格之后待机不再跑**，引擎就把
`j*` 放回基线 0 —— `love = 1`（开关开着）、`drawn("love") = 1`，**一颗爱心都看不见**。
实测：

```
静止（待机在跑）        j* = [1.0, 0.2, 0.9, 1.0, 1.0,  0.0, 0.7]   ← 在飘
掏出手机/吹泡泡糖/自拍  j* = [1.0, 0.0, 0.0, 0.0, 1.0,  0.0, 0.0]   ← 全塌
```

**修法**：把"待机驱动、而其它动作都不碰"的参数算出来（从各动作的参数表求差集，
别写死 `j*`），待机每帧记一份，换成别的动作时写回那一份。写在 `saveParameters` 缝里
就够 —— 引擎只覆盖**当前动作曲线里有的**参数（`love` 全程 1.0 就是证据），
所以不被动作驱动的参数，我们自己写了就能活到画面上。

**教训**：断言"某个效果生效"时，只读那个**开关**参数是不够的。像这种"开关 + 一堆
位置参数"的组合，开关对了、位置塌了，画面照样是空的 —— 这正是 verification-signals
里"不要写空洞成立的断言"的一个实例。

## 参数范围要按满量程测

`pointX/pointY` 范围是 **±30**。我第一次拿 **±1** 去试（3% 量程），
加上宠物一直在呼吸摆尾，看起来就像"这参数是死的"。按满量程重测才发现
手真的会动 —— **又是量程搞错**，跟像素/哈希那两次是同一类毛病。

驱动前先读 `parameters.minimumValues / maximumValues`，别猜。

## 可叠加的效果要注意"谁写哪个参数"

- 纯叠加的表情各写一个 `ParamCheekNN`，互不干扰，可以同时用。
- 复合表情会写眉毛/嘴的**同一个**参数，放一起必然打架。
- 有些效果**参数不冲突但画面冲突**：吐魂(`ParamCheek18`) 与 吹泡泡糖动作
  (`chuipaopao*`) 完全不相干，却是一张脸同时在吐魂和吹泡泡。
  需要显式的互斥声明，不能指望参数层面自动发现。

## 帧外写的参数，下一帧就被 loadParameters 抹掉

`restoreHeld()` 原来是"把快照直接写回参数"：

```js
const restoreHeld = () => { restore(held.saved) }   // 写 core._model.parameters.values
```

这是**帧外写**。下一帧 `loadParameters()` 会用 `saveParameters()` 的快照覆盖它，
而那个快照是**动作运行期间**存的、里面正是动作的值。于是还原被静默丢弃：
动作停了（`data-motion` 已经是 idle）、参数却还是动作的值。

**症状**：吹泡泡糖定格后切回"闭嘴"切不回去；而掏出手机会"看起来"能回去，
只是因为**待机循环本身会驱动 phone**，而 `chuipaopao` 不在待机驱动的
89 个参数里 —— 一个修好了、一个没有，其实是同一个 bug。

**修法**：把还原变成**每帧覆盖层**（跟表达式层同一个缝隙），
而不是一次性的写。并且**只把新动作真正驱动的参数交接出去**
（`for (const id of entry.params) delete overrides[id]`）——
注意 `playIdle()` 是**先 restoreHeld() 再 start()**，如果在 start 里把整张表清空，
等于把上一行刚装好的还原又抹掉了。

## 后半段：快照也必须读"画面"，否则第二轮必挂

改成每帧覆盖层之后，第一轮好了、**第二轮又关不掉**。因为动作启动时的
"还原快照"是**帧外读**的：

```js
const saved = snapshot(entry.params, preset)   // readParameter → 帧外基线
```

第二轮时覆盖层已经把画面压成 0，但帧外基线仍是冻结的 1 ——
快照忠实地记下 1，于是"还原"把嘴还原成**鼓着的**。同一类错，换了个位置。

**修法**：快照读 `readDrawn()`（钩子里在图层之后存下的那一份）而不是 `readParameter()`。

**两次都栽在同一个坑**：把"帧外读到的值"当成了"用户看到的值"。凡是要描述
画面状态的量，都要在帧内取样。