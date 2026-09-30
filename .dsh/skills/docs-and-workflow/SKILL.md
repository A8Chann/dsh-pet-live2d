---
name: docs-and-workflow
description: >
  改插件行为后的 README 同步要求，以及日常验证、提交前 suite、重启服务的工作流命令。
whenToUse: >
  改完插件行为要同步文档时，或需要跑日常验证 / 提交前 suite / 重启 dsh web 时
---

# 文档与工作流

## 文档分工（2026-09 用户明确要求）

**别把插件 README 写成开发日志。** 曾经写到 700 行：版本演进、踩坑记录、测量陷阱全堆在
里面，用户直接说"你在这 README 写开发日志呢？？？"。分工是：

| 写什么 | 写哪儿 |
|---|---|
| 用户要用的（安装 / 怎么用 / 设置说明 / 槽位表 / 宠物契约 / HTTP 接口 / 许可） | `dsh-live2d-pet/README.md`，**精简** |
| 用户可见的**变化**（新功能、语义变更、升级注意） | `dsh-live2d-pet/CHANGELOG.md`（随包发布，插件市场/Release 都读它） |
| 工程记录（踩坑、帧序、测量陷阱、验证写法、为什么这么改） | `.dsh/skills/<主题>/SKILL.md` —— **按主题归位，别按时间堆** |
| 项目的硬规则 + skill 索引 | 仓库根的 `AGENTS.md` |

判断标准很简单：**"用户读完能不能用上"**。不能，就是工程记录，进 skill。

**CHANGELOG 同样要精炼**（2026-10-01 用户明确要求："changelog需要精炼"）。它给的是
**用户可见的变化**，不是事后报告 —— 每条 2–3 行：**症状 → 一句话原因 → 现在怎么用/怎么办**。
下面这些**一律不进 CHANGELOG**（它们归 skill）：

* 日志片段、报错原文、截图里那行地址；
* 探针/驱动怎么跑、A/B 数据、`GetLastError` 之类的验证过程；
* 文件与函数名、`request.headers.origin` 这类实现细节（真要提就提"现在改成看 `Host` 头"）。

反面例子（同一条修复的两种写法，后者才对）：

