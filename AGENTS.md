# DSH_Pet_Live2d 项目规则

给 DSH Web GUI 做 Live2D 桌宠插件（`dsh-live2d-pet/`）+ 配套验证工具（`tools/`）。
模型是 B站@氵六青 的 DS鲸鱼娘（Cubism 5，1 个 .moc3、8 组动作、44 个表情）。

## 核心规则

- 回复用用户的语言（中文）；代码注释、commit message 也用中文。
- 验证一律用**确定性信号**（读引擎在帧内写进模型的参数值），不要用截图逐像素/哈希比对；driver 必须以退出码收尾，不允许只打印不断言。
- 动引擎代码前先确认帧内写入顺序，避免参数"永远关不掉"、动作结束不还原这类不可逆状态。

## 文档分工（别把 README 写成开发日志）

| 写什么 | 写哪儿 |
|---|---|
| 用户要用的（安装 / 怎么用 / 设置说明 / 槽位表 / 宠物契约 / 接口 / 许可） | `dsh-live2d-pet/README.md`，**精简** |
| 用户可见的**变化**（新功能、语义变更、升级注意） | `dsh-live2d-pet/CHANGELOG.md`（随包发布，市场/Release 读它） |
| 工程记录（踩坑、帧序、测量陷阱、验证写法、为什么这么改） | `.dsh/skills/<主题>/SKILL.md`，**按主题归位** |
| 项目的硬规则 + 本索引 | 这个 `AGENTS.md` |

判断标准：**"用户读完能不能用上"** —— 不能就是工程记录，进 skill。
外层 `README.md` 是门面（功能表 / 安装 / 更新日志指针），和内层对齐、不重复细节。

## skill 索引

- 写验证 driver、断言"某效果是否真的生效"时，调用 skill：verification-signals
- 改 Cubism 参数读写、动作/表达式、模型加载路径时，调用 skill：cubism-engine
- 改槽位/池子/关系结构、摸鱼或相位的抽签逻辑、设置界面的池子编辑器、localStorage 存档时，调用 skill：pet-domain-model
- 用 CDP 驱动浏览器、做点击穿透、等待模型加载、做 A/B 变体、驱动设置界面时，调用 skill：browser-cdp
- 改 lib/client.js 的组件状态、加 useEffect/useCallback、出现"功能没反应但不报错"时，调用 skill：client-state
- 改插件行为需同步文档，或要跑验证 / 提交前检查 / 发版 / 重启服务时，调用 skill：docs-and-workflow
