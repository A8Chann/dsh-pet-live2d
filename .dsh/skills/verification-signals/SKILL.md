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

## CSS 伪元素的计算样式**量不到**（Chromium CSSOM 的坑）

想断言"滑杆圆钮是不是 12px"这类**伪元素**外观时，别用 `getComputedStyle`：

```js
getComputedStyle(el, "::-webkit-slider-thumb").width   // → "366px"（！）
```

Chromium 的 CSSOM **不认识 webkit 伪元素**，传了不认识的伪元素会**静默退化成返回
元素自身的计算样式** —— 读回的 366px×18px 正是 input 自己的盒子，而且**一点报错都没有**。
拿它断言必然假红（我第一版就红在 `thumb: "366pxx18px"`，红得毫无道理）。

可行的量法（都在元素上，都精确）：

1. **元素级声明**真的命中：`getComputedStyle(el).webkitAppearance === "none"` ——
   证明那一整块规则匹配上了这个元素。
2. **设计 token 挂在元素上**，伪元素只负责引用它们：

   ```js
   sel + "{...;--slider-track:3px;--slider-thumb:12px}"
   sel + "::-webkit-slider-thumb{width:var(--slider-thumb);height:var(--slider-thumb);...}"
   ```

   于是 `getComputedStyle(el).getPropertyValue("--slider-thumb") === "12px"` 精确可断言，
   而且尺寸只有一个来源（顺带解决"margin-top 该是多少"这种派生值，用 calc）。
3. **伪元素规则确实引用了 token**：读浏览器解析后的 `cssRules[].cssText`。
   声明若有语法错会被浏览器丢掉，所以"读得到"就等于"浏览器接受了这条声明"。

**写伪元素断言前先花 30 秒确认它能量到**，不然量的是空气。

## 不要写打印型 driver

断言必须以退出码收尾。曾经有个 driver 结尾无条件 `process.exit(0)`，只打印不断言，加上它唯一的信号恒为真 —— 等于从来没有测过任何东西。

## 不要在外部采样"快事件" —— 让它自己计数

眨眼全程只有 ~225ms，而**一次 CDP 往返就 100ms+**。用轮询采 `blinkAmount()`
报"12 秒 0 次眨眼"，可独立探针同时测到 2 次 —— **测的是采样器，不是产品**。

正确做法：让客户端自己计数，测试只读计数器的差值。

```js
let blinkCount = 0            // 在 blink 开始处 ++
api.blinkCount = () => blinkCount
// 测试：读 before → 等 → 读 after → 断言 after - before >= 1
```

同理适用于任何持续时间短于采样间隔的东西（点击、闪一下的表情、一次性事件）。

## 轮询"期望值"，不要轮询"稳定"

等"值不再变化"会**锁存改动之前的值**。两个用例只差一个参数时
（`[1,1,0]` vs `[1,1,1]`），旧值看起来完全"稳定"，于是把真失败和假红混在一起。

```js
// 错：等到不动为止 —— 可能等来的是旧状态
if (stable >= 3) break
// 对：明确等到期望的结果，超时才返回最后一次读数
if (wanted.every(([k, v]) => at(now, k) === v)) return now
```

改成轮询期望值后，同一个 driver 从 32s 降到 14s **而且不再假红**。

## 小心"空洞成立"的断言

`pen !== previous || pen === null` 这种写法，在 `pen` 为 `null`（功能完全没生效）时
**恒为真、直接 PASS**。凡是"没有值"也能满足的断言，都等于没有断言。
写之前先问：**这个断言在功能完全没做的情况下会不会通过？**

## 读参数必须在帧内 —— 而且要在"写入那一刻"记

在帧外直接读参数会拿到**引擎已还原的静止值**，看起来像"没生效"。
更隐蔽的是：只在"该动的时候"记录，指针离开后**旧值会留着**，
读到的是上一次的状态。所以静止时也要显式记 0。

### 为什么会这样：帧序是 saveParameters → update → loadParameters

一次 `internalModel.update()` 里这三个各一次，**`loadParameters()` 是最后一个**。
所以帧与帧之间，`core._model.parameters.values` 里躺的是**引擎自己的基线**，
所有我们自己写的图层（表情 / 嘴 / 眨眼 / 扫动画 / 动作还原）都被抹掉了：

| 读法 | 拿到的是 |
|---|---|
| 帧外读 `values[i]` | 图层**之前**的姿势（动作停了它还是 1、表情生效了却是 0） |
| `core.update` 之后采样 | **这一帧真正画出去的值** ✔ |

**首选 `window.__dshLive2dPet.drawn(id)`** —— 控制器在钩子里把这一份存下来了，
不用每个 driver 自己包 `core.update`。老的包法（`cdp-exp` / `cdp-merge`）仍然有效。

这条是 2026-09 花了整整一轮才钉死的：同一个"吹泡泡糖切不回去"的现象，
两次都因为**量错地方**而得出错误结论。

## 模块作用域的 const 提前引用会被 try/catch 吞掉

把常量挪到「更靠前的位置」时容易漏掉一处引用：`const X` 在声明之前被函数体读到会抛
TDZ ReferenceError。如果那句恰好在 `try { ... } catch {}` 里（我们为了「无痕模式存不下也别崩」
包了一层），**它就变成一个静默的空操作** —— 表现是「开关点了、状态也存了，就是没生效」。

这次是 `applyFlag` 引用了 1000 行之后才声明的 `OUTFIT_KEY`。判据很直接：功能全绿只有那一条
红，而且红的是「副作用没发生」而不是「值不对」—— 先去看那句是不是踩在 TDZ 上。

## 测试自己的坑：先跑一次再读基线

`fidgetTally().poolSize` 这类诊断是**功能跑过之后才写上的**。拿它当基线之前要先触发一次
（`fidgetNow()` + sleep），否则读到的是 undefined，断言变成假红。
## 驱动 React 的受控输入：先改值再派发 input

想从 driver 里推动滑杆/文本框，直接 el.value = x 会被 React 忽略（它的 value tracker
认为值没变）。绕过 tracker 的标准写法：

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '0.5')
    el.dispatchEvent(new Event('input', { bubbles: true }))

而且别只断言「值变了」——**要断言行为跟着变了**：改完注视死区之后，同一个指针位置的
gazeTarget() 必须从「有值」变成 0。只验 UI 状态的话，改了没接上线照样绿。

## 状态切换要连做两轮

"还原/快照"这类逻辑第一轮经常是对的，**第二轮才炸**：第一轮快照记的是初始值，
第二轮的快照记的却是上一轮残留的、被污染的值。只在单轮里测永远看不出来。

`cdp-bubble.mjs` 因此把 吹泡泡糖 → 无 连做三轮，并且**同时断言两件事**：
画面值回到 0，以及新动作的快照记的是 0（而不是帧外基线）。只断言画面值的话，
"快照被污染成 1"这个中间状态在下一次快照前是看不出来的。

## 作者自己的数据文件就是规格

想知道"张嘴应该是什么样"，别对着小图猜 —— 去读 `selfie.motion3.json` 的
关键帧。我在小图上判断"负值 = 下巴掉下来"，放大后发现是**歪嘴**；
作者用的是正值。**跟作者对齐，别跟我的猜测对齐。**