```md
# ✗ 我 3.1.2 写的（像事后报告）
现象（用户在 DeepSeek Harness 官方桌面端里实测）：
```
[Loader.load] Failed to load dsh-app://api/live2d-pet/asset/...
```
注意地址里 `api` 占了 host 的位置 ✗。根因有两条叠在一起：1. … 2. …（20 行）

# ✓ 精炼后
### 修：官方桌面客户端里贴图全 404、宠物加载失败（issue #1）
官方客户端的页面地址是 `dsh-app://`，而引擎在 Worker 里按相对地址取贴图时，地址里的
`/api` 会被当成主机名 ⇒ 贴图全部 404。现在交给引擎的地址一律拼成保住主机名的绝对地址。
```

判断口诀：**"用户在升级前后会看到的差别是什么"** —— 只有这个进 CHANGELOG；
"我为什么绕了这么久"进 skill。

改动插件行为后要同步的：内层 README（如果用户用法变了）、CHANGELOG（用户可见变化）、
对应的 skill（工程结论）、`pets/ds-whale-girl/README.md`（宠物自己的说明）。
外层 `README.md` 是**门面**：功能表、安装、更新日志指针 —— 它和内层对齐，不重复内层细节。

> skill 是按主题检索的，所以新踩的坑要**并进已有主题**（cubism-engine / client-state /
> verification-signals / browser-cdp / pet-domain-model / docs-and-workflow），
> 不要为一次调试新开一个 skill。

## 改了随包宠物（`pets/<id>/pet.json`）之后

**必须把 `pets/<id>/pet.json` 的 `version` 抬一格**（插件自己的版本号另算）。

原因是一段真实的历史事故：老版本的 `installBundledPets()` 是"目标目录存在就跳过"。
插件目录随 `dsh plugin add` / npm 更新，用户的宠物目录 `%DSH_HOME%\pets\<id>\` 不会 ——
于是宠物**自己的默认值永远停在装它的那一天**。2.3.0 往 pet.json 里加的那批（台词 /
互动反应候选 / 摸鱼槽位 / 三个新相位 / 三个新槽位）**一个都没到过老用户的桌面**，
症状看起来完全像插件的 bug：互动只有台词不演反应、相位台词不弹、装扮少三个槽位。

现在（2.3.3 起）`installBundledPets()` 会**按内容**同步：目标那份与"我们装下去的那一份"
逐字节相同就升级，用户改过就一个字都不碰（冷启动靠 `lib/index.js` 里的
`BUNDLED_PET_HASHES` 历史指纹表认人）。所以：

- 改完宠物**跑一次 `node tools/print-pet-hashes.mjs dsh-live2d-pet/pets/<id>/pet.json --code`**，
  把**改动之前那一版**的哈希补进 `BUNDLED_PET_HASHES`（表里的是"老装机可能存在的那一份"，
  当前的随包内容不需要进表）。漏了不会报错，只是"从那个旧版直接跳过来的人"拿不到更新。
- 回归在 `tools/browser-test/test-host-sync.mjs`（纯 node，不用浏览器，0.7 秒）。
  它盯的就是三条边界：装新的、更新我们的、**别碰用户改过的**。
- 想让本机重新吃一遍随包版本：删掉 `%DSH_HOME%\pets\<id>\` 再重启 `dsh web`。

## 发版（本项目的实际流程，2.3.3 走通了一遍）

按顺序，每步都有"怎么知道它成了"：

1. `node run-suite.mjs --jobs 1`（**串行**，见下面"并发下的已知不稳定"）→ 19/19；
2. `dsh-live2d-pet/package.json` 抬版本 + CHANGELOG 加一节（用户可见的变化）；
3. `git add -A && git commit -F <草稿> && git tag v<版本>`；
4. push（见下面"推 GitHub"）；
5. `& tools/npm-publish.ps1`（token 从 `%USERPROFILE%\.dsh\npm-token.txt` 读）；
6. `node tools/verify-npm-package.mjs <版本>` → 两份 README 都 OK；
7. GitHub Release（v2.1.0 起每个版本都有）：正文取 CHANGELOG 那一节的原文。
   本机有 `tools/make-release.mjs`（**故意不进仓库**，和别的带 token 的脚本一样）：
   `node tools/make-release.mjs <版本> [--dry-run]`，token 从 `~/.dsh/github-token.txt` 读。

### ⚠️ npm 的**暂存窗口**：`npm publish` 说成功 ≠ 已上线（2026-09-30 连踩三次）

新 token 若是 **"Read and write (stage only)"** 权限（或 npm 判定需要批准），发布会进**暂存区**，
过几分钟才公开。识别与处理：

| 现象 | 含义 | 怎么办 |
|---|---|---|
| `+ pkg@ver` + `Your package is being processed and may take a few minutes` | **已进暂存区**，还没公开 | 轮询 `GET https://registry.npmjs.org/<pkg>/<ver>`，200 才算上线 |
| `409 Cannot publish over previously staged version "x.y.z"` | **已经在暂存区**了，不是失败 | **别再发**，等它上线；脚本要把这条当成功路径 |
| 版本级接口 404 而 packument 里也没有 | 还在窗口里 | 同上（3.1.1 那次我等了约 25 分钟） |

写发布脚本的两条纪律（都是血泪）：

* **每个包发完都要等到"上线"再做下一步**。本项目是"先子包、后主包"，主包的
  `optionalDependencies` 指着子包 —— 子包没上线就发主包，用户装主包时那个可选依赖 404、
  npm **静默跳过** ⇒ 桌面端凭空消失。
* **判断 409 必须能读到 npm 的输出**：用 `execFileSync(..., { stdio: 'inherit' })` 时
  `error.stdout/stderr` 是**空的**，于是"409 = 已在暂存区"的容错会失效、脚本把正常情况
  当失败退出（3.1.3 第一次就是这么断的 ✗）。改用 `spawnSync`（默认 pipe）抓输出再判断。
* 发布脚本**别用 `| Select-Object -Last N` 包输出** —— 它会把所有输出缓冲到进程结束，
  后台跑起来就看不到任何进度；要进度就 `*> file.log` 再读文件。

