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
