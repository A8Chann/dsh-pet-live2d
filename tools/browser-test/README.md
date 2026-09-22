# browser-test

`dsh-live2d-pet` 的端到端回归测试：无头 Edge + CDP，在**真实 WebGL** 里加载插件，
从合成器截图和 DOM 契约上验证行为。

## 跑

```bash
npm install              # 提供 React UMD（server.mjs 从 node_modules 直接读）
npm run dev -- head      # 【日常用这个】只跑匹配的 driver，几十秒
npm run dev              # 同上，但常驻监听：改动 client.js / index.js / pet.json 自动重跑
npm run suite            # 【提交前】全部 14 个 driver，并发跑
```

耗时（本机 20 核）：

| 方式 | 时间 | 用途 |
|---|---|---|
| `node dev.mjs mask` | **7 秒** | 改一行看一眼 |
| `npm run suite`（6 并发） | **~2.9 分钟** | 提交前 |
| `npm run suite:serial` | ~7 分钟 | 排查套件自身的问题时 |

**为什么并发是安全的**：每个 driver 用独立的调试端口和独立的 Edge profile，
本来就互不干扰。真正会打架的只有「会话相位」——它存在测试服的进程里，
而 cdp-phase / cdp-v12 / cdp-exp / cdp-idle-return / cdp-host-events /
cdp-handoff2 这 6 个都会推它。所以现在**每个 driver 配一个自己的测试服**
（`PET_BASE` 注入），相位状态彻底隔离。曾用「共用一个服」跑并发，
结果 cdp-host-events 的相位被隔壁重置、cdp-idle-return 读到别人的相位而失败。

**没有固定 sleep**：每个 driver 曾经都带一个 `await sleep(3000)` 等模型加载。
实测发现模型和点击遮罩在 `title=done` 时**早就好了**，这 3-4 秒纯属白等
（整个套件因此白花约 30 秒，而且每加一个 driver 就多一份）。现在统一走
`ready.mjs` 的 `waitReady()` 轮询真实条件——条件已满足时它几乎不花时间，
机器慢的时候也不会像固定 sleep 那样直接失败。

`run-suite` 每次都会先重建 DBG 变体（`make-variant.mjs`）。它是 `client.js`
的副本，会悄悄过期——`cdp-motion` 就因为跑在缺少修复的旧副本上失败过一次。

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

## 已知偶发：并发跑到最后一个 driver 时 CDP 阻塞

症状是那个 driver **CPU 停在 0.0x 秒、十几分钟不退出**（不是断言失败，也不是超时）。
已遇到两次（`cdp-idle-return`、`cdp-bubble`），两次都**单独重跑即过**（34s）。

```powershell
# 判断：看那个 driver 进程的 CPU，几秒钟不涨就是卡住了
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*cdp-*.mjs' } | Select-Object ProcessId, CommandLine
```

处理：杀掉这次 run（**别用 `dev.mjs` 不带 `--once`** —— 它是常驻监听模式，被 kill
之后会留下测试服和一批 Edge），清掉残留的测试浏览器再单独跑：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*browser-test*' } |
  ForEach-Object { taskkill /F /PID $_.ProcessId }
node run-suite.mjs --jobs 1 <关键字>
```

**只杀 `--user-data-dir` 落在 `browser-test` 里的那些** —— 用户自己的浏览器
（`...\Microsoft\Edge\User Data`）不能碰。

## 为什么是裸 CDP

```js
// Pixi 的 canvas 用 toDataURL / drawImage(webgl) 读回来都不可靠：
// GPU readback 不是同步的，且 preserveDrawingBuffer 默认为关。
// 从合成器截图（Page.captureScreenshot）才是可信信号。
```

同理，`Page.captureScreenshot` 的 `clip` 必须显式传 `scale: 1`，否则在高 DPI
下会拿到缩放过的图，像素断言全部失真。