**别拿 `npm-publish.ps1 -DryRun` 判断发布能不能成**：它内部 `npm publish ... | Out-String`，
npm 的 `notice` 走 stderr，PowerShell 会把它当 NativeCommandError，`$LASTEXITCODE` 读到的是
**1**，于是脚本报"dry-run failed" —— 而包里其实一切正常（同一条命令手跑 `exit=0`、
还列出了 77 个文件）。要看打包结果就直接在 `dsh-live2d-pet/` 里跑 `npm publish --dry-run`。

## 推 GitHub（本机没有可用的 git 凭据）

`credential.helper` 在 **system 级**（`C:/Program Files/Git/etc/gitconfig`）写着
`manager-core`，它给出的凭据是失效的（`remote: Invalid username or token`），
而 `.dsh` 里那份 `github-token.txt` 是 fine-grained PAT，`gh` 没装。
所以推送要绕过 git 的 credential 链路：

```
GIT_CONFIG_SYSTEM=<空配置> GIT_CONFIG_GLOBAL=<临时配置>
  credential.helper = store --file=<临时凭据文件>
```

**system 那一份必须一起屏蔽**：只改 global 的话 `manager-core` 仍然排在前面被问到。
另外这条线路到 GitHub 很慢，推 4 MB 包体会在默认低速阈值下掉线
（`Failed to connect to github.com port 443 after 21074 ms`），要一起给
`http.version=HTTP/1.1`、`http.lowSpeedLimit=1000`、`http.lowSpeedTime=900`。
2026-09 那台机器上 `git push --dry-run` 也会失败（它同样要建连接），别把它当"凭据不对"。

写这类脚本时：token **只从文件读、不打印、不进命令行**（进程列表可见），
用完删掉临时凭据文件；脚本本身放 `tools/` 但**不进仓库**。

## 常用命令

- 日常验证：`cd tools/browser-test && npm run dev -- <关键字>`（单个 driver 约 7 秒）
- 提交前：`npm run suite`（19 个 driver/测试，约 4 分钟）；机器吃力时 `node run-suite.mjs --jobs 3`
- 改了 `lib/client.js` **或 `lib/index.js`** 都要重启 `dsh web`：客户端 bundle 不做热重载，
  宿主半区是启动时 import 的（`InstallBundledPets` 这类启动代码不会自己重跑）

## 设置正文的渲染有一个专门的 driver（别再省）

`cdp-settings-render.mjs` 是 2026-09 补的，它堵的是一个**真的漏过一次的盲点**：

其它 driver 只验"设置那一节**注册**上了"（`window.__pluginSections['pet-settings']` 存在），
**没有一个真的调用它的 render**。于是下面这种崩法能一路绿灯：

```
ReferenceError: layerRef is not defined
    at LayerControls (client.js)
```

症状是**"宠物一切正常，只有设置页打不开"** —— 因为设置页那一节渲染在**宠物组件之外**
（它挂在 DSH 设置页上），读到组件内的 ref / state 就立刻炸。

规矩：**往设置正文里加组件之后必须跑 `cdp-settings-render`**。它真的 render 一次、数卡片、
数控件、并断言页面里没有未捕获异常。加完顺手验一下"把 bug 放回去它会不会红"
（这次验过：2/7，异常信息直指那一行）。

## 并发：现在是**两条车道**（别再"全都 N 并发"）

2026-09 把调度改成两车道，起因是一次实测：**6 并发跑出 260 秒（比串行还慢）、红 6 条**；
同样这批 driver 串行时全绿。headless Edge 用 SwiftShader 软件渲染模型，是纯 CPU 的，
所以并发在这台机器上是**双向亏**：抢 CPU 让每条都变慢，掉帧又让"睡固定时间再读"的断言
读到半途的值。

现在 `run-suite.mjs` 分两车道：

| 车道 | 谁 | 怎么跑 |
|---|---|---|
| 并发 | `suite-manifest.mjs` 的 `PARALLEL_SAFE`（断言读**终值**：几何、命中、DOM 数量、状态机终态） | 最多 6 并发 |
| 独占 | 其余（靠 sleep 等缓动的） | **一条一条独占整机** |

