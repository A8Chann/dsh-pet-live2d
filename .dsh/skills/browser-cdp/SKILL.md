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

## 点面板里的控件：**DOM 合成事件点不动，必须用 CDP 的 Input 事件**

这一条让我白查了四轮"自拍不抬手"：我一直用
`element.dispatchEvent(new PointerEvent('pointerdown', …))` 或 `element.click()` 去点
面板按钮，**React 的处理函数根本没被调用** —— 而我拿"点了没反应"当成了产品 bug。

症状有一个很好认的特征：**点完 `currentGroup` 一直是 `Idle`、什么都没发生**，
但按钮的 `data-on` 之类状态又显示"选中了"。

正确的做法是走**浏览器层面的输入事件**：

```js
await send('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
```

配套三个细节（缺一个就点偏/点空）：

1. **点之前先 `scrollIntoView({block:'center'})` 再重新取 `getBoundingClientRect()`** ——
   装扮页签有 20 个槽位、面板很高，先取的坐标在滚动后就是错的（我因此点到了「挤番茄酱」
   而不是「掏出手机」）。
2. 用 `document.elementFromPoint(cx, cy)` **自校验**"这个点上真的是它"，
   把 `isSelf` 一起返回，别默默点偏。
3. 右键开面板也是：`Input.dispatchMouseEvent` 的 `button: 'right'`、`buttons: 2`。

## 跨窗口状态要轮询，别指望 `storage` 事件

桌面端页面与 DSH 页面是**两个 origin**，`window.addEventListener('storage')`
**只在同源窗口之间触发**，跨 origin 永远收不到。所以"另一个窗口改了要跟着变"只能轮询
（现在是 3 秒一次，见 client.js 的 `pullShared`）。

顺带：**探测宿主可用性时不要把 404 记死**。桌面端页面如果在 DSH 还没带那条路由时先跑过一次，
就会把"宿主不可用"缓存下来、之后再也不问 —— 表现是"重启完 DSH 还是不同步"，
其实只要刷新一次页面。写这类探测要么每次重试、要么给个明确的"什么时候重试"。

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
- 官方「插件」页那一节（`__pluginSections["dsh-pet-live2d"]`，键是**包名**）用同样的挂法，
  探针容器换成 `#plugin-page-probe`、钩子前缀换成 `[data-pet-plugin-page]`；
  driver 是 `tools/browser-test/cdp-plugin-page.mjs`。

## 在 DSH 会话里**起不了无头浏览器**（2026-10 实测，别再花时间）

沙箱（workspace-write）里 headless Edge 起不来，报的是 Chromium 自己的 IPC：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : 拒绝访问。 (0x5)
ERROR:crashpad_client_win.cc:447] OpenProcess: 拒绝访问。 (0x5)
```

即 **Mojo 的命名管道被沙箱拦掉**（两种受限模式都拦）。症状是 `spawn` 后 CDP 端口永远
不应答、`fetch /json/version` 一直失败 —— 不是 driver 写错了。同一台机器上，
**DSH 会话里起不来的东西，普通终端里跑得好好的**。

推论：

- 浏览器类 driver（`tools/browser-test/*`）在这个环境里**跑不了**，套件运行器还会先在
  `startServer` 上撞 `spawn EPERM`（它用管道 stdio 抓服务器输出）。
- 因此本环境里能给的确定性信号只有：宿主的 `readPluginMeta`（见 verification-signals）、
  TDZ/语法检查、纯 node 测试（`test-*.mjs` / `*.test.mjs`）、以及**活页面的 inspect 读口**
  （`cordis_inspect_query` 的 Slots —— 它能证明"注册上了"，证明不了"画出来了"）。
- 真要在浏览器里验，得让**人在自己的浏览器**里刷新页面看（会话内的无头浏览器指望不上）。

## 页面的插件图会跟着文件变化重挂（DSH web 实测）

改完 `dsh-live2d-pet/lib/client.js` 之后**不用刷新页面**：页面的
`cordis_inspect_query`（client `Slots`）在下一次查询里就能看到新的注册
（`plugins.bundle.config` 的 occupant 从无到有，`registrant: live2d-pet`）。
`dsh-client-modules` 是按文件 `ctimeMs`/`size` 认版本的，变了就重挂整张插件图。

**但宿主半区（`lib/index.js`）仍然要重启 `dsh web`** —— 那是启动时 import 的。

⚠️ 桌面端是例外：壳发的是**编译进 exe 的那一份 `client.js`**（见 desktop-shell 那条），
所以桌面端页面里看到的永远是上次构建时的客户端。