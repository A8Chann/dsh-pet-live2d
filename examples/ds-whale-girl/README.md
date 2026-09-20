# DS鲸鱼娘 · Live2D 桌宠

DSh 桌宠（`@linxin666/dsh-pet`）的 Live2D 宠物包。

- 渲染器：`live2d`（Cubism 3/4）
- 动作组：Idle / Hammer / BubbleGum / SprayWater / OpenCase / Selfie / SelfieQuick / Ketchup
- 表情：44 个（情绪 20 / 配件 9 / 道具 15）
- 允许：商用直播、自印物料；**禁止任何形式的盗用与出售**
- 模型制作：B站 @氵六青（11272072）· 交流群 645169617

## 装扮槽位（状态切换分类）

44 个表情里有 19 个其实是**互斥的装扮开关**，不是可以自由叠加的表情。
它们全部由模型的「通用按键 / C款动作开关」参数驱动，一个参数开一块美术；
同时点亮两个不会「叠加」，只会打架。所以按**槽位**归类，每个槽位单选，
选新的自动摘掉旧的：

| 槽位 | 不选 | 可选项 | 驱动参数（cdi3 原始名） |
|---|---|---|---|
| 眼镜 | 无 | 圆眼镜 / 方眼镜 / 椭圆眼镜 / 墨镜 | `ParamCheek70` `ParamCheek72` `ParamCheek10` `ParamCheek71` |
| 贴纸 | 无 | 猫猫 / 兔兔 / 蝴蝶结 | `ParamCheek83` `ParamCheek82` `ParamCheek81` |
| 发饰 | 戴着 | 摘掉发箍 / 单边马尾 | `ParamCheek38`(=3) `fx1` |
| 桌布 | 不用 | 深色 | `cc2` |
| 魔爪 | 无 | 粉魔爪 / 白魔爪 | `mozhua` `mozhua2` |
| 桌面摆设 | 无 | 头顶鲸 / 放桌上 | `jingyu` `fangzhuoshang` |
| 手部 | 无 | 双手比耶 / 喵喵手 / 画笔 / 橡皮 / 蛋包饭 | `phone7` `maoshou` `bi` `pi` `danbaofan` |

分类依据是**模型作者自己在 cdi3 里写的分组和中文名**，不是按文件名猜的：
`ParamGroup29` 被作者命名为「C款动作开关（集中放置方便检查」，
里面正好是 `point`(点菜板) / `danbaofan`(蛋包饭) / `phone`(手机手) /
`phone7`(双手比耶) / `maoshou`(猫手) —— 一组互斥的手部状态。

剩下 25 个是**可以叠加的情绪表情**（脸红 + 汗 + 问号 是合理的漫画组合），
保持自由开关。

> **限制**：引擎的表情管理器一次只持有**一个**表情（`currentExpression`），
> 所以目前跨槽位不能同时生效（选了眼镜再选手部，眼镜会没了）。
> 同一槽位内单选、以及「选新的摘掉旧的」是准的。
> 跨槽位同时生效需要在引擎之外自己做参数合成，还没做。

槽位定义写在 `pet.json` 的 `live2d.expressionSlots`，换个宠物改这里就行。

## 前置：Cubism Core

Live2D 专有许可不允许再分发 Core 运行时，需要自行放置：

```
%DSH_HOME%\pets\.runtime\live2dcubismcore.min.js
```

从 Live2D 官方 Cubism SDK for Web 获取（`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`）。