独占不是牺牲速度换稳定 —— 那 10 条反而更快了（`cdp-motion` 81s → 18.8s，
`cdp-bubble` 66s → 31s），因为没人跟它抢 CPU。

**`PARALLEL_SAFE` 是用失败换来的名单，别凭感觉往里加**：6 并发那一轮红的 6 条里，
`cdp-interact`（摸尾巴的几何断言）与 `cdp-react-defaults` 就是这样被挪出来的。

## 等待：能轮询就别睡（这是套件慢的主因）

同一轮改造里最大的一笔不是调度，是**等待方式**。套件里曾有几百处固定 `sleep`，
它们既慢又脆（条件早就成立也白等；负载一高又不够）—— 同一行代码两头都亏。

现成的工具在 `tools/browser-test/wait-for.mjs`：

| 工具 | 用途 |
|---|---|
| `waitForBoot(ev)` | 等 harness 自报就绪（`title=done`），100ms 轮询 / 30s 上限。**替换掉了 17 个 driver 里各自复制的那段 `for (i<240) sleep(400~500)`**（最坏 96-120 秒） |
| `waitFor(probe, opts)` | 通用条件轮询；超时**返回 false 而不是抛**，由调用方按语义断言 |
| `createWaiter(ev)` | 绑定到某个求值函数的等待器：`waitForIdle` / `waitForSelector` / `waitForParam` … |
| `checkEventually(read, check)` | **"睡一会儿再断言"合成一个轮询** —— 终值类断言的正确形态 |
| `mustElapse(ms)` | **明确标记"这里必须真的等满"**：阈值类契约（转圈窗口、定格撑 9 秒、相位持续播放）。换成轮询等于把测试改掉 |

效果（串行同一台机器）：`cdp-gaze` 260s → 135s、`cdp-v12` 218s → 176s、
`cdp-sharp` 92s → 63s、`cdp-mask` 13.8s → **2.4s**（首屏就绪那处的 500ms 轮询）。

**还没做完**：`cdp-gaze` 里"sleep 之后紧跟 check"的形态还有 **91 处、共 54.6 秒**。
机器能识别它们（`tools/` 下的正则统计），但**不能机械全改** —— 里面混着故意的采样：
行 145-147 的 `sleep(900)/sleep(70)/sleep(900)` 是在**采缓动过程**（断"缓动而不是瞬移"），
行 797 的 3500ms 是等动作定格。批量替换会静默改掉这些语义。
正解是**一处一处判**：终值类 → `checkEventually`；过程/阈值类 → `mustElapse` 并加注释。

## 旧的失败记录（保留，根因已由上面的车道解决）

- `cdp-motion.mjs` 单独跑通过（~26s），6 并发时**状态全零**失败。
  症状值得注意：**不是超时，是参数真的全 0**——说明动作压根没启动，
  而不是启动了没等到。（2026-09 复现一次：这次是 `掏出手机` 的
  `phone` 全 0、同一轮其它动作正常，同样是"动作没启动"。）
- **红了先单独跑一遍再判断是不是回归。** 6 并发那一轮 cdp-gaze / cdp-motion /
  cdp-passthrough 三个红、cdp-idle-return 直接崩（Edge 起不来），
  单独跑**四个全绿**。并发红的共同根因是机器扛不住：帧率掉下来以后，
  "睡固定时间再读"的断言会读到还没走完的缓动。
- 偶发 `ECONNRESET`（driver 与浏览器连接断开）是负载抖动，不是回归；重跑确认。
- 断言里**不要用固定 sleep 等异步后果**（SSE、React 渲染、防抖）。用轮询。
  踩过三次：相位回落的 1200ms 防抖、consecutive-tools 的 300ms、缓动的 70ms 采样。
- 轮询要**轮询"期望值"，不要轮询"稳定"**。缓动停住不等于走完：帧率极低时
  "连续两次读数相同"照样成立，于是把半途的值当成终值——cdp-gaze 的 lean 断言
  就这么假红过。期望值往往能从几何直接算出来（`form = -0.7·ny`），用它当判据。
