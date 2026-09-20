---
name: browser-cdp
description: >
  CDP 驱动浏览器时的点击穿透、就绪等待与 A/B 变体生成规则。
whenToUse: >
  写 CDP driver、做点击穿透/剪影代理、等待模型加载、构造 A/B 变体对比时
---

# 浏览器 / CDP

- **`clip-path` 影响命中测试，`mask-image` 不影响。** 要让透明区域事件穿透、只留角色可点，只能用 `clip-path`（配合 `pointer-events: none` 的根节点 + 剪影代理层）。
- **不要用固定 sleep 等模型加载**：`title=done` 时模型和点击剪影**早就好了**，固定 3-4 秒是纯浪费（每个 driver 一份）。轮询真实条件（`ready.mjs` 的 `waitReady`）。
- **不要用磁盘上的"变体副本"做 A/B**：副本会过期，直接跑单个 driver 就会静默测旧代码。让测试服**按请求即时生成**变体。
