---
name: cubism-engine
description: >
  Cubism 引擎的参数查找、帧内写入顺序、表达式管理器、资源 URL 解析与动作收尾/还原规则。
whenToUse: >
  改 Cubism 参数读写、叠加自定义参数、启停动作或表达式、加载模型资源（含 blob: / 相对路径）时
---

# Cubism / 引擎

- **参数按名字查必须走 `core._model.parameters.ids`**（纯字符串数组）。
  引擎包装层的 `getParameterIndex(string)` 拿 CubismId 对象比较，传字符串**永远 miss**。
- **每帧顺序**：`loadParameters()` → 动作写参数 → `saveParameters()` → 表达式写 → 算形变 → 绘制。
  **要叠加自己的参数，必须挂在 `saveParameters()` 之后。** 挂在 `loadParameters()` 之后会被这一帧的快照吃进基线，下一帧恢复时已经含了它、再叠一次，于是**永远关不掉**。
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