- **别在 driver 里假设几何对称**：`geo` 是角色**墨迹**包围盒、不是舞台，它的中心
  比舞台中心低（实测 34px），所以 `fy=0.15` 与 `fy=0.85` 在归一化空间里**不是镜像**。
  断言要对着 `gazeTarget()` 实测的偏移写。同样的错还制造过一个挂着"待调查"的
  ANOMALY：那个读数的指针其实停在右边缘，注释却写着"回到中心"。

## 上架到插件市场（dsh-market）

市场目录来自 **awesome-dsh-plugin**：`https://awesome-dsh-plugin.com/plugins.json`
（4000+ 条；`dshmarket` 的 `lib/catalog*.js` 读的就是它，旁边还有一份 npm 镜像）。
收录方式是**往人家仓库提一个文件**——不发 npm、也不是自动爬 topic：

- 仓库 `awesome-dsh-plugin/awesome-dsh-plugin`，新文件 `data/plugins/<owner>__<repo>.yml`
  （一个插件一个文件，所以 PR 之间永不冲突）
- ```yaml
  url: https://github.com/<owner>/<repo>   # 必须与仓库完全一致
  name: <owner>/<repo>
  category: fun                            # agi/ui/usage/theme/…/fun
  description:
    en: One line ending with a period.     # 只有这个是必填
    zh: 一句话，以句号结尾。                 # 可选，维护者会补
  ```
  描述里含 `: `（冒号+空格）必须加引号，否则 YAML 当成嵌套键、解析失败。
- 硬性要求：`package.json` 里有 **`dsh.bundle`**（**只声明 `dsh.client` 会被拒**——那样
  `dsh plugin add` 装不上，这是最常见的退回原因）、仓库**创建满 1 天**、加了
  `dsh-plugin` topic、描述必须与代码相符（夸大是主要打回原因）。
- 合并前**维护者会真的读仓库**，所以"装得上"要自己先验：`git ls-files <pkg>/lib`
  确认构建产物入库（`github:owner/repo` 装下来没有 build 步骤可用），
  `cordis.patch.yml` 是 `- insert: [- id: …, name: …]` 那个形状。

### 子包条目：安装命令是 `#path:/子目录`

插件在仓库子目录里时（我们就是：清单在 `dsh-live2d-pet/package.json`，仓库根没有），
条目要写 `url: https://github.com/owner/repo/tree/main/<子目录>`、
`name: owner/repo#<子目录>`，文件名 `owner__repo--<子目录>`。
**但 `name` 里的 `#子目录` 只是显示名** —— 手动装的时候 pnpm 的语法是：

```
dsh plugin --profile web add 'github:owner/repo#path:/<子目录>'
```

`#` 在 pnpm 里是 **git ref**（分支/标签/提交）。写成 `github:owner/repo#<子目录>`
会把子目录名当成分支去找，报
`ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_GIT: Could not resolve <子目录> to a commit`。
市场列表里自动生成的 install 命令是 `#path:/` 那版（现存条目可对照：
`github:s3yf1337/dsh-desktop#path:/bundle`）。

**给用户的命令要看他用的是哪个 shell。** 单引号只在 PowerShell 里是引号；cmd.exe 会把
`'...'` 连引号一起当成参数传下去，pnpm 就报
`ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST: Package name "'github:..." is invalid,
it should have a @scope`。这个 spec 没有空格、`#`/`:` 在 cmd 里也不特殊，**裸写即可**：

```
:: cmd.exe
dsh plugin --profile web add github:owner/repo#path:/<子目录>
```

判断方法：看提示符。`C:\Users\x>` 是 cmd，`PS C:\Users\x>` 才是 PowerShell。

实测 `pnpm add 'github:A8Chann/dsh-pet-live2d#path:/dsh-live2d-pet'`：~8 秒装好，
`lib/` 跟着来，**不需要 allowBuilds**（没有 prepare 脚本；有才会要求）。
临时目录里先试装一遍再让用户装，比让他踩一次便宜。

**本机拿不到非交互的 GitHub 凭据**：GCM（`credential.helper=manager`）只在 push 时
静默给凭据，`git credential fill` / `git credential-manager get` 都会**挂住**
（命令无输出、被工具超时杀掉），`gh` 也没装。所以开 PR 只有两条路：
让用户点网页预填链接 `/new/main/data/plugins?filename=<owner>__<repo>.yml`，
或者用户给 token 走 REST API（fork → ref → contents → pulls）。

