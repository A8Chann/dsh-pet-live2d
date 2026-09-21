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

- `cdp-motion.mjs` 很长、sleep 很多，**对负载敏感**：单独跑通过（~53s），
  6 并发时可能超时失败。它红了先单独跑一次再判断。
- 偶发 `ECONNRESET`（driver 与浏览器连接断开）是负载抖动，不是回归；
  重跑确认。
- 断言里**不要用固定 sleep 等异步后果**（SSE、React 渲染、防抖）。用轮询。
  踩过三次：相位回落的 1200ms 防抖、consecutive-tools 的 300ms、
  缓动的 70ms 采样。