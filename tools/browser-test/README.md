# browser-test

`dsh-live2d-pet` 的端到端回归测试：无头 Edge + CDP，在**真实 WebGL** 里加载插件，
从合成器截图和 DOM 契约上验证行为。

## 跑

```bash
npm install      # 提供 React UMD（server.mjs 从 node_modules 直接读）
npm run suite    # 自动起测试服，跑完自动关
```

指定单个 driver：

```bash
npm run suite -- cdp-motion cdp-exp     # 子串匹配
node server.mjs 8793                    # 或手动起服
node cdp-motion.mjs
```

输出每个契约的 PASS/FAIL 与耗时，失败时打印该 driver 的末尾输出。

## 覆盖的契约

见 `run-suite.mjs` 里的 `SUITE` 表 —— 每项对应一个用户可见的行为，
列在文件名旁边，跑一次就知道哪条坏了。

## 结构

| 文件 | 作用 |
|---|---|
| `paths.mjs` | 共享路径（全部相对本文件推导）、浏览器探测、BASE URL |
| `server.mjs` | 把插件的**真实路由表**挂在裸 node http 上，附一个假的 DSH 外壳页面 |
| `run-suite.mjs` | 起服 → 跑全部契约 → PASS/FAIL 表 |
| `cdp-*.mjs` | 回归套件（每个文件一个契约） |
| `drivers/` | 开发期一次性诊断脚本，留作参考，不在套件内 |
| `shots/` | 运行时产物（截图），已 gitignore |
| `.profiles/` | 每次运行的 Edge 用户目录，约 50 MB，已 gitignore |

## 为什么是裸 CDP

```js
// Pixi 的 canvas 用 toDataURL / drawImage(webgl) 读回来都不可靠：
// GPU readback 不是同步的，且 preserveDrawingBuffer 默认为关。
// 从合成器截图（Page.captureScreenshot）才是可信信号。
```

同理，`Page.captureScreenshot` 的 `clip` 必须显式传 `scale: 1`，否则在高 DPI
下会拿到缩放过的图，像素断言全部失真。
