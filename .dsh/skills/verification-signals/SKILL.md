---
name: verification-signals
description: >
  视觉验证必须读引擎在帧内写入的参数值，禁止像素比对/哈希比对和只打印不断言的 driver。
whenToUse: >
  写验证 driver、断言某个效果（表情、动作、参数叠加）是否真的生效时
---

# 验证：用确定性信号，不要用像素

**这条是踩了最多次的坑，优先级最高。**

给一只**一直在呼吸眨眼**的宠物做视觉验证时，下面两种方法都是无效的：

| 方法 | 表面结果 | 为什么无效 |
|---|---|---|
| 冻结 rAF + 截图逐像素比对 | 每格 0.00% | 冻结 `requestAnimationFrame` 并不能可靠停住 Pixi ticker，后续每格都在读同一张陈旧帧 |
| 比对 canvas 哈希 | `changed: true` | 任意两帧都不会逐字节相同，**信号恒为真**，等于没测 |

历史上因此对同一个问题给出过两次**互相矛盾**的结论，还写进了 commit message。

## 可靠做法：读引擎在帧内写进模型的参数值

```js
// 在 core.update 的末尾采样，此时表达式已经写完、还没被还原
const base = core.update.bind(core)
core.update = () => {
  base()
  window.__last = names.map((n) => core._model.parameters.values[ids.indexOf(n)])
}
```

确定性、不受动画相位影响。所有"某效果是否真的生效"的断言都应该落到这里。

## 不要写打印型 driver

断言必须以退出码收尾。曾经有个 driver 结尾无条件 `process.exit(0)`，只打印不断言，加上它唯一的信号恒为真 —— 等于从来没有测过任何东西。
