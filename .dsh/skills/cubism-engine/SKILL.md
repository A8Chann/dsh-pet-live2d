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
