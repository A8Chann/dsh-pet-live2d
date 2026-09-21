---
name: docs-and-workflow
description: >
  改插件行为后的 README 同步要求，以及日常验证、提交前 suite、重启服务的工作流命令。
whenToUse: >
  改完插件行为要同步文档时，或需要跑日常验证 / 提交前 suite / 重启 dsh web 时
---

# 文档与工作流

## 文档同步

改动插件行为后，同步更新：

- `dsh-live2d-pet/README.md`
- `examples/ds-whale-girl/README.md`

## 常用命令

- 日常验证：`cd tools/browser-test && npm run dev -- <关键字>`（单个 driver 约 7 秒）
- 提交前：`npm run suite`（15 个 driver 并发，约 3 分钟）
- 改了 `lib/client.js` 要重启 `dsh web` 才生效（bundle 不热重载）

## 并发下的已知不稳定

- `cdp-motion.mjs` 单独跑通过（~26s），6 并发时**状态全零**失败。
  症状值得注意：**不是超时，是参数真的全 0**——说明动作压根没启动，
  而不是启动了没等到。还没查到根因。
- 偶发 `ECONNRESET`（driver 与浏览器连接断开）是负载抖动，不是回归；重跑确认。
- 断言里**不要用固定 sleep 等异步后果**（SSE、React 渲染、防抖）。用轮询。
  踩过三次：相位回落的 1200ms 防抖、consecutive-tools 的 300ms、缓动的 70ms 采样。

## 测试环境的第一个开关：暂停摸鱼

`waitReady()` 现在会自动调 `window.__dshLive2dPet.setFidgetEnabled(false)`。

**原因**：摸鱼每 12–26 秒触发一次并重写槽位选择，而长 driver 跑的正是
"某个状态要保持不变"的断言——摸鱼会把状态从断言底下换掉。
表现为"并发挂、单独过"，有四个 driver 中过招，一度被当成真回归。

`setFidgetEnabled(false)` **只停自动的**；`fidgetNow()` 强制调用照常工作，
所以专门测摸鱼的 driver（cdp-head）不受影响。

加了这个开关之后，原本并发必挂的 cdp-exp / cdp-head / cdp-host-events 全过了。