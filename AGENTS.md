# DSH_Pet_Live2d 项目规则

给 DSH Web GUI 做 Live2D 桌宠插件（`dsh-live2d-pet/`）+ 配套验证工具（`tools/`）。
模型是 B站@氵六青 的 DS鲸鱼娘（Cubism 5，1 个 .moc3、8 组动作、44 个表情）。

## 核心规则

- 回复用用户的语言（中文）；代码注释、commit message 也用中文。
- 验证一律用**确定性信号**（读引擎在帧内写进模型的参数值），不要用截图逐像素/哈希比对；driver 必须以退出码收尾，不允许只打印不断言。
- 动引擎代码前先确认帧内写入顺序，避免参数"永远关不掉"、动作结束不还原这类不可逆状态。

## skill 索引

- 写验证 driver、断言"某效果是否真的生效"时，调用 skill：verification-signals
- 改 Cubism 参数读写、动作/表达式、模型加载路径时，调用 skill：cubism-engine
- 用 CDP 驱动浏览器、做点击穿透、等待模型加载、做 A/B 变体时，调用 skill：browser-cdp
- 改插件行为需同步文档，或要跑验证 / 提交前检查 / 重启服务时，调用 skill：docs-and-workflow
