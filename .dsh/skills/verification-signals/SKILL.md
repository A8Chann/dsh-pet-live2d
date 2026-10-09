---
name: verification-signals
description: >
  视觉验证必须读引擎在帧内写入的参数值，禁止像素比对/哈希比对和只打印不断言的 driver。
whenToUse: >
  写验证 driver、断言某个效果（表情、动作、参数叠加）是否真的生效时
---

# 验证：用确定性信号，不要用像素

**这条是踩了最多次的坑，优先级最高。**

## 量单个动作/参数的行为，要去**干净试验台**，别在跑着的宠物上量

用户的原话：「**你得用无头浏览器起原始 live2d 测试动画，你不能直接改 pet 来测试动画，
因为 pet 会被会话动作覆盖动画**」。这一条我付出了很大代价才学会 —— 在宠物身上量到的读数
被这些层污染，而且每一层都能单独让结论反过来：

| 污染源 | 造成的假象 |
|---|---|
| 会话相位（`phase`） | 动作被顶掉，`currentGroup` 一直是 Idle |
| 槽位定格 + **保姿势录像回放** | 参数被每帧写回旧值，曲线看着"跑了但画面不动" |
| 我加的 `forceParams` / `pin` | 参数被钉住，连手机都打不开（拿它当产品功能是错的） |
| 面板没关 | 量到的是面板像素，不是她 |

**试验台**：`tools/motion-lab/index.html`（服务 + 无头 Edge，`tools/lab.mjs` 驱动）。
它只加载原始 `.moc3` + 原始 `motion3.json`，**自己解析曲线、自己推进时间**，
没有任何插件层。API：`stop()` / `seek(group, seconds)` / `setParams({id: v})` /
`params()` / `paramRange(id)` / `drawables()`。

写它时踩到的三件事（都记在这里免得再犯）：

1. **原始 `model3.json` 没有声明任何动作**（`FileReferences.Motions` 是空的）——
   文件映射要写死在试验台里（组名取自仓库那份 model3，文件对应原始目录里的中文名）。
2. **Core 只有 `update()`**，没有 `saveParameters()` / `loadParameters()`（那是 Framework 的）。
   直接写参数 + `update()` 就能重算几何 —— 先用一个"必然改变画面"的参数自检
   （`ParamAngleZ = 30` 会让顶点校验和跳 275），确认机制通了再去量别的。
3. **量程必须先读**（`paramRange`）：`phone4` 是 -10…10，拿 0→1 去试只走 5% 量程，
   量到"什么都没动"。

判"某参数驱动哪块几何"要用**顶点坐标/块级位移**，不要用"全模型顶点校验和" ——
`phone5` 只动 5 块小几何，校验和只差 0.04，看起来像"没动"。

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

## 瞬时效果必须**帧内逐帧**采样，外面读只能量到 0

"这一条也是踩了多次的"：`drawn(id)` 给的是**上一帧 update() 那一刻**的值，而**从外面**
（CDP，每几十毫秒一次）读，采到的是一堆离散点。`phone2`（抬手臂）的峰值 **0.545 只存在
4ms** —— 外面每 60ms 读一次，量到的全是 0，于是得出了"参数根本没动"的错误结论，白查两轮。

做法：把采样器**装进页面**，用 `requestAnimationFrame` 收每一帧：

```js
// 经 CDP 求值；注意用 awaitPromise，且**不要**在外面套 JSON.stringify（见下）
return new Promise(function (resolve) {
  const peak = {}, low = {};
  const started = performance.now();
  function tick() {
    for (const id of list) { const v = api.drawn(id); /* 记 peak / low */ }
    if (performance.now() - started < ms) requestAnimationFrame(tick);
    else resolve({ peak, low });
  }
  requestAnimationFrame(tick);
});
```

顺带三条"工具自己骗人"的坑（都是这一轮踩的）：

| 症状 | 原因 |
|---|---|
| 拿到 `undefined` / `{}` | `awaitPromise: true` 要的是**表达式本身**求值成 promise；外面套一层 `JSON.stringify(...)` 会立刻返回 `{}` |
| 页面里抛异常却只看得到 `undefined` | 只取 `message.result.result.value`；要同时读 `exceptionDetails` |
| 断言"12 秒后还是抬起"却红了 | 会话相位在那之前接管（`kind` 变 `phase`）是**合法覆盖**；判据要限定"她自己演的那一段" |

