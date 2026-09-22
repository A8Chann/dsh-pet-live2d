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

## 点面板里的控件之前，先把面板打开

槽位按钮在 `[data-panel]` 里，**面板没开就查不到**。而
`document.querySelector(...)` 返回 `null` 时，一个 IIFE 形式的点击脚本会
**静默地什么都不做**，测试随后读到的是"没变化"，看起来像功能坏了。

同一个错误我犯了两次。写点击前先确认：

```js
await openPanel(ev)
await ev('...找到并点击「装扮」标签...')
await sleep(700)          // 让 React 渲染完
// 再去点 [data-slot="xxx"] 里的按钮
```

而且**要检查点击脚本的返回值**（`ok`/`no slot`/`no chip`）并断言，
否则"没点到"和"点了没效果"永远分不清。

## 面板改过之后记得同步槽位数

槽位/选项增删（例如把"掏出手机"独立成一个槽）会让多个 driver 里的
`slots === 16` 之类的硬编码断言同时变红。改 `pet.json` 的槽位结构后，
先全局搜一遍这类计数。

> 这条写过一次**还是漏了一个 driver**（cdp-merge），靠套件才发现 —— 别只搜你记得的那几个。

## 设置界面：挂进一个探针容器再操作

设置正文现在只活在 **DSH 设置页那一节**里（右键面板的「设置」页签 2.0.0 去掉了）。
driver 不用去翻设置页，直接把那一节渲染进自己的容器：

```js
const openSettings = async () => ev(`(() => {
  if (document.querySelector("#dsh-settings-probe")) return true;      // **幂等**
  const slot = (window.__pluginSections ?? {})["pet-settings"];
  if (!slot) return false;
  const host = document.createElement("div"); host.id = "dsh-settings-probe";
  document.body.appendChild(host);
  window.ReactDOM.createRoot(host).render(slot.render());
  return true })()`)
const probe = (selector) => "#dsh-settings-probe " + selector
```

两个坑：

- **挂载必须幂等**。同一份正文挂两次（两个同 id 容器）不报错，只会让所有
  `querySelectorAll` 的结果**翻倍** —— 相位槽位表、关系行都这么假红过。
- 两套作用域别写混：面板自己的钩子（`data-panel` / `data-tabs` / `data-slot` /
  `data-slot-option`）在 `[data-dsh-live2d-pet]` 下面；设置正文的钩子
  （`data-fidget-*` / `data-phase-*` / `data-relation*` / `data-pool*` / `data-input` …）
  在 `#dsh-settings-probe` 下面。