## 发 npm（本项目的实际流程）

- 包名 **`dsh-pet-live2d`**（和仓库同名）。`dsh-live2d-pet` 在 npm 上已被 ankesu 占用。
  **改包名要同时改三处**：`package.json` 的 name、`cordis.patch.yml` 的 `name:`
  （DSH 按包名 import，不改就加载不了）、`lib/client.js` 里 `__ModuleLoader__.load({id})`，
  外加测试 harness 的 `/plugins/<包名>/client.js` 寻址（不改的话客户端整个不挂载，cdds-exp 会 slots=0）。
- 脚本 `tools/npm-publish.ps1`：token 从 `%USERPROFILE%\.dsh\npm-token.txt` 读，生成的 .npmrc
  里只放 `${NPM_TOKEN}` 占位符 + 环境变量传值，**磁盘上不留密钥**；`-DryRun` 先看清单。
  权限只需要 npmjs.com 的 Granular Token（packages: read and write，2FA 账号要勾 Bypass 2FA）。
- **npm 发布后**：README 的安装命令换成 `dsh plugin --profile web add dsh-pet-live2d`；
  市场条目不用改，重新生成时会自动带上 npm 信息（install 命令变成 npm 那条）。
- 脚本用 `--userconfig` 指向**临时那份最小配置**，所以本机
  `npm config get registry` 指向镜像（`registry.npmmirror.com`）**不影响发布** ——
  发布走的是默认的 npmjs ✓（日志里那行 `Publishing to https://registry.npmjs.org/` 是真的）。
- **别拿"包级"接口判断发布是不是成功**：`curl …/dsh-pet-live2d`（packument）会命中 CDN 缓存，
  发完几分钟还可能只列旧版本，害我以为发布失败、白查一轮。看**版本级**接口
  `…/dsh-pet-live2d/<版本>`（200 就是上了），或者干脆再发一次 —— npm 会明确拒绝覆盖 ✓
  （那条报错反而是"已经发布成功"的证据）。
- **发了文档改动，验"包里的"那份**：`node tools/verify-npm-package.mjs <版本>` —— 从 tarball
  取两份 README（主 + 宠物）逐条核对，会先等版本级接口 200 再下包。
  **每条都同时要求"有新说法、没有旧说法、长度正常"**：只查"旧说法没有了"是空洞断言 ——
  版本还没上线时 README 是**空字符串**，照样"通过"（这个错我连犯两次）。

### PowerShell 脚本一律写成纯 ASCII

Windows PowerShell 读 `.ps1` **按 ANSI/GBK**，除非文件带 UTF-8 BOM。write/edit 工具写出的是
无 BOM 的 UTF-8，于是脚本里的中文变成乱码、**解析器直接崩，而且报的行号全是错的**
（我因此对着正确的代码查了三轮"行号对不上"）。工具脚本里注释和提示语都写英文，一劳永逸。

另外两条 PowerShell 坑：

- **脚本里别用 `exit`**：用 `&` 在本 shell 里调用时，`exit` 会把**宿主 shell 一起退掉**，
  后面的命令全不执行、也看不到输出。改成 `throw`，成功时打一行 `XXX_OK`。
- **`Write-Host` 走 information 流**，`> file` 抓不到，要用 `*> file`。
- 脚本里 `$env:TEMP` 在子进程里可能是空的，别依赖它；临时文件放脚本目录旁边用完删掉。

## 测试环境的第一个开关：暂停摸鱼

`waitReady()` 现在会自动调 `window.__dshLive2dPet.setFidgetEnabled(false)`。

**原因**：摸鱼每 12–26 秒触发一次并重写槽位选择，而长 driver 跑的正是
"某个状态要保持不变"的断言——摸鱼会把状态从断言底下换掉。
表现为"并发挂、单独过"，有四个 driver 中过招，一度被当成真回归。

`setFidgetEnabled(false)` **只停自动的**；`fidgetNow()` 强制调用照常工作，
所以专门测摸鱼的 driver（cdp-head）不受影响。

加了这个开关之后，原本并发必挂的 cdp-exp / cdp-head / cdp-host-events 全过了。