**判据要由"对象自己声明的清单"决定**，不要挑一个参数名盯死：量"自拍有没有举手"时，判据取
各动作 `motion3.json` 的 `Curves`（动作自己说它写哪些参数），而不是猜 `phone` ——
`phone` 是"手机在不在手里"，抬手臂的是 `phone2`，两回事。

## 断言"点得到"要断三层，只断一层必漏

点击这一条链上有三处会各自静默失败，而且**症状长得一模一样**（"点了没反应"）：

| 层 | 谁决定 | 怎么读 |
|---|---|---|
| DOM | `[data-hit]` 的 `clip-path` 盖不盖住那一点 | `elementFromPoint()` 返回谁 |
| "在不在她身上" | `hitsMask()` | 判定读口 |
| "演什么" | `hitsHead()` / `hitsTail()` 的三角面 | 判定读口 |

2026-09 摸尾巴那一串就是**每轮只断一层**，结论来回翻：

- **只断"存在只命中尾巴的点"** —— 它一直绿着，而用户点不到（16 块几何全算尾巴、86.6%
  同时算头，路由摸头优先）。**"存在某个点"不是"那个点能点"**，跟"有几何就该有命中"
  是同一类空洞断言。
- 补了行为断言（点尾鳍要给摸尾巴台词）之后，又发现取点用的过滤是 `hitsMask` ——
  于是把"在快照之外、判定却说在她身上"的点**全排除了**，去掉修复照样绿。
  改成先取"只算尾巴"的点、再要求 `hitsMaskStatic() === false`，才真正盯住那条桥。
- 中间还误读过三轮：`lastPress()` 是"上一次按住"留下的，**不比对时间戳就会把上一轮的
  答案当成这一轮的**（读数显示 `onTail=true`，其实是上一轮那次）。现在它带 `at`，
  断言里比新鲜度。
- 探针自己的时序也会伪造结论：**"找点"和"点击"分两次 CDP 往返**时，尾鳍在中间摆走了，
  按住时的几何已经不是选中那一个（读数自相矛盾：`onHead=true` 且 `onTail=false`）。
  最后把"取点 + 派发事件"合进**同一次页面求值**才稳。

**给"会动的东西"写点击断言，取点和点击之间不能有空档**；实在要分两步，就断"按住那一刻"
的读数（`lastPress`）并检查它新鲜。

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

## 验"宿主读得出来"，就用宿主那个函数（别照着文档再实现一遍）

插件在官方「插件」页上的标题 / 描述 / 图标，是宿主 `dsh-app-boot` 的 `readPluginMeta()`
读出来的（`dsh-app-boot/lib/index.js` 里 `readPluginMeta` 是**导出的**）。自己写一份
"读 package.json + 拼 data URL"的检查，只能证明"我和文档一致"，证明不了"宿主读得出来"
—— 而这类错的形态恰恰是宿主的校验规则（相对路径、包内、≤256 KiB、MIME 白名单）与
文档不一致的那几条。

```js
// tools/probe-plugin-page-meta.mjs 的做法
const entry = createRequire(join(INSTALL, 'package.json')).resolve('@deepseek-ai/dsh-app-boot')
const { readPluginMeta } = await import(pathToFileURL(entry).href)
const meta = readPluginMeta('dsh-pet-live2d', pathToFileURL(profilePackageJson).href)
// meta.title / meta.description 是 {en, zh} 本地化对象；meta.icon 是 data URL；失败时 meta.error
```

判据要点：

- **父基准取 profile 的 `package.json`**（`%DSH_HOME%\profiles\<p>\package.json`）——
  页面/清单查的正是"profile 这一层能不能解析到这个包"，不是"工作区里那个文件在不在"。
- 断言**图标 data URL 解码后与磁盘文件逐字节相同**，而不是只断言 `startsWith('data:')`。
- 断言标题**不等于包名** —— 标题回退成包名正是 "locale 没被读到" 的症状（`exports` 漏了
  `./locale/*.json`、或文件名不是语言 id）。
- `readPluginMeta` 走 Node 的 ESM 解析（`ModuleLoader.fromInternal()`），**在普通 `node`
  进程里跑得通**，所以这条检查不需要 DSH 在跑，也不需要浏览器。