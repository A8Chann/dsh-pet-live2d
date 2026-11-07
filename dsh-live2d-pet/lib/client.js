// dsh-live2d-pet — browser half.
//
// A self-contained Live2D desk pet for the DSH Web GUI. Hand-written
// __ModuleLoader__ factory (no build step); the only external require is
// react / react-dom/client, which the loader module table seeds.
//
// The plugin mounts one page-global floating surface on document.body:
//   * a WebGL Live2D model rendered by the lazily-loaded vendor bundle,
//   * mouse tracking — the model's eyes and head follow the pointer,
//   * drag to move, position and size persisted in localStorage,
//   * click reaction (a motion + a speech bubble),
//   * a control panel listing every motion group and expression the loaded
//     model declares, discovered from the host catalog endpoint.
//
// The proprietary Cubism Core runtime is never bundled: the page loads the
// user-supplied file from the host's runtime route first, and reports a
// localized install hint when it is absent.
window.__ModuleLoader__.load({ id: "dsh-pet-live2d", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  const react = require("react");
  const h = react.createElement;
  const { useCallback, useEffect, useRef, useState } = react;

  const name = "live2d-pet";
  /**
   * 本包的 npm 包名。
   *
   * 官方「插件」页按**包名**派发组合包的配置区（`plugins.bundle.config` 的 key 就是
   * 组合包的包名，见 `dsh-client-ui-plugin-manager` 的 `configLedgerSource`），所以这个
   * 字符串必须与 `package.json` 的 `name` 逐字相同 —— 写错的表现是"注册没报错、
   * 页面上什么都没多出来"（页面按包名查不到这个键就不渲染那一节）。
   */
  const PACKAGE_NAME = "dsh-pet-live2d";
  // "slots" 是 DSH 客户端界面给插件的扩展点（设置页就是这么挂进去的）。
  const inject = ["slots"];

  const API = "/api/live2d-pet";
  const STORAGE_KEY = "dsh-live2d-pet.state.v1";

  // ---- 存储：`localStorage` 要裹起来用 ----
  //
  // 为什么不能直接 `window.localStorage.getItem(...)`：**有些桌面外壳里访问它就抛异常**
  // （自定义协议 / opaque origin 下是 `SecurityError: The operation is insecure`，
  // 有的壳还会因为隐私设置直接禁用 storage）。一抛就是**在组件第一帧里**，整个宠物
  // 连带设置页一起白掉 —— 而这种外壳（官方 desktop / 各家 Tauri、Electron 打包版）
  // 恰恰是本插件最常见的运行环境之一。
  //
  // 拿不到就退回内存实现：这一次会话内照样能存（位置、大小、装扮），只是关掉窗口不保留。
  // 注意**不能**用 `typeof window.localStorage` 判断 —— 那个 getter 本身就会抛，
  // 所以连"取一次引用"都要裹在 try 里。
  const nativeStorage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const memoryStorage = new Map();
  const storage = {
    getItem(key) {
      if (nativeStorage !== null) {
        try {
          return nativeStorage.getItem(key);
        } catch {
          /* 读也抛（配额/隐私模式）⇒ 退回内存那份 */
        }
      }
      return memoryStorage.has(key) ? memoryStorage.get(key) : null;
    },
    setItem(key, value) {
      memoryStorage.set(key, String(value));
      if (nativeStorage === null) return;
      try {
        nativeStorage.setItem(key, value);
      } catch {
        /* 写不进去也别抛：内存那份已经存了 */
      }
    },
    removeItem(key) {
      memoryStorage.delete(key);
      if (nativeStorage === null) return;
      try {
        nativeStorage.removeItem(key);
      } catch {
        /* 同上 */
      }
    },
  };

  const ROOT_ATTR = "data-dsh-live2d-pet-root";
  const PET_ATTR = "data-dsh-live2d-pet";
  const LEGACY_ATTR = "data-dsh-live2d-pet-container";
  const MIN_SIZE = 160;
  const MAX_SIZE = 760;
  const DEFAULT_SIZE = 300;
  // 对白随角色尺寸调整，但小号仍可读，大号不占满屏幕。
  function speechScale(size) {
    return Math.max(12 / 14, Math.min(1.4, size / DEFAULT_SIZE));
  }
  /** 显示层轮询间隔：桌面端接管/让位要在一秒内被看见。 */
  const LAYER_POLL_MS = 1000;

  // ---- 交给引擎的地址必须是"保住 host 的绝对地址" ----
  //
  // 症状（2026-09-30 官方桌面端实测）：贴图全挂在
  //   `dsh-app://api/live2d-pet/asset/ds-whale-girl/textures/texture_01.png` 404
  // —— 注意 host 位置被 `api` 占了：官方桌面端的页面 origin 是 `dsh-app://app`，
  // 而 Pixi 是在 **blob Worker** 里 `fetch` 贴图的（`WorkerManager.loadImageBitmap`），
  // blob Worker 里解析 `/api/...` 这种根相对地址会把 host 丢掉。
  //
  // 所以凡是交给引擎（`Live2DModel.from` / 脚本注入）的地址，都先拼成
  // `<协议>//<host>/api/...`。http(s) 外壳下结果与相对地址等价（只是更长），
  // 自定义协议外壳下这正是能通的那一种写法。
  const URL_BASE = (() => {
    const { protocol, host } = window.location;
    if (host) return protocol + "//" + host;
    const { origin } = window.location;
    return typeof origin === "string" && origin !== "null" ? origin : "";
  })();
  const absolutize = (url) =>
    typeof url === "string" && url.startsWith("/") && URL_BASE !== "" ? URL_BASE + url : url;

  /**
   * 桌面端注册进来的"跟随处理器"。
   *
   * 为什么需要这条通道：`pointermove` 只在指针**落在窗口内**时才由浏览器送来 —— 用户在
   * 别的程序里动鼠标时，落点不在我们这个窗口上，页面**一个事件都收不到**（全屏透明层也
   * 帮不上忙：事件不是被挡住，而是压根没发生在这个窗口上）。
   *
   * 而壳本来就在**每 33ms 读一次全局光标**（穿透判定必须知道指针在哪，见它的 hover 循环），
   * 所以把那个坐标顺手喂进来就够了 —— 不需要新的轮询，也不需要原生鼠标钩子。
   */
  const externalPointer = { handler: null, lastX: null, lastY: null };

  /**
   * 镜像标记：宠物整体左右翻转（模型 scale.x 取负）时，注视的水平方向也要跟着取反，
   * 否则会出现"鼠标在左、眼睛却往右看"。组件把当前 flip 写进来，updatePointer 读它。
   */
  const gazeMirror = { flip: false };

  /**
   * 壳调用的入口：`window.__petPointer(x, y)`（`clientX/clientY`，逻辑像素）。
   *
   * 位置没变就什么都不做 —— 壳 33ms 喂一次，光标的静止不该被当成"一直在动"。
   */
  function applyExternalPointer(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    if (externalPointer.handler === null) return;
    if (externalPointer.lastX === clientX && externalPointer.lastY === clientY) return;
    externalPointer.lastX = clientX;
    externalPointer.lastY = clientY;
    externalPointer.handler(clientX, clientY);
  }
  if (typeof window !== "undefined") window.__petPointer = applyExternalPointer;

  /**
   * 这一份客户端跑在**哪里**。
   *
   * 桌面壳（`sidecar/page/runtime.js`）会建 `window.__petDesktop`，DSH 页面里没有。
   * 让位判据必须知道这件事 —— 否则"owner === desktop"会被两边同时当成"该我显示"或
   * "该我让位"（实测踩过：桌面端那只把自己藏了，用户看到"桌面上什么都没有"）。
   */
  const isDesktopShell = typeof window.__petDesktop === "object" && window.__petDesktop !== null;

  /**
   * 界面文案的显示语言：**模块加载时判定一次**（与宠物文案共用同一个来源）。
   *
   * 来源是 `navigator.language` —— 浏览器 / WebView2 给的就是系统或浏览器语言。
   * **不要用 `document.documentElement.lang`**：DSH 网页入口写死 `<html lang="en">`，
   * 桌面端宠物页写死 `<html lang="zh">`，拿它当依据会让中文网页用户看到英文、
   * 英文桌面用户永远看不到英文（PR #14 review 里实测过）。
   *
   * 测试钩子：页面可以在本模块求值前设 `window.__petLocale`（"zh" / "en" / "en-US"…）
   * 强制语言；回归驱动除了用这个钩子，还会用 Chromium 的 `--accept-lang` 真改
   * `navigator.language`。
   */
  const UI_LOCALE = (() => {
    const read = (get) => {
      try {
        const value = get();
        return typeof value === "string" ? value.trim() : "";
      } catch {
        return "";
      }
    };
    const forced = read(() => window.__petLocale);
    const raw = forced !== "" ? forced : read(() => navigator.language);
    if (raw === "") return "zh";
    return /^zh/i.test(raw) ? "zh" : "en";
  })();

  /**
   * 界面文案的**中文 → 英文**对照表（PR2）。
   *
   * key 是 client.js 里的**中文原文**，逐字相同（含空格与全角标点）——所以它同时就是
   * 默认文案：中文界面下 `t()` 原样返回，英文界面下查表。查不到就退回中文（宁可夹一句
   * 中文，也不要显示一个空标签）。
   *
   * 几点约定：
   *   * **身份字符串永远不进这张表**：槽位 id、选项标签、动作组、表情名、
   *     `looksByPhase` / `pairs` / `requires` 的值、`data-*`、存档键 —— 它们按字符串
   *     相等比较或被写进存档，翻译了就会静默失效（见 `slotOfLabel()` / `relationsOf()`）。
   *   * 句子里带数字的走**片段**翻译：`"动作 " + n`、`"第 " + n + " 段"` —— 片段各自
   *     查表，拼出来的英文语序不变。
   */
  const UI_EN = {
    "(无部件)": "(no parts)",
    "注视死区": "Gaze dead zone",
    "注视满偏 px": "Gaze range px",
    "收回倍数": "Release multiplier",
    "嘴跟随意": "Mouth follow",
    "嘴形强度": "Mouth strength",
    "嘴缓动 ms": "Mouth easing ms",
    "眨眼最短 ms": "Blink min ms",
    "眨眼最长 ms": "Blink max ms",
    "静置多久开始": "Idle before fidget",
    "之后最长间隔": "Max gap afterwards",
    "气泡左右偏移 px": "Bubble offset X px",
    "气泡上下偏移 px": "Bubble offset Y px",
    "一句话停留 ms": "Line hold ms",
    "转几圈算晕": "Spins before dizzy",
    "要在多少 ms 内": "Within ms",
    "提示音音量": "Chime volume",
    "手感": "Feel",
    "指针 / 嘴 / 眨眼": "Pointer / mouth / blinking",
    "摸鱼节奏": "Fidget rhythm",
    "多久开始、间隔多长": "When it starts, how long between",
    "互动": "Interaction",
    "摸头 / 摸尾巴 / 转圈": "Head pats / tail pats / spinning",
    "气泡": "Bubbles",
    "显示什么 · 在哪": "What shows · where",
    "显示什么 · 在哪 · 停留多久": "What shows · where · for how long",
    "宠物尚未加载": "The pet isn't loaded yet",
    "宠物还没加载好": "The pet isn't loaded yet",
    "音频文件不能超过 1 MB": "Audio files must be 1 MB or smaller",
    "音频文件损坏或格式不受支持": "The audio file is damaged or in an unsupported format",
    "读取音频超时，请换一个文件": "Timed out reading the audio; try another file",
    "读取音频文件失败": "Failed to read the audio file",
    "仅支持 MP3、WAV、OGG 音频（最大 1 MB）": "Only MP3, WAV and OGG audio, up to 1 MB",
    "保存音频失败（": "Failed to save audio (",
    "保存音频失败": "Failed to save audio",
    "恢复默认": "Reset to default",
    "全部恢复默认": "Reset all to defaults",
    "跨启动记住装扮": "Remember outfit across restarts",
    "眼镜 / 发饰 / 魔爪 / 巴菲 / 桌布 / 手机换色 —— ": "Glasses / hair accessory / claws / parfait / tablecloth / phone colour — ",
    "关掉会同时清掉已存的那套。": "Turning it off also clears the saved outfit.",
    "已关闭，也不再记录。": "Off; no longer recorded.",
    "已关：也不再记录": "Off: no longer recorded",
    "已关：任何台词都不弹": "Off: no lines will pop up",
    "还没有可用的 Live2D 宠物。": "No usable Live2D pets yet.",
    "把宠物目录放到：": "Put a pet directory at:",
    "缺少 Live2D Cubism Core 运行时": "The Live2D Cubism Core runtime is missing",
    "请把官方 live2dcubismcore.min.js 放到：": "Put the official live2dcubismcore.min.js at:",
    "加载失败": "Failed to load",
    "加载模型…": "Loading model…",
    "关闭（Esc）": "Close (Esc)",
    "动作 ": "Motions ",
    "装扮 ": "Outfit ",
    "设置": "Settings",
    "第 ": "Part ",
    " 段": "",
    "播放": "Play",
    "在宠物身上点右键打开这里 · Esc 或点空白处关闭": "Right-click the pet to open this · Esc or click elsewhere to close",
    "缩小": "Smaller",
    "放大": "Larger",
    "归位": "Reset",
    "翻转": "Flip",
    "左右翻转朝向": "Mirror horizontally",
    "这只宠物没有配置任何会话相位": "This pet has no session phases configured",
    "收起": "Collapse",
    "展开": "Expand",
    "恢复此相位的动作槽位默认值": "Restore this phase's default motion slots",
    "恢复": "Restore",
    "的动作槽位默认值": "'s default motion slots",
    "重置动作": "Reset motions",
    " 槽 · ": " slots · ",
    " 候选": " candidates",
    " 条候选": " candidates",
    " · 已改": " · changed",
    "台词 ": "Line: ",
    "已改": "changed",
    "默认": "default",
    "音频 ": "Sound: ",
    "已静音": "muted",
    "已上传 ": "Uploaded ",
    "已上传": "uploaded",
    "未配置；可上传音频": "Not set; audio can be uploaded",
    "未配置": "not set",
    "宠物默认": "pet default",
    " · 宠物默认": " · pet default",
    " · 已静音": " · muted",
    "气泡与提示音": "Bubble & chime",
    "气泡台词": "Bubble line",
    "提示音": "Chime",
    "试听这个相位的有效来源（不受总开关与单相位静音影响，音量用当前提示音音量）": "Preview this phase's effective sound (ignores the master switch and per-phase mute; plays at the current chime volume)",
    "试听": "Preview",
    "上传中…": "Uploading…",
    "上传音频": "Upload audio",
    "替换音频": "Replace audio",
    "MP3 / WAV / OGG，最多 1 MB": "MP3 / WAV / OGG, up to 1 MB",
    "移除上传": "Remove upload",
    "内置默认音频": "Built-in default sound",
    "会话提醒": "Session alerts",
    "免打扰与提醒范围": "Do-not-disturb and reminders",
    "当前会话提醒时机": "Current session alerts",
    "提醒范围": "Notify for",
    "仅后台或最小化": "Hidden or minimized only",
    "切到其他应用时": "When switched away",
    "始终提醒": "Always",
    "全部会话": "All sessions",
    "只主会话": "Main only",
    "主会话+等子会话": "Main, after subagents",
    "当前会话提醒时机只影响你正在看的这个会话；提醒范围决定子会话是否单独提醒。": "Current-session alerts apply only to the session you are viewing; scope decides whether subagents alert separately.",
    "动作槽位": "Motion slots",
    "按候选权重抽取": "Drawn by candidate weight",
    "没有动作槽位，可在下方添加": "No motion slots; add one below",
    "空着": "Empty",
    "空表": "Empty",
    "加槽位": "Add slot",
    "给这个相位加一张槽位表": "Add a slot table to this phase",
    "选了它就一起点亮": "Lights it up when selected",
    "必须先处于这个状态才播得出来": "Only plays while this state is active",
    "同时": "Together",
    "前提": "Requires",
    "删掉这条关系": "Delete this relation",
    "删掉这一条": "Delete this row",
    "（本槽位）": "(this slot)",
    "＋ 关系": "+ Relation",
    "把这个槽位从池子里拿掉": "Remove this slot from the pool",
    "% 的概率": "% chance",
    "空表：这个槽位在这个池子里不出手": "Empty: this slot never plays in this pool",
    "还没有槽位 —— 在下面挑一个加进来": "No slots yet — pick one below",
    "把这个槽位加进摸鱼池": "Add this slot to the fidget pool",
    "开始的时候": "On greeting",
    "点她身上（不是头和尾巴）": "Clicking her body (not head or tail)",
    "摸摸头": "Head pat",
    "摸尾巴": "Tail pat",
    "被转晕": "Dizzy from spinning",
    "点「归位」": "Pressing Reset",
    "模型加载失败": "Model failed to load",
    "思考中": "Thinking",
    "用工具": "Running tools",
    "等你批准": "Waiting for approval",
    "等你回答": "Waiting for an answer",
    "叫了帮手": "Helper called",
    "消息排队": "Message queued",
    "这一轮完成": "Turn complete",
    "出错": "Error",
    "（已改过）": "(customized)",
    "（宠物默认）": "(pet default)",
    "（内置默认）": "(built-in default)",
    "（随机一个）": "(random pick)",
    "这只宠物没有可选的动作/表情": "This pet has no motions or expressions to choose from",
    "摸头有反应": "Reacts to head pats",
    "摸尾巴有反应": "Reacts to tail pats",
    "鼠标绕着转圈会晕": "Gets dizzy when the pointer circles her",
    "摸头时演什么": "What plays on a head pat",
    "摸尾巴时演什么": "What plays on a tail pat",
    "转晕时演什么": "What plays when she is dizzy",
    "多个变体用 | 分隔（随机挑一句）。留空 = 用宠物默认。": "Separate variants with | (one is picked at random). Leave empty to use the pet default.",
    "自动": "Auto",
    "桌面端在跑就用桌面，否则留在页面里": "Use the desktop window if it's running, otherwise stay in the page",
    "页面内": "In page",
    "永远在 DSH 页面里（随 DSH 启停）": "Always in the DSH page (starts and stops with DSH)",
    "桌面": "Desktop",
    "永远在桌面上；没跑就拉起一个": "Always on the desktop; launch one if it isn't running",
    "正在切换…": "Switching…",
    "切换失败：": "Switch failed: ",
    "未知": "unknown",
    "桌面端拉起来了，但它没在 6 秒内报活 —— 看看是不是被系统拦住了（未签名的 exe 会被 SmartScreen 拦）": "The desktop window started but did not report in within 6 seconds — check whether the system blocked it (unsigned executables are blocked by SmartScreen)",
    "桌面端二进制不在": "Desktop binary not found",
    "桌面端已在跑。": "The desktop window is already running.",
    "已切回页面内。": "Switched back to the page.",
    "正在下载桌面端（约 5MB）…": "Downloading the desktop window (~5 MB)…",
    "下载已开始…": "Download started…",
    "下载没能开始：": "Download didn't start: ",
    "下载请求失败：": "Download request failed: ",
    "正在下载…": "Downloading…",
    "下载完成，已就绪": "Downloaded and ready",
    "下载失败（": "Download failed (",
    "本平台还没有桌面版构建": "No desktop build for this platform yet",
    "桌面端：": "Desktop: ",
    "运行中（已接管）": "running (in charge)",
    "没在跑": "not running",
    "下载中…": "Downloading…",
    "下载桌面端（约 5MB）": "Download desktop window (~5 MB)",
    "显示位置": "Display",
    "页面内 / 桌面上": "In page / on desktop",
    "会话提示音": "Session chimes",
    "总开关 · 音量（拖滑杆会试听）": "Master switch · volume (drag to preview)",
    "开启会话提示音": "Enable session chimes",
    "默认静音": "Muted by default",
    "会话相位": "Session phases",
    "点开相位调整台词 · 音频 · 动作": "Open a phase to adjust its line, sound and motions",
    "摸鱼": "Fidgeting",
    "多久摸一次 · 摸鱼做什么": "How often · what she does",
    "装扮": "Outfit",
    "显示气泡": "Show bubbles",
    "还没加载": "not loaded yet",
    "现在在桌面上": "on the desktop now",
    "现在在页面里": "in the page now",
    "当前宠物：": "Current pet: ",
    " · 显示位置：": " · Display: ",
    "常用开关": "Common switches",
    "点一下立刻生效": "Takes effect on click",
    "注视范围 · 摸鱼节奏 · 音量": "Gaze range · fidget rhythm · volume",
    "相位台词、池子编辑器、装扮与台词文案在「设置 → 桌宠」里改。": "Phase lines, pool editors, outfit and line text are edited in Settings → Desktop Pet.",
    "桌宠": "Desktop Pet",
  };

  /** 取一条界面文案：中文界面原样返回，其它语言查表（查不到退回中文）。 */
  const t = (zh) => (UI_LOCALE === "zh" ? zh : (UI_EN[zh] ?? zh));

  /**
   * 宿主（`lib/desktop.js` 的 `desktopHint`）返回的**动态**提示：宿主不知道界面语言，
   * 所以按形状在这里翻。认不出来就原样返回 —— 宁可夹一句中文，也不要显示空。
   */
  const tHost = (text) => {
    if (UI_LOCALE === "zh" || typeof text !== "string") return text;
    const ready = /^桌面端已就绪（(.+)）$/.exec(text);
    if (ready !== null) return "Desktop ready (" + ready[1] + ")";
    if (text === "点「下载桌面端」拉一份（约 5MB）") return 'Click "Download desktop window" to fetch one (~5 MB)';
    const unsupported = /^本平台（(.+)）还没有桌面版构建$/.exec(text);
    if (unsupported !== null) return "No desktop build for this platform (" + unsupported[1] + ") yet";
    return text;
  };

  /**
   * 桌面端：把界面语言报给壳 —— **托盘菜单与弹框由壳渲染**，它读不到 `navigator.language`。
   *
   * 只发一次（语言在模块加载时判定一次）。壳收到后会重建托盘；页面没起来时托盘按中文，
   * 这是刻意的（壳的启动期弹框本来就只有中文，那时页面还没加载）。
   */
  if (isDesktopShell) {
    try {
      fetch("/__desktop/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang: UI_LOCALE }),
        cache: "no-store",
      }).catch(() => { /* 老壳没有这条路由：托盘保持中文 */ });
    } catch { /* fetch 不可用：同上 */ }
  }

  /**
   * 桌面端：把"我按住她了"这件事交给壳，由壳**挪窗口**。
   *
   * 为什么桌面端不能像网页端那样"在窗口内挪位置"：窗口只有**一块屏**那么大，位置一旦
   * 相对窗口存，她就永远跨不出这块屏（issue #11 的"连多屏后拖不到别的屏幕"）。改成
   * "拖宠物 = 挪窗口"之后，屏幕坐标说了算 —— 多屏、异形排布、负原点、换分辨率全都
   * 自动成立，也就不再需要托盘里那个「屏幕」子菜单。
   *
   * 落点用 `clientX/clientY`（**窗口本地 CSS 像素**）：壳反推窗口原点时用的就是这个
   * 口径。换成屏幕坐标再让壳换算的话，"按下 → 发请求"这几毫秒的手部位移会被算成抓取
   * 偏移 —— 拖动一开始她会跳一下。
   *
   * 这里**不 await**、也不重试：拖动是"有就更好"的动作，壳不在（网页端）就什么都不做。
   */
  function postWindowDrag(payload) {
    if (!isDesktopShell) return;
    try {
      fetch("/__desktop/drag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      }).catch(() => { /* 壳没接住就算了 */ });
    } catch {
      /* fetch 不可用（老壳）：退回"窗口内挪位置"那条路 */
    }
  }

  /** 按住她了：壳从这个落点开始把窗口跟着指针挪。 */
  const beginWindowDrag = (x, y) => postWindowDrag({ active: true, x, y });

  /** 松手了：停。壳那边还有"左键已松开"与超时两道兜底，这条只是让它立刻停。 */
  const endWindowDrag = () => postWindowDrag({ active: false });

  /**
   * 这一份客户端该不该**出声**。
   *
   * 页面与桌面窗口各跑一份客户端、各收一份 SSE：让位只做在渲染上时，两份都会响，
   * 听感就是"每次相位响两遍"（issue #7）。判据必须与渲染让位同源 —— 谁在显示，
   * 谁才响；另一份静音。
   *
   * `desktopShell` 只给单元测试传（同一份代码要在两种身份下各断言一遍），
   * 生产调用不传，默认读模块级常量。
   */
  const isPhaseSoundOwner = (owner, desktopShell = isDesktopShell) =>
    owner === (desktopShell ? "desktop" : "inline");

  /**
   * 跟随范围的诊断快照（最近一次 pointermove 的中间量）。
   *
   * 挂在模块级而不是组件 ref 上：它要能被**页面外的驱动**读到（经 `__dshLive2dPet.gazeTrace()`），
   * 而"跟随范围"这类问题最难的地方就是"看着像没反应"——量出判据与参数才有得查。
   */
  const gazeTrace = { current: null };

  /**
   * 显示层状态的**模块级 store**。
   *
   * 为什么不能放在 `Pet` 组件的 ref 里：设置页那一节（`PetSettingsBody`）渲染在**宠物组件
   * 之外**（它挂在 DSH 设置页上），读组件内的 ref 会直接 `ReferenceError: layerRef is not
   * defined` —— 整节设置打不开。这个坑真的踩过，而且是"宠物看着正常、只有设置页崩"的形态。
   *
   * 现在两个渲染者都从这里读：`Pet` 负责轮询（它本来就常驻），设置页只读 + 订阅。
   */
  const LAYER_INITIAL = { mode: "auto", owner: "inline", desktopRunning: false, binary: null, download: null, at: 0 };

  /**
   * 两个值是不是**内容相同**（对象/数组按内容比，其余按 `===`）。
   *
   * 为什么需要它：`binary` 与 `download` 是**每次轮询新解出来的 JSON 对象**，
   * 引用永远不相等 —— 拿 `===` 去重等于没有去重。
   *
   * 这个坑的形态是"面板和宠物一起持续闪"（issue #3，2026-10）：去重失效 ⇒
   * `layerStore` **每秒**通知一次 ⇒ 订阅它的三个界面（宠物本体、右键面板里的
   * `LayerControls`、设置页与官方「插件」页那一节）**每秒全部重渲染一次**，
   * 用户看到的就是面板与画面一起抖。实测（注入计数器数真实重渲染）：面板关着与开着
   * 都是 1.00 次/秒的 store 通知、宠物 1.8 次/秒重渲染 —— 与面板无关，一直如此，
   * 只是**打开面板之后画面里多了一块 backdrop-filter 的面板**，抖动才被看见。
   *
   * 键顺序不参与比较（JSON 的键序不该影响"内容是否相同"）。
   */
  const sameJson = (a, b) => {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!sameJson(a[key], b[key])) return false;
    }
    return true;
  };

  const layerStore = { value: LAYER_INITIAL, listeners: new Set() };
  const setLayerState = (next) => {
    const merged = Object.assign({}, layerStore.value, next);
    if (merged.mode === layerStore.value.mode
      && merged.owner === layerStore.value.owner
      && merged.desktopRunning === layerStore.value.desktopRunning
      && sameJson(merged.binary, layerStore.value.binary)
      && sameJson(merged.download, layerStore.value.download)) return;
    layerStore.value = merged;
    for (const listener of layerStore.listeners) {
      try { listener(merged); } catch { /* 一个订阅者坏了不该拖垮别的 */ }
    }
  };
  /** 订阅显示层状态（返回当前值）。 */
  function useLayerState() {
    const [value, setValue] = useState(layerStore.value);
    useEffect(() => {
      const listener = (next) => setValue(next);
      layerStore.listeners.add(listener);
      // 订阅之前可能已经变了：补一次当前值。
      listener(layerStore.value);
      return () => { layerStore.listeners.delete(listener); };
    }, []);
    return value;
  }

  /**
   * **谁在轮询**：一个模块级单例，**不跟着任何组件走**。
   *
   * 原来轮询写在 `Pet` 的 effect 里 —— 那有个要命的缺口：**用户在设置里选了"桌面"之后，
   * 页面里那只会让位（`visibility: hidden`），而设置页那一行要显示的正是"桌面端在跑"**。
   * 可设置页只订阅、不轮询，所以它等到的是"页面那只还活着时的最后一次结果"，文本就停在
   * "二进制不在"不动；只有重新打开设置页（重新挂载、读到 store 的当前值）才对。
   *
   * 换句话说：这个功能的观测者不能是它要观测的那个东西。轮询挪到模块级，页面里那只在不在
   * 都照轮（它本来就是每秒一次 GET，代价可以忽略）。
   */
  let layerPollStarted = false;
  let layerPollTimer = 0;
  function ensureLayerPolling() {
    if (layerPollStarted) return;
    layerPollStarted = true;
    const poll = async () => {
      try {
        const response = await fetch(API + "/layer", { cache: "no-store" });
        const payload = await response.json();
        setLayerState({
          mode: typeof payload?.mode === "string" ? payload.mode : "auto",
          owner: payload?.owner === "desktop" ? "desktop" : "inline",
          desktopRunning: payload?.desktopRunning === true,
          binary: payload?.binary ?? null,
          download: payload?.download ?? null,
          at: Date.now(),
        });
      } catch {
        /* DSH 那边的路由还没挂上、或页面刚起来：下一轮再问 */
      }
      layerPollTimer = window.setTimeout(poll, LAYER_POLL_MS);
    };
    poll();
  }

  // -------------------------------------------------- motion controller
  //
  // Why this is a state machine rather than "just call model.motion()":
  //
  //  * The engine's MotionManager refuses to (re)start a group+index that is
  //    still active, so replaying the same reaction needs an explicit
  //    stopAllMotions() first — otherwise a second click does nothing.
  //  * Its priority gate means a NORMAL request cannot interrupt a motion
  //    that is already playing, so reactions must use FORCE or the pet
  //    silently stops responding after the first one.
  //  * motionFinish fires only for a motion that ends by itself. A model whose
  //    motions are all flagged Loop in their own motion3.json (the DS whale
  //    girl is exactly that) never finishes, so "play once, then go back to
  //    idle" has to be driven by the motion's declared Duration instead.
  //
  // The controller therefore owns the whole motion lifecycle: one action at a
  // time, always returning to the idle loop, every transition interruptible.

  /** Idle group names tried in order before falling back to the first group. */
  const IDLE_CANDIDATES = ["Idle", "idle", "待机"];

  /** How long a one-shot reaction is held when it declares no duration. */
  const REACTION_FALLBACK_MS = 1600;

  /** Reserved for future head/eye yielding while a reaction owns the body. */
  const REACTION_TAIL_MS = 60;

  /**
   * How long a prerequisite motion runs before the action it precedes.
   *
   * 自拍 motions start with `phone: 1` already baked into their first keyframe:
   * the author assumes the phone is ALREADY in hand. Playing 快速自拍 on its own
   * therefore waves an invisible phone around. Running 掏出手机 first — the
   * motion that actually raises it — is what makes the selfie read correctly.
   */
  const PREPEND_HOLD_MS = 1100;

  /**
   * A motionFinish arriving sooner than this after a start cannot be genuine.
   *
   * model.motion() is asynchronous: it has to load and parse the motion before
   * it is queued. In that window stopAllMotions() has already cleared the
   * previous motion while MotionManager still reports playing===true and
   * isFinished()===true, so it emits motionFinish for a motion that never
   * actually ran. Trusting that event ends the new reaction instantly, which
   * is precisely the "click and it snaps back / loops forever" failure.
   */
  const MOTION_FINISH_GUARD_MS = 250;

  function createMotionController() {
    let vendor = null;
    let model = null;
    let idleName = null;
    let groups = {};
    let motionOptions = null;
    let applyExpression = null;

    let kind = "idle";
    let token = 0;
    let timer = 0;
    let currentGroup = null;
    let currentEntry = null;
    let startedAt = 0;
    let onChange = null;
    /**
     * 「只有待机在动」的参数，以及待机最后一次写下的那一份值。
     *
     * 这个模型里是爱心左/爱心右的 58 个 `j*`：**爱心的位置全靠待机循环**
     * （`idle.motion3.json` 89 条曲线里 56 条是 `j*`），而 `love`（爱心开关）只是
     * 一个 0/1 的表达式参数。`hold: true` 的动作（掏出手机 / 吹泡泡糖 / 自拍）
     * 定格之后待机不再跑，引擎就把这些参数放回基线 0 —— 于是**开关是开的、
     * 爱心却全缩成一点看不见**。用户报的"有动作冒爱心就失效"就是这个。
     *
     * 判据是算出来的（见 computeAmbientOnly）：待机驱动、别的动作都不碰的参数，
     * 就是这个宠物的"氛围装饰"。待机在跑时每帧记一份，换成别的动作时写回去。
     */
    let ambientOnly = [];
    let ambientSaved = null;
    /**
     * 待机时逐帧录下来的「氛围装饰」参数，以及回放用的游标。
     *
     * 定格时不能只把值**冻住**：爱心本来是飘的，冻住了用户一眼就看出"它不动了"。
     * 引擎没有"逐帧采样某条动作曲线"的接口，motion3 的 `Segments` 又是一串按段类型
     * 交错的裸数字（实测 58 个数里 25 组 (t,v) + 8 个段类型，边界靠"时间单调"推），
     * 与其去猜格式，不如**直接录**：待机在跑时每帧存一份（就是作者原本的动画输出），
     * 定格时按同样的节奏循环回放 —— 既不碰引擎内部，也不会跟原动画走样。
     */
    let ambientTrace = [];
    let ambientCursor = 0;
    /** 待机一个周期多长（录像按它截断，回放的接缝才对得上）。 */
    let ambientPeriodMs = 4000;
    /**
     * 别的槽位还选着动作时，要替它们保住的姿势。
     *
     * 身体只有一个动作（引擎一次只播一个），但**姿势可以同时存在**：`掏出手机` 驱动
     * `phone*` 五个参数、`吹泡泡糖` 驱动 `chuipaopao*` 八个，两组本来就不相交。默认的
     * 交接逻辑会把上一个动作写过的参数**还原**掉，于是"点吹泡泡糖 → 手机没了"（用户报
     * 的"掏出手机跟吹泡泡糖又冲突起来了"）。
     *
     * 这里按 group 录下每个动作最后一帧写过什么，轮到"另一个槽位还在选它、但它不是当前
     * 动作"时，把那一帧写回去。
     */
    let keptPoses = [];
    const poseSnapshots = new Map();
    /**
     * **动作自己要的参数：每帧按住**（`motionOptions.<组>.holdParams = { id: 值 }`）。
     *
     * 和 `preset` 的区别就是"每帧"：`preset` 只写一次，之后会被动作曲线与保姿势回放
     * 盖掉（实测自拍播放中 `phone5` 恒为 0）。抬手这类"动作需要、但它自己又写不对"
     * 的参数只能每帧按住。跟着 `currentEntry` 一起失效，不会留下永久钉住的状态。
     */
    let actionHolds = null;
    /**
     * 诊断："每帧按住"那次写入之后，`phone5` 在模型里是多少、写了多少次、有没有抛错。
     * 用它区分"没执行"与"执行了但之后被覆盖"—— 我在这两者之间来回猜了两轮。
     */
    let holdProbe = null;
    /** 参数名 -> 下标 的缓存（见 parameterIndex）。 */
    const paramIndexCache = new Map();
    /** ~5 秒 @60fps，够盖住这只模型 4 秒的待机循环。 */
    const AMBIENT_TRACE_MAX = 300;
    /**
     * Parameters this controller has deliberately written and must undo.
     * See restoreHeld() — a motion's own curves are not reset by the engine,
     * so anything we pinned on purpose has to be un-pinned on purpose.
     */
    let heldParams = null;
    /** Parameters a retired action wants put back, re-applied every frame. */
    let releasedOverrides = null;
    /**
     * The session phase currently being sustained, if any (requirement #4).
     */
    /**
     * The session phase currently being sustained, if any (requirement #4).
     * While set, finishing the phase's motion re-triggers it instead of
     * dropping to the idle loop, so the pet keeps visibly working.
     */
    let sustainPhase = null;
    let sustainTimer = 0;
    /**
     * True once a held action has finished animating and is just sitting in
     * its final pose.
     *
     * A held pose is deliberately NOT "busy": if it were, the idle-fidget
     * scheduler would never fire again and a session phase could never take
     * the body back, so one click on 掏出手机 would freeze the pet for the rest
     * of the session. It is instead a resting state that merely looks
     * different from the idle loop.
     */
    let settled = false;
    /**
     * **反应跑完之后要回到哪个动作**（`{group, index, options}`，`null` = 回待机）。
     *
     * 由来：摸头 / 摸尾巴是一段"临时表演"，但它结束时 `finishAction` 会 `playIdle()` ——
     * 于是用户刚选好的槽位动作（掏出手机 / 吹泡泡糖）**被整个还原**掉了
     * （用户报的"摸头和摸尾巴不要还原当前动作啊"）。
     *
     * 这里记住"开演之前她在演什么"，反应一结束就把它接回去。接的时候用的是**同一个选项**
     * （`persist`/`hold` 原样带过去），所以举着的手还是举着、泡还是那个泡。
     */
    let resumeAfterAction = null;
    /** Downsampled opacity grid of the rendered character (null = unknown). */
    let hitMask = null;
    /** The stage-local box the grid spans (the model's bounding box). */
    let hitBox = null;

    const notify = () => {
      if (onChange !== null) {
        try {
          onChange(currentGroup, kind);
        } catch {
          /* a listener must never break playback */
        }
      }
    };

    const motionManager = () => model?.internalModel?.motionManager ?? null;

    const clearTimer = () => {
      if (timer !== 0) {
        window.clearTimeout(timer);
        timer = 0;
      }
    };

    /** Stop whatever plays now; required before replaying the same motion. */
    const stopAll = () => {
      try {
        motionManager()?.stopAllMotions?.();
      } catch {
        /* not booted yet */
      }
    };

    /** Resolve one concrete motion entry, clamped to the group's real length. */
    const entryFor = (group, index) => {
      const list = groups[group];
      if (!Array.isArray(list) || list.length === 0) return null;
      const at = Math.max(0, Math.min(index, list.length - 1));
      return list[at];
    };

    /**
     * Per-motion playback policy declared by the pet (pet.json
     * live2d.motionOptions, keyed by motion group):
     *
     *   { "OpenCase": { "hold": true },
     *     "Selfie":   { "prepend": "OpenCase" },
     *     "SprayWater": { "preset": { "jingyu": 1 } } }
     *
     * The model cannot express any of this itself: every motion3.json in this
     * pack declares "Loop": true and only animates its own handful of
     * parameters, so "hold the phone", "raise the phone first" and "the whale
     * is what sprays" are all facts about the AUTHOR's intent that have to be
     * declared alongside the pet.
     */
    const optionsFor = (group) => {
      const declared = motionOptions !== null && typeof motionOptions === "object"
        ? motionOptions[group]
        : undefined;
      return declared !== null && typeof declared === "object" ? declared : null;
    };

    /**
     * Resolve a session phase to a motion group.
     *
     * The per-pet override lives on the component (it comes from pet.json), so
     * the controller reads it through a hook the component installs. Keeping it
     * here rather than in the component is what lets the sustain loop re-trigger
     * a phase's motion without the component driving every beat.
     */
    let phaseMotionFor = () => undefined;

    /**
     * Whether the random idle fidget may pick this motion.
     *
     * Interaction verbs (锤人、喷水) are excluded so the pet never appears to
     * react to something that did not happen; the pet can opt any group back in
     * or out with motionOptions: { "<group>": { "fidget": false | true } }.
     */
    const fidgetAllowed = (group) => {
      const declared = optionsFor(group);
      if (declared !== null && typeof declared.fidget === "boolean") return declared.fidget;
      return FIDGET_DENY.indexOf(group) === -1;
    };

    /** Layer the currently pinned expression back over a freshly started motion. */
    const reapplyExpression = () => {
      if (applyExpression !== null) applyExpression();
    };

    /** The Cubism core model, or null before boot. */
    const coreModel = () => model?.internalModel?.coreModel ?? null;

    /**
     * The head's bounding box in MODEL space, or null when the model has no
     * recognisable facial drawables (in which case every tap counts as a head
     * tap, preserving the old behaviour for unknown models).
     */
    let headBox = null;

    /**
     * Measure the head from the model's own drawable geometry.
     *
     * Runs once per attach. The values are model-space, so they stay valid
     * across resizes and drags; `hitsHead` maps through the live transform.
     */
    /** 头部 / 尾巴部件 id（宿主从 cdi3 的作者命名里挑的）。空 = 该互动退回旧行为。 */
    let headParts = [];
    let tailParts = [];
    /** 由 parts 解出来的 drawable 下标（换模型要重算，缓存起来）。 */
    let headIndices = null;
    let tailIndices = null;
    /** 尾巴类里**贴图落在尾鳍区域**的那几块（收窄结果，换模型要重算）。 */
    let tailFinIndices = null;

    /**
     * 部件 id → drawable 下标（带所属部件下标）：cdi3 的部件名 → 引擎原始表。
     *
     * 为什么不直接用部件 id 去 `getDrawableIndex()`：cdi3 的 `Parts` 是**部件** id
     * （`Part46`、`neck_m` 这种），而那个 API 认的是 **drawable** id（`lianhong`、
     * `Face_line` 这种）—— 两个命名空间不同名，拿部件 id 查永远是 -1（实测这只模型
     * 21 个头部部件一个都解不出来，判定静默退回方框）。
     *
     * 引擎的原始表里有 `drawables.parentPartIndices` 和 `parts.ids`，两边一接就得到
     * "哪些 drawable 属于作者命名为头/脸/眼/眉/嘴/耳/发（或尾/翅/鳍）的那些部件" ——
     * 用的是作者自己的分类，不是猜名字。
     *
     * 返回的是 `[{ index, part }]`：`part` 留着，因为**判定时要按部件透明度过滤**
     * （见 isDrawableVisible）—— 隐藏的配件几何还在原地。
     *
     * @returns {Array<{index:number, part:number}>|null} 表结构不认识时返回 null
     */
    const drawableIndicesForParts = (parts) => {
      const raw = model?.internalModel?.coreModel?._model;
      const im = model?.internalModel;
      const parent = raw?.drawables?.parentPartIndices;
      const partIds = raw?.parts?.ids;
      const coreIds = raw?.drawables?.ids;
      if (parent === undefined || partIds === undefined || coreIds === undefined) return null;
      const ids = Array.from(partIds).map(String);
      if (ids.length === 0 || parts.length === 0) return null;
      const wanted = new Set(parts);
      const coreIndexById = new Map();
      for (let i = 0; i < coreIds.length; i += 1) coreIndexById.set(String(coreIds[i]), i);
      // **以包装层的顺序为主**：顶点就是按 `internalModel.getDrawableIDs()` 的顺序读的
      // （单块 `drawableProbe` 走得通的正是这条路）。反过来"遍历原始表再翻译下标"，
      // 只要两套顺序有一处不一致，取到的顶点就是别的 drawable —— 表现就是"几何明明
      // 又大又真，聚合判定一个都不中"。这里逐个 id 反查它属于哪个部件，不存在歧义。
      const wrapperIds = typeof im?.getDrawableIDs === "function"
        ? Array.from(im.getDrawableIDs()).map(String)
        : null;
      const out = [];
      if (wrapperIds !== null) {
        for (let w = 0; w < wrapperIds.length; w += 1) {
          const coreIndex = coreIndexById.get(wrapperIds[w]);
          if (coreIndex === undefined) continue;
          const partIndex = parent[coreIndex];
          if (partIndex === undefined || partIndex < 0 || partIndex >= ids.length) continue;
          if (!wanted.has(ids[partIndex])) continue;
          out.push({ id: wrapperIds[w], index: w, coreIndex, part: partIndex });
        }
      } else {
        for (let i = 0; i < parent.length; i += 1) {
          const partIndex = parent[i];
          if (partIndex < 0 || partIndex >= ids.length) continue;
          if (!wanted.has(ids[partIndex])) continue;
          out.push({ id: String(coreIds[i]), index: i, coreIndex: i, part: partIndex });
        }
      }
      return out.length > 0 ? out : null;
    };

    /**
     * 这个 drawable 现在"看得见"吗？
     *
     * **注意：判定里不拿它当闸门。** 我试过用透明度过滤隐藏配件，结果是"真尾巴一起
     * 被滤掉"—— 这只宠物的尾巴/翅膀全是**可选配件**，同一时刻只有一个显形，其余靠
     * **缩放成一点**藏起来（被面积下限排掉就够了）；而 `opacities` 表在渲染期未必是
     * 最终值，拿它当闸门会误杀正在显形的那一个。
     *
     * 现在只留给诊断用（`partsDebug` / `partHitCounts` 报"过滤前 vs 过滤后"）。
     * "隐藏翅膀抢走摸头"这个真问题改由**路由优先级**解决：摸头优先于摸尾巴。
     */
    const isDrawableVisible = (entry) => {
      const im = model?.internalModel;
      try {
        if (typeof im?.getDrawableDynamicFlagIsVisible === "function"
          && im.getDrawableDynamicFlagIsVisible(entry.index) === false) return false;
      } catch {
        /* 没有这个 API 就继续看透明度 */
      }
      const raw = im?.coreModel?._model;
      const drawOpacity = raw?.drawables?.opacities?.[entry.index];
      if (typeof drawOpacity === "number" && drawOpacity <= 0.001) return false;
      const partOpacity = raw?.parts?.opacities?.[entry.part];
      if (typeof partOpacity === "number" && partOpacity <= 0.001) return false;
      return true;
    };

    /**
     * 点在不在这些 drawable 的**三角面**里（模型空间）。
     *
     * @param {number[]|null} indices drawable 下标（null = 解不出来）
     * @returns {boolean|null} `null` = 读不到顶点（调用方落回旧行为，别把宠物变哑巴）
     */
    const hitsPartsGeometry = (indices, x, y) => {
      const im = model?.internalModel;
      if (im === undefined || im === null) return null;
      // 顶点用**包装层**的（core 的 `getDrawableVertices` 不在同一个坐标空间里：整条换成
      // core 之后连头部判定都变成 0 命中）。三角形索引只有 core 有；两套按**同一个下标**
      // 取用时是自洽的（单块 `drawableProbe` 用同一组合能命中，已实测）。
      const core = im.coreModel;
      const verticesOf = typeof im.getDrawableVertices === "function"
        ? (index) => im.getDrawableVertices(index)
        : (typeof core?.getDrawableVertices === "function" ? (index) => core.getDrawableVertices(index) : null);
      const indicesOf = typeof core?.getDrawableVertexIndices === "function"
        ? (index) => core.getDrawableVertexIndices(index)
        : (typeof im.getDrawableVertexIndices === "function" ? (index) => im.getDrawableVertexIndices(index) : null);
      if (verticesOf === null || indicesOf === null) return null;
      if (indices === null) return null;
      let read = false;
      try {
        for (const entry of indices) {
          // **调用时用 id 重新解一次下标**，别信缓存的 `entry.index`：
          // 单块 `drawableProbe` 走得通、聚合路径走不通，两者剩下的唯一差别就是这个
          // （它每次都用 id 现查，聚合路径用映射时算好并存下来的那份）。
          let index = entry.index;
          if (typeof entry.id === "string" && typeof im.getDrawableIndex === "function") {
            const fresh = im.getDrawableIndex(entry.id);
            if (fresh >= 0) index = fresh;
          }
          const verts = verticesOf(index);
          if (verts === undefined || verts === null || verts.length < 6) continue;
          read = true;
          // 先用这个 drawable 的包围盒排除（绝大多数部件一眼就出局，不用扫三角形）。
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (let i = 0; i < verts.length; i += 2) {
            const vx = verts[i];
            const vy = verts[i + 1];
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
          }
          if (x < minX || x > maxX || y < minY || y > maxY) continue;
          const indices = indicesOf(index);
          if (indices === undefined || indices === null) continue;
          for (let i = 0; i + 2 < indices.length; i += 3) {
            if (pointInTriangle(x, y, verts, indices[i], indices[i + 1], indices[i + 2])) return true;
          }
        }
      } catch {
        // 读到一半炸了：当作"读不到"，让调用方用方框兜底。
        return null;
      }
      return read ? false : null;
    };

    /**
     * 一块 drawable 的**纹理坐标**包围盒（归一化 0..1），读不到返回 null。
     *
     * 为什么需要它：这只宠物有十几个"尾巴/翅膀"配件，几何同时留在原地 —— 光看几何
     * 分不出谁是谁。而**贴图是作者自己画的**：鲸鱼尾鳍那块贴图区域只属于尾巴。
     * 有了 UV 就能回答"这块 drawable 画的是贴图上哪一块"，那是权威依据。
     *
     * 字段名各版本不一（`vertexUvs` / `uvs`），所以按候选顺序试。
     */
    const readUvs = (index) => {
      const raw = model?.internalModel?.coreModel?._model;
      const drawables = raw?.drawables;
      if (drawables === undefined || drawables === null) return null;
      let table;
      for (const key of ["vertexUvs", "uvs", "drawableVertexUvs"]) {
        const candidate = drawables[key];
        if (candidate !== undefined && candidate !== null) { table = candidate; break }
      }
      if (table === undefined) return null;
      const entry = table[index];
      if (entry === undefined || entry === null) return null;
      const values = Array.from(entry);
      if (values.length < 2) return null;
      let minU = Infinity;
      let minV = Infinity;
      let maxU = -Infinity;
      let maxV = -Infinity;
      for (let i = 0; i + 1 < values.length; i += 2) {
        const u = values[i];
        const v = values[i + 1];
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      return { minU, minV, maxU, maxV };
    };

    /**
     * 尾巴判定**此刻**该用哪几块 drawable（带缓存）。
     *
     * 名字里带尾/翅的部件有 15 个 / 16 块，其中 11 块是可换配件的几何、**一直留在原地**、
     * 横跨从头顶到腰腹的整个角色。全算上的话"算尾巴"的格子占角色 22%，其中 86.6% 同时
     * 算头 —— 而路由是摸头优先，于是**可见的尾鳍永远轮不到**（用户报的"摸尾巴很难点到"）。
     *
     * 收窄依据是**贴图**（作者自己画的）：只留 UV 落在尾鳍区域的那几块（`TAIL_FIN_UV`）。
     * 保守之处：UV 读不到、或者收完一块不剩，就退回原来那一整份 —— 宁愿判定偏松，
     * 也不能让"摸尾巴"整个消失。
     */
    const tailIndicesNow = () => {
      if (tailIndices === null) tailIndices = drawableIndicesForParts(tailParts);
      if (tailFinIndices === null) {
        const narrowed = (tailIndices ?? []).filter((entry) => uvInsideTailFin(readUvs(entry.index)) === true);
        tailFinIndices = narrowed.length > 0 ? narrowed : (tailIndices ?? []);
      }
      return tailFinIndices;
    };

    /**
     * 尾巴类 drawable 此刻的**并集包围盒**（模型空间），读不到返回 null。
     *
     * 两处用：① `hitsMask` 把它并进"算不算落在她身上"（尾鳍摆出静态轮廓网格之外时，
     * 那一瞬间的点击不该落空）；② `[data-hit]` 的 `clip-path` 里拼进去的那块矩形
     * （跟着摆动重建，见 hitPath）。
     */
    const measureTailBox = () => {
      const list = tailIndicesNow();
      const im = model?.internalModel;
      if (list.length === 0 || im === null || im === undefined) return null;
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const entry of list) {
        let index = entry.index;
        if (typeof entry.id === "string" && typeof im.getDrawableIndex === "function") {
          const fresh = im.getDrawableIndex(entry.id);
          if (fresh >= 0) index = fresh;
        }
        let verts;
        try {
          verts = im.getDrawableVertices(index);
        } catch {
          continue;
        }
        if (verts === undefined || verts === null || verts.length < 2) continue;
        for (let i = 0; i + 1 < verts.length; i += 2) {
          const vx = verts[i];
          const vy = verts[i + 1];
          if (vx < box.minX) box.minX = vx;
          if (vx > box.maxX) box.maxX = vx;
          if (vy < box.minY) box.minY = vy;
          if (vy > box.maxY) box.maxY = vy;
        }
      }
      return box.maxX > box.minX && box.maxY > box.minY ? box : null;
    };

    /**
     * 模型空间 → **舞台局部**坐标（CSS px），读不到返回 null。
     *
     * 为什么不用引擎的 `toStagePosition()`：这个包装层上没有它（实测直接抛异常，
     * 外面只看到 null）。改用**两个盒子对齐**：`model.getBounds()` 给的是模型在舞台上的
     * 轴对齐盒，而模型空间里"整只宠物的盒"由全部 drawable 的顶点算出来。两者一比就是
     * 缩放 + 平移（模型的旋转是 0，锚点已经烘进 getBounds），所以这条映射在缩放、
     * 拖动、窗口 resize 之后都成立，也不依赖任何私有字段。
     */
    const modelToStage = (x, y) => {
      const im = model?.internalModel;
      if (model === null || im === null || im === undefined) return null;
      if (typeof im.getDrawableIDs !== "function" || typeof im.getDrawableVertices !== "function") return null;
      let bounds;
      try {
        bounds = model.getBounds();
      } catch {
        return null;
      }
      if (bounds === undefined || bounds === null || !(bounds.width > 0) || !(bounds.height > 0)) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      try {
        for (const id of im.getDrawableIDs()) {
          const index = im.getDrawableIndex(String(id));
          if (index < 0) continue;
          const verts = im.getDrawableVertices(index);
          if (verts === undefined || verts === null) continue;
          for (let i = 0; i + 1 < verts.length; i += 2) {
            if (verts[i] < minX) minX = verts[i];
            if (verts[i] > maxX) maxX = verts[i];
            if (verts[i + 1] < minY) minY = verts[i + 1];
            if (verts[i + 1] > maxY) maxY = verts[i + 1];
          }
        }
      } catch {
        return null;
      }
      if (!(maxX > minX) || !(maxY > minY)) return null;
      return {
        x: bounds.x + (x - minX) / (maxX - minX) * bounds.width,
        y: bounds.y + (y - minY) / (maxY - minY) * bounds.height,
      };
    };

    /** 静态快照网格的判定（`hitsMask` 与诊断读口共用一份实现，避免两处走岔）。 */
    const hitsMaskGrid = (x, y, width, height) => {
      if (hitMask === null) return true;
      if (width <= 0 || height <= 0) return true;
      // The grid covers the model's own bounding box, so normalise against
      // that box rather than the whole stage.
      const box = hitBox ?? { x: 0, y: 0, width, height };
      const gx = Math.floor(((x - box.x) / box.width) * hitMask.width);
      const gy = Math.floor(((y - box.y) / box.height) * hitMask.height);
      // One cell of tolerance: the model breathes and sways, so requiring an
      // exact opaque cell would make edge clicks feel unreliable.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (cx < 0 || cy < 0 || cx >= hitMask.width || cy >= hitMask.height) continue;
          if (hitMask.data[cy * hitMask.width + cx] === 1) return true;
        }
      }
      return false;
    };

    /** 点 (x,y) 在 verts 的第 i0/i1/i2 号顶点组成的三角形里吗（同向叉积法）。 */
    const pointInTriangle = (x, y, verts, i0, i1, i2) => {
      const ax = verts[i0 * 2];
      const ay = verts[i0 * 2 + 1];
      const bx = verts[i1 * 2];
      const by = verts[i1 * 2 + 1];
      const cx = verts[i2 * 2];
      const cy = verts[i2 * 2 + 1];
      // 退化三角形（三个点几乎重合）**面积为零**，叉积全 0 → 下面的判定会返回 true，
      // 于是"每个点都算命中"。隐藏的部件（缩放成一点）正好是这种，必须直接排掉。
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-6) return false;
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(hasNeg && hasPos);
    };


    const measureHead = (nextModel) => {
      try {
        const im = nextModel?.internalModel;
        const ids = im?.getDrawableIDs?.();
        if (ids === undefined || ids === null || typeof im.getDrawableIndex !== "function") return null;
        if (typeof im.getDrawableBounds !== "function") return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let found = 0;
        for (const raw of ids) {
          const id = String(raw);
          if (!HEAD_DRAWABLE_HINTS.test(id)) continue;
          const index = im.getDrawableIndex(id);
          if (index < 0) continue;
          const b = im.getDrawableBounds(index, {});
          if (b === undefined || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
          if (!(b.width > 0) || !(b.height > 0)) continue;
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.width);
          maxY = Math.max(maxY, b.y + b.height);
          found += 1;
        }
        if (found === 0 || maxX <= minX || maxY <= minY) return null;
        // The facial drawables cover the face only; a head pat should also land
        // on the hair, ears and headband around and above it.
        const w = maxX - minX;
        const h = maxY - minY;
        const padX = w * HEAD_PAD_SIDE;
        const padTop = h * HEAD_PAD_TOP;
        const padBottom = h * HEAD_PAD_BOTTOM;
        return {
          minX: minX - padX,
          maxX: maxX + padX,
          minY: minY - padTop,
          maxY: maxY + padBottom,
        };
      } catch {
        return null;
      }
    };

    /**
     * Live parameter state, addressed by NAME.
     *
     * The wrapper's getParameterIndex() compares against CubismId objects, so
     * looking up a string always misses (it returns a fresh out-of-range index
     * and the value reads back undefined). The core model's raw tables are
     * plain string arrays, so the name -> index mapping has to go through
     * those. Reading _model.parameters directly is the only reliable way to
     * touch a parameter by name, and it is stable across the Cubism 3/4/5
     * runtimes the engine supports.
     */
    const parameterIndex = (core, id) => {
      const raw = core?._model?.parameters;
      if (raw === undefined || raw === null) return -1;
      // 缓存：`Array.from(raw.ids)` 每次都**新建一个数组**，而帧内按 id 查找的次数是
      // 上百次（氛围录像一帧 84 次 + 姿势录制 + 表情层），不缓存就是白烧 CPU。
      const hit = paramIndexCache.get(id);
      if (hit !== undefined && hit.raw === raw) return hit.at;
      try {
        const at = Array.from(raw.ids).indexOf(id);
        paramIndexCache.set(id, { raw, at });
        return at;
      } catch {
        return -1;
      }
    };

    const readParameter = (id) => {
      const core = coreModel();
      const at = parameterIndex(core, id);
      if (at < 0) return undefined;
      try {
        return core._model.parameters.values[at];
      } catch {
        return undefined;
      }
    };

    /**
     * The value the last drawn frame holds for this parameter.
     *
     * Differs from readParameter() by exactly the layers this controller
     * applies: readParameter() gives the engine's baseline, this gives what the
     * user is looking at.
     */
    const readDrawn = (id) => {
      const at = parameterIndex(coreModel(), id);
      if (at < 0) return undefined;
      if (drawnValues !== null && at < drawnValues.length) return drawnValues[at];
      return readParameter(id);
    };

    const writeParameter = (id, value) => {
      const core = coreModel();
      const at = parameterIndex(core, id);
      if (at < 0) return false;
      try {
        core._model.parameters.values[at] = value;
        return true;
      } catch {
        return false;
      }
    };

    /**
     * The parameter writes contributed by the pinned expressions.
     *
     * Each entry is { id, value, blend } straight from that expression's own
     * .exp3.json, layered on top of whatever the motion system wrote — which is
     * exactly what those expressions' "Add" blend means.
     */
    let expressionLayers = [];
    /**
     * 表情的淡入淡出进度：参数 id -> { value, blend, weight }。
     *
     * 每帧朝目标权重逼近：本帧在场的 → 1（淡入），不在场的 → 0（淡出）。
     * 权重到 0 就**把这条丢掉、不再写它** —— 留着 weight 0 的条目会让
     * "参数永远关不掉"重演一次，只不过这次是一直写 0（或者更糟：写一个已经
     * 不再需要的基线）。
     */
    const expressionFade = new Map();
    /** 上一帧的时间戳（算 dt 用）；0 表示还没有基准。 */
    let expressionFadeAt = 0;
    /**
     * 尾巴类 drawable 的**实时并集包围盒**（模型空间）与它的采样时刻。
     *
     * 尾鳍一直在摆，而可点击的轮廓遮罩是开机抓一次的静态网格 —— 摆到网格之外的那一瞬，
     * "点在尾巴上"会被判成"没落在她身上"。所以每帧（节流 100ms）采一次这个盒子，
     * `hitsMask` 把它一起算进去：**尾巴摆到哪儿都算她**。
     *
     * 采样放在 saveParameters 缝里（`update()` 之前）—— 那是这一帧真正要画的姿势，
     * 帧外读到的是引擎基线，会慢半拍。
     */
    let tailBoxLive = null;
    let tailBoxSampledAt = 0;
    /** The core model whose saveParameters hook is installed. */
    let hookedCore = null;
    /**
     * Every parameter value the LAST frame actually drew.
     *
     * The engine's frame runs saveParameters() -> update() -> loadParameters(),
     * so loadParameters() lands at the END: it puts the engine's own baseline
     * back over everything written at the save seam. Between frames the live
     * array therefore holds the pose BEFORE the layers — reading it from outside
     * a frame answers "what would the motion have drawn", not "what is on
     * screen".
     *
     * This is what `drawn(id)` answers, and it is the ONLY honest way to assert
     * from a test that a per-frame write reached the screen. The action
     * snapshot deliberately does NOT use it: restoring a drawn value would
     * re-apply the mouth's own old offset and then add the current one on top.
     */
    let drawnValues = null;
    /**
     * 上一帧采样到的、**引擎自己写出来**的每个被还原参数的值。
     *
     * 用来区分"这个参数还有活的东西在驱动"和"它只是停在动作留下的值上"。
     */
    /**
     * 引擎自己的动画系统每帧都在驱动的参数，**永远不进还原表**。
     *
     * 视线跟随（focusController）写 ParamAngleX/Y/Z、ParamEyeBallX/Y，
     * 物理摆动写头发/身体，嘴部与眨眼由本插件每帧写。这些参数一旦被还原表
     * 钉住，宠物就"死"了：实测挤番茄酱 → 无 之后，头不再跟着鼠标转、也不再
     * 有待机摆动（帧外基线明明在动，画面却纹丝不动）。
     *
     * 动作真正私有的参数（chuipaopao*、phone*、danbaofan、ji…）不在此列，
     * 它们才是还原要负责的东西。
     */
    // 名单收得很窄：只有**视线跟随和物理摆动**真正每帧在写的那些。
    // ParamEye* / ParamMouth* 曾经也在里面，代价是动作留下的嘴形永远收不回来 ——
    // 挤番茄酱写过 ParamMouthOpenY/Form，排除掉之后没人还原它，嘴就一直张着。
    // 眼睛同理（动作把它眯起来之后就再也没人睁开）。它们只由动作和本插件的图层
    // 驱动，不跟引擎抢，所以必须留在还原表里。
    const ENGINE_OWNED_PARAM = /^Param(Angle|Body|Breath|Hair)/;
    /**
     * How many times the frame hook actually ran, and what it saw.
     *
     * Everything this controller writes lands in the saveParameters hook, so
     * "the write had no effect" has two very different causes: the hook never
     * ran (a write that lands nowhere), or it ran and something later in the
     * same frame overwrote it. Counting the calls and sampling one parameter
     * either side of the pass is what tells them apart.
     */
    let hookCalls = 0;
    let hookProbe = null;
    /**
     * Samples of one parameter at each seam of the frame.
     *
     * The engine writes its own baseline back at points this controller does
     * not control, so "our write landed" and "our write survived the frame"
     * are different claims. Sampling after loadParameters, after the save
     * hook's own write, and after update() is what separates them.
     */
    let seamAt = -1;
    let loadCalls = 0;
    let loadSample = null;
    let updateCalls = 0;
    let updateSample = null;
    /**
     * The order the engine visits the three seams in, most recent last.
     *
     * Counts cannot tell "load runs before save" from "load runs after it", and
     * that difference decides whether a write at the save seam survives the
     * frame at all.
     */
    let seamOrder = "";
    const markSeam = (ch) => { seamOrder = (seamOrder + ch).slice(-12); };

    /**
     * Apply the pinned expressions' parameters.
     *
     * Expressions blend on top of the motion output, so the write has to land
     * at the exact seam the engine's own expression pass uses — which is AFTER
     * saveParameters(), not after loadParameters().
     *
     * The frame runs: loadParameters() (undo last frame's expression) ->
     * motions write -> saveParameters() (snapshot the pose the motions produced)
     * -> expressions write on top -> deformers. Writing after loadParameters
     * instead puts the value INSIDE the saved snapshot, so it becomes part of
     * the baseline: the next frame restores it and adds another copy on top,
     * and it can never be taken back off. That is exactly the "switches stay on
     * forever" failure.
     */
    /**
     * The procedural animation the pinned slot option asks for, if any.
     *
     * This model ships 点菜手X / 点菜手Y / 点菜手Z (pointX / pointY / pointY2) with a
     * ±30 range and NOTHING in the model ever writes them — the author intended
     * the hand to follow the pointer and never finished it. Driving them here
     * gives the pet a hand that actually moves across the tablet, which is what
     * the "a tool is running" state needed.
     */
    let sweepSpec = null;
    /** Last normalized gaze target, for diagnostics. */
    let gazeTarget = { x: 0, y: 0 };
    /** 0..1 pointer distance, driving the mouth. Eased, not raw. */
    let mouthFollow = 0;
    /** -1..1 pointer height, driving the mouth's shape: up positive. Eased. */
    let mouthLean = 0;
    /** Where the pointer currently says the mouth should be. */
    let mouthTargetFollow = 0;
    let mouthTargetLean = 0;
    /** Timestamp of the previous frame, for frame-rate independent easing. */
    let mouthEasedAt = 0;
    /** When the next blink starts, and when the current one started. */
    let blinkAt = 0;
    let blinkStart = 0;
    /** How shut the eyes were on the last frame, for diagnostics. */
    let blinkWrote = 0;
    /**
     * Blinks started since load.
     *
     * Counted here rather than sampled from outside: a blink is ~225ms end to
     * end and a CDP round trip is easily 100ms+, so a polling test misses most
     * of them and reports "never blinks" for a pet that blinks fine.
     */
    let blinkCount = 0;
    /** The mouth values as last written inside a frame, for diagnostics. */
    let mouthWritten = { open: 0, form: 0 };
    /** Answers whether a motion group's premise currently holds. */
    let guardFor = null;
    /** Last pen position, for diagnostics. */
    let sweepLast = null;

    /**
     * 把被还原的参数写回它们动作之前的值 —— 但只写那些**真的需要钉住**的。
     *
     * 哪些参数进得了这张表，由 ENGINE_OWNED_PARAM 决定（见 snapshot()）：
     * 引擎自己的视线跟随和物理摆动每帧都在写 ParamAngle* / ParamEye* / ParamMouth*，
     * 把它们钉住会让宠物僵掉 —— 实测挤番茄酱收回之后头就不再跟着鼠标转。
     */
    /**
     * 录下当前动作写过的参数（最后一帧的姿势），供 applyKeptPoses 回放。
     *
     * 在帧内读的是**上一帧**的输出（我们的缝在动作更新之前），差一帧无所谓 ——
     * 定格的动作本来就在最后一帧停着。
     */
    const recordPose = (core, values) => {
      const entry = currentEntry;
      if (entry === null) return;
      // **永远录当前动作**，不能等"有人要保"才录：先播的那个动作（掏出手机）在后一个
      // 动作开始时就停了，那时再录已经是空的。
      const frame = poseSnapshots.get(entry.group) ?? {};
      for (const id of entry.params ?? []) {
        const at = parameterIndex(core, id);
        if (at >= 0) frame[id] = values[at];
      }
      poseSnapshots.set(entry.group, frame);
    };

    /**
     * 把"别的槽位还选着的动作"的姿势写回去 —— 右手拿着手机的同时嘴部吹泡泡糖。
     *
     * 写在 applyRelease **之后**（否则会被还原表顶掉），表达式层之前（表情仍然最大）。
     *
     * ⚠️ **动作曲线碰过的参数不能被保姿势录像压住**（这一条修的是用户报的"自拍右手不抬"）：
     * 自拍（`Selfie`）驱动 `phone5`（抬手，在干净试验台里确认过：推 `phone5` 会让
     * `看手机/ArtMesh26` 那块几何变形），但「掏出手机」定格时录下的那一帧里 `phone5=0`，
     * 于是这一层每帧把它写回 0 —— 写在动作更新之后，**曲线被压住**。干净环境实测：
     * 自拍里 `phone5` 涨到 9.713，而手那块几何一动不动（盒完全相同）。
     *
     * 所以：录像里那些**当前动作曲线碰过**的参数跳过不写，让动作说了算；
     * 其余（掏出手机自己的 `phone`/`phone2`/`phone4`/`phone6` 之类）照旧保姿势。
     *
     * ⚠️ **别把它换成"宠物声明的名单"**：我在 3.0.0 那版换成了
     * `motionOptions.<组>.ignoreKeptParams`，结果用户立刻报"自拍又被修坏了" ——
     * 因为 `OpenCase` 的曲线清单本来就含 `phone5`，换名单等于**把这道豁免撤掉**。
     * 这条判据要看的是"动作碰过哪些参数"，`currentEntry.params` 正是这个语义。
     */
    const applyKeptPoses = (core, values) => {
      if (keptPoses.length === 0 || values === null) return;
      const owned = currentEntry === null ? null : currentEntry.params;
      const ownedSet = owned === null || owned === undefined ? null : new Set(owned);
      for (const group of keptPoses) {
        const frame = poseSnapshots.get(group);
        if (frame === undefined) continue;
        for (const id of Object.keys(frame)) {
          if (ownedSet !== null && ownedSet.has(id)) continue;
          const at = parameterIndex(core, id);
          if (at >= 0) values[at] = frame[id];
        }
      }
    };

    const applyRelease = (values, core) => {
      if (releasedOverrides === null || values === null) return;
      for (const id of Object.keys(releasedOverrides)) {
        const at = parameterIndex(core, id);
        if (at >= 0) values[at] = releasedOverrides[id];
      }
    };

    /**
     * 待机在跑时记一份氛围参数，换成别的动作时写回去 —— 否则它们塌回基线 0，
     * 爱心就"开关开着却看不见"（见 ambientOnly 的注释）。
     *
     * 必须在帧内、且在**早退之前**调用：定格时这一层是唯一还在写它们的人。
     */
    const preserveAmbient = (core, values) => {
      if (ambientOnly.length === 0 || values === null) return;
      // 待机（或没有动作）在跑：每帧录一份进环形缓冲（见 ambientTrace 的注释）。
      // **按"一个待机周期"截断**：多录一点，循环回放的接缝处就会跳一下；正好一个
      // 周期（动画本身是周期的）才对得上。
      if (currentGroup === null || currentGroup === idleName) {
        const frame = {};
        for (const id of ambientOnly) {
          const at = parameterIndex(core, id);
          if (at >= 0) frame[id] = values[at];
        }
        ambientSaved = frame;
        const now = Date.now();
        ambientTrace.push({ at: now, values: frame });
        while (ambientTrace.length > 1 && now - ambientTrace[0].at > ambientPeriodMs) ambientTrace.shift();
        if (ambientTrace.length > AMBIENT_TRACE_MAX) ambientTrace.shift();
        ambientCursor = 0;
        return;
      }
      // 别的动作接管了身体：把录下来的那一份**按同样的节奏回放**，爱心继续飘。
      // 录得还不够（刚加载完就播动作）时退回"冻住最后一帧"——至少不会消失。
      if (ambientTrace.length >= 10) {
        const frame = ambientTrace[ambientCursor % ambientTrace.length].values;
        ambientCursor += 1;
        for (const id of ambientOnly) {
          const at = parameterIndex(core, id);
          const value = frame[id];
          if (at >= 0 && value !== undefined) values[at] = value;
        }
        return;
      }
      if (ambientSaved === null) return;
      for (const id of ambientOnly) {
        const at = parameterIndex(core, id);
        const value = ambientSaved[id];
        if (at >= 0 && value !== undefined) values[at] = value;
      }
    };

    const applyExpressionLayers = (core) => {
      // The mouth follows the pointer even with nothing pinned and no sweep, so
      // it has to be part of this condition — otherwise the whole pass bails out
      // before reaching it and the mouth never moves.
      // Ease the mouth toward the pointer BEFORE the early return below: when
      // the pointer leaves the focus range the target drops to 0, and bailing
      // out here would leave the mouth frozen half-open instead of closing.
      {
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        // No upper clamp on dt. The exponential below is only frame-rate
        // independent while dt is the REAL elapsed time; capping it at 120ms
        // made every frame slower than ~8fps ease by a fixed step instead of by
        // wall-clock, so on a loaded machine the mouth visibly lagged the
        // pointer (and a test that slept a fixed 1.5s read a half-travelled
        // mouth). After a real stall — a backgrounded tab — the same formula
        // simply arrives in one step, which is the correct real-time answer.
        const dt = mouthEasedAt === 0 ? 16 : Math.max(1, now - mouthEasedAt);
        mouthEasedAt = now;
        // Exponential, so it is smooth and frame-rate independent.
        const k = 1 - Math.exp(-dt / TUNING.mouthEaseMs);
        mouthFollow += (mouthTargetFollow - mouthFollow) * k;
        mouthLean += (mouthTargetLean - mouthLean) * k;
        if (Math.abs(mouthTargetFollow - mouthFollow) < 0.002) mouthFollow = mouthTargetFollow;
        if (Math.abs(mouthTargetLean - mouthLean) < 0.002) mouthLean = mouthTargetLean;
      }
      // **动作自己要的参数**（`motionOptions.<组>.holdParams`）**不在这里写** ——
      // 缝隙在 `update()` 之前，而曲线是 `update()` 里写的，写在这儿会被曲线盖掉。
      // 真正的实现在 `update()` 的钩子里（搜 `actionHolds`）。
      // Blink. Runs before the early return because it is unconditional — it
      // has nothing to do with what is pinned, and the engine's own blink is
      // disabled precisely because its gate never opens for this model.
      try {
        const values = core._model.parameters.values;
        const left = parameterIndex(core, EYE_L_PARAM);
        const right = parameterIndex(core, EYE_R_PARAM);
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (blinkAt === 0) blinkAt = now + TUNING.blinkMinMs + Math.random() * (TUNING.blinkMaxMs - TUNING.blinkMinMs);
        if (blinkStart === 0 && now >= blinkAt) { blinkStart = now; blinkCount += 1; }
        if (blinkStart !== 0) {
          const elapsed = now - blinkStart;
          const shut = BLINK_CLOSE_MS + BLINK_HOLD_MS;
          let open = 1;
          if (elapsed < BLINK_CLOSE_MS) open = 1 - elapsed / BLINK_CLOSE_MS;
          else if (elapsed < shut) open = 0;
          else if (elapsed < shut + BLINK_OPEN_MS) open = (elapsed - shut) / BLINK_OPEN_MS;
          else {
            blinkStart = 0;
            blinkAt = now + TUNING.blinkMinMs + Math.random() * (TUNING.blinkMaxMs - TUNING.blinkMinMs);
          }
          if (open < 1) {
            // Multiply rather than assign: a pinned expression may already have
            // narrowed the eyes, and a blink must close whatever is there.
            // Skipped when the eyes are already shut, so it cannot fight a wink.
            if (left >= 0 && values[left] > 0.2) values[left] *= open;
            if (right >= 0 && values[right] > 0.2) values[right] *= open;
            blinkWrote = 1 - open;
          } else {
            blinkWrote = 0;
          }
        }
      } catch {
        /* a torn-down model */
      }
      if (expressionLayers.length === 0 && expressionFade.size === 0 && sweepSpec === null
        && mouthFollow <= 0 && mouthLean === 0
        && releasedOverrides === null) {
        // The mouth contributes nothing at rest, and saying so is part of the
        // contract: leaving the last moving values here would report an open
        // mouth after the pointer had already come back to the centre.
        mouthWritten = { open: 0, form: 0 };
        // The release still has to be applied — it is not tied to any of the
        // things this guard is about.
        applyRelease(core._model.parameters.values, core);
        // 氛围参数也一样：**必须在早退之前**。动作定格时这一层是唯一还在写它们的人，
        // 漏在这里就是"开关开着、爱心全没了"。
        preserveAmbient(core, core._model.parameters.values);
        applyKeptPoses(core, core._model.parameters.values);
        recordPose(core, core._model.parameters.values);
        return;
      }
      try {
        const values = core._model.parameters.values;
        applyRelease(values, core);
        preserveAmbient(core, values);
        applyKeptPoses(core, values);
        recordPose(core, values);
        // The mouth follows the pointer too. It has to be written per frame —
        // setting it once from the pointermove handler would be overwritten by
        // the very next frame the motion system runs.
        if (true) {
          const params = core._model.parameters;
          const add = (id, delta) => {
            const at = parameterIndex(core, id);
            if (at < 0) return;
            const min = params.minimumValues[at];
            const max = params.maximumValues[at];
            // Added on top of whatever the pose or a pinned face already wrote,
            // then clamped to the model's own range.
            const next = values[at] + delta;
            values[at] = next > max ? max : (next < min ? min : next);
          };
          const openAt = parameterIndex(core, MOUTH_OPEN_PARAM);
          const formAt = parameterIndex(core, MOUTH_FORM_PARAM);
          if (openAt >= 0) {
            add(MOUTH_OPEN_PARAM, mouthFollow * (params.maximumValues[openAt] - params.minimumValues[openAt]) * TUNING.mouthFollow);
          }
          // Scale the author's own open-mouth direction by how high the pointer
          // is: up leans the shape the way selfie.motion3.json does, down leans
          // it the other way.
          add(MOUTH_FORM_PARAM, mouthLean * TUNING.mouthDrop);
          // The CONTRIBUTION, not the absolute value: the absolute one also
          // carries the pose's own resting shape, which is not ours to assert.
          mouthWritten = {
            open: Number((mouthFollow * TUNING.mouthFollow).toFixed(3)),
            form: Number((mouthLean * TUNING.mouthDrop).toFixed(3)),
          };
        }
        if (sweepSpec !== null) {
          const spec = sweepSpec;
          const at = (id) => (id === undefined ? -1 : parameterIndex(core, id));
          // Add to whatever the pose already wrote rather than replacing it, so
          // the hand still rides the body's own motion.
          const add = (id, delta) => {
            const i = at(id);
            if (i >= 0) values[i] += delta;
          };
          const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
          // A closed loop the pen never leaves: a lemniscate (figure-eight),
          // which is the 2D shadow of a Möbius strip's centre line. The old
          // version was a sawtooth — write left to right, snap back — and the
          // snap is what read as stiff.
          const u = (now / spec.loopMs) * Math.PI * 2;
          // The half-twist: the strip only comes back to itself after TWO
          // passes, so anything tied to the twist runs at half the loop rate.
          const half = u / 2;
          const px = spec.ampX * Math.sin(u);
          const py = spec.ampY * 0.5 * Math.sin(2 * u);
          const drift = spec.driftMs > 0 ? spec.driftY * Math.sin((now / spec.driftMs) * Math.PI * 2) : 0;
          sweepLast = { x: px, y: py + drift };
          add(spec.x, px);
          add(spec.y, py + drift);
          // The pen leans with the twist, so the loop has a front and a back
          // instead of being a flat outline, and stays pressed to the tablet.
          add(spec.rz, spec.ampZ * Math.sin(half));
          add(spec.z, 0.6);
        }
        // ---- 表情层：带淡入淡出 ------------------------------------------
        // 引擎那套表情管理器有 ~1s 的交叉淡入，但多槽位叠加用不了它（一次只持有
        // 一个表达式），所以参数是我们自己写的，而自己写是瞬时的。这里补上缓动。
        {
          const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
          // 首帧没有基准，按 60fps 估一个；上限 200ms 是给"标签页被挂起再回来"
          // 那种长间隔兜底 —— 否则回来第一帧就直接跳到终值，等于没有淡入。
          const dt = expressionFadeAt === 0 ? 16 : Math.min(200, now - expressionFadeAt);
          expressionFadeAt = now;
          const step = dt / EXPRESSION_FADE_MS;
          const live = new Set();
          for (const layer of expressionLayers) {
            if (layer === null || typeof layer.id !== "string") continue;
            live.add(layer.id);
            const entry = expressionFade.get(layer.id);
            if (entry === undefined) {
              // 首次出现：从 0 开始，这就是"淡入"。
              expressionFade.set(layer.id, { value: layer.value, blend: layer.blend, weight: 0 });
            } else {
              entry.value = layer.value;
              entry.blend = layer.blend;
            }
          }
          for (const [id, entry] of Array.from(expressionFade)) {
            const target = live.has(id) ? 1 : 0;
            entry.weight = entry.weight < target
              ? Math.min(target, entry.weight + step)
              : Math.max(target, entry.weight - step);
            if (target === 0 && entry.weight <= 0) expressionFade.delete(id);
          }
          for (const [id, entry] of expressionFade) {
            const at = parameterIndex(core, id);
            if (at < 0 || entry.weight <= 0) continue;
            const w = entry.weight;
            const current = values[at];
            // 三种混合模式都要按权重插值，不能直接乘 —— Overwrite 乘权重会变成
            // "写一个很小的值"，那比不淡入还糟。
            if (entry.blend === "Multiply") values[at] = current * (1 + (entry.value - 1) * w);
            else if (entry.blend === "Overwrite") values[at] = current * (1 - w) + entry.value * w;
            else values[at] = current + entry.value * w;
          }
        }
      } catch {
        /* a torn-down model: nothing to write */
      }
    };

    /**
     * Install the per-frame expression pass.
     *
     * This is what makes several dress-up slots possible at all: the engine's
     * expression manager holds exactly ONE expression, so asking it to layer
     * would render only the last pin. Writing the union ourselves has no such
     * limit, and it is the same arithmetic the engine would have done.
     */
    const installCoreHook = (core) => {
      if (core === null || core === undefined || core === hookedCore) return;
      try {
        if (typeof core.saveParameters !== "function") return;
        const base = core.saveParameters.bind(core);
        core.saveParameters = () => {
          base();
          hookCalls += 1;
          markSeam("S");
          let values = null;
          try {
            values = core._model.parameters.values;
          } catch {
            values = null;
          }
          // Sample the release table's first entry on both sides of the pass.
          const probeId = releasedOverrides === null ? null : Object.keys(releasedOverrides)[0];
          const probeAt = probeId === null || values === null ? -1 : parameterIndex(core, probeId);
          const pre = probeAt >= 0 ? values[probeAt] : null;
          applyExpressionLayers(core);
          // 尾巴的实时盒子（节流）：可点区域要跟着摆动的尾鳍走，见 tailBoxLive 的注释。
          const nowMs = typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
          if (nowMs - tailBoxSampledAt >= TAIL_BOX_SAMPLE_MS) {
            tailBoxSampledAt = nowMs;
            // 私有函数，不是公开读口 `tailBoxNow()` —— 后者挂在 api 对象上，
            // 控制器内部看不到它（这个错误每帧抛一次，外面只表现为"盒子一直是 null"）。
            tailBoxLive = measureTailBox();
          }
          // The layers are now in place and update() is next, so this is the
          // pose the frame is about to draw.
          if (values !== null) {
            if (drawnValues === null || drawnValues.length !== values.length) {
              drawnValues = new Float32Array(values.length);
            }
            drawnValues.set(values);
          }
          hookProbe = probeId === null
            ? null
            : { id: probeId, at: probeAt, pre, post: probeAt >= 0 ? values[probeAt] : null };
          if (probeAt >= 0) seamAt = probeAt;
        };
        const sample = () => {
          if (seamAt < 0) return null;
          try {
            return core._model.parameters.values[seamAt];
          } catch {
            return null;
          }
        };
        if (typeof core.loadParameters === "function") {
          const loadBase = core.loadParameters.bind(core);
          core.loadParameters = () => {
            loadBase();
            loadCalls += 1;
            markSeam("L");
            loadSample = sample();
          };
        }
        if (typeof core.update === "function") {
          const updateBase = core.update.bind(core);
          core.update = () => {
            updateBase();
            updateCalls += 1;
            markSeam("U");
            // **每帧按住的值写在这里**（`update()` 之后 = 这一帧最后一步）。
            //
            // 为什么不在缝隙里（`loadParameters` 那条）：缝隙在 `update()` **之前**，
            // 而动作曲线是 `update()` 里写的 ⇒ 死死被曲线盖住。实测：表装对了
            // （`holds={"phone5":10}`）而 `phone5` 读出来仍是曲线的形状
            // （1.78 → 9.87 → 0）。这正是"动作要写值"必须写在最后的原因。
            if (actionHolds !== null) {
              // ⚠️ 这个 try 是**静默**的：里面任何拼错的变量都会把"写入"一起吞掉，
              // 而外面的症状只是"值没生效"（我在这儿被坑了一轮：探针里写了个不存在的
              // `probeAt`，于是写入根本没跑，而 `holds` 表看起来完全正常）。
              try {
                const values = core._model.parameters.values;
                for (const id of Object.keys(actionHolds)) {
                  const at = parameterIndex(core, id);
                  if (at >= 0) values[at] = actionHolds[id];
                }
                const probeAt = parameterIndex(core, "phone5");
                holdProbe = {
                  wrote: probeAt >= 0 ? values[probeAt] : null,
                  calls: (holdProbe?.calls ?? 0) + 1,
                };
              } catch (error) {
                holdProbe = { error: String(error).slice(0, 120), calls: (holdProbe?.calls ?? 0) + 1 };
              }
            }
            updateSample = sample();
          };
        }
        hookedCore = core;
      } catch {
        /* an engine that will not let us wrap it: pins simply do nothing */
      }
    };

    /**
     * Put a motion's parameters back where they were before it ran.
     *
     * The engine only ever WRITES the parameters a motion curves; it never
     * restores them when the motion stops. That is fine while the idle loop
     * happens to drive the same parameter, but this model's action-specific
     * parameters (chuipaopao*, phone*, pengshui, …) are driven by NOTHING
     * except the action itself. Once 吹泡泡糖 ends, its last written mouth
     * value sticks forever — the "泡泡吹完嘴没还原" bug.
     *
     * The snapshot is taken when the action starts; restoring it on the way
     * back to idle is what makes a one-shot action actually be one-shot.
     */
    const snapshot = (ids, extra) => {
      const out = {};
      const all = (ids || []).concat(extra === null || extra === undefined ? [] : Object.keys(extra));
      for (const id of all) {
        // 引擎自己会一直驱动的身体参数不进来：钉住它们等于把宠物冻住。
        if (ENGINE_OWNED_PARAM.test(id)) continue;
        // 取值顺序（三档，缺一档都会出 bug）：
        //   1. 还挂着的那个动作的快照 —— 它记的是这只手**还没抬起来**时的值；
        //   2. 已经装好的还原表 —— 同样记的是动作之前的值；
        //   3. 引擎自己的值 —— 前两档都没有时才用它。
        //
        // 第 3 档单独用不行：装好还原表之后它是冻结的动作输出（吹泡泡糖第二轮
        // 就是这么把"鼓着的嘴"记成还原目标的）。第 1 档少了更糟：重播同一个动作、
        // 或者走前置链时，它正**举着自己写的东西**——掏出手机之后播自拍（自拍的
        // 前置就是掏出手机），phone 被记成 1，从此谁也放不下这只手。
        //
        // DRAWN 值仍然不用：它把插件图层自己的贡献也算进去了，还原那些会算两遍
        // （还原补一遍嘴的旧偏移，嘴部图层再加一遍当前的）。
        const outstanding = heldParams === null ? null : heldParams.saved;
        const value = outstanding !== null && Object.prototype.hasOwnProperty.call(outstanding, id)
          ? outstanding[id]
          : (releasedOverrides !== null && Object.prototype.hasOwnProperty.call(releasedOverrides, id)
            ? releasedOverrides[id]
            : readParameter(id));
        if (value !== undefined) out[id] = value;
      }
      return out;
    };

    const restore = (snapshotValues) => {
      if (snapshotValues === null || snapshotValues === undefined) return;
      for (const [id, value] of Object.entries(snapshotValues)) writeParameter(id, value);
    };

    /**
     * Undo whatever a finished one-shot action deliberately pinned.
     *
     * NOT a one-shot write: writing the old values straight into the core lands
     * OUTSIDE the frame, and the very next `loadParameters()` restores them from
     * the snapshot — which still holds the action's values, because that snapshot
     * was taken while the action was running. The write vanished, so a parked
     * pose could never be let go (吹泡泡糖 stayed inflated for good).
     *
     * Instead the saved values become a per-frame override: applied every frame
     * at the same seam as everything else, and dropped the moment a new motion
     * starts and takes those parameters over.
     */
    const restoreHeld = () => {
      if (heldParams === null) return;
      // 合并，**不是替换**。
      //
      // 一次只有一个动作在播（desired 只认第一个带 motion 的槽位），但可以有好几个
      // 动作"停在那里"，各自钉着一批参数——点了吹泡泡糖再点掏出手机，两个槽位都还
      // 选着。替换会让先收起来的那个动作凭空失去还原：收掉手机时还原表只剩
      // OpenCase 的快照，chuipaopao:0 那条没了，泡泡就永远挂回脸上。
      // 这就是"三个里任意点两个就还原不回去"。
      //
      // 同名项由新表覆盖：新动作启动时快照读的就是还原缝上的值，也就是旧表正要写的
      // 那个值，两者本来就一致。
      releasedOverrides = Object.assign({}, releasedOverrides, heldParams.saved);
      heldParams = null;
    };

    /**
     * Retire a held action into its resting pose.
     *
     * The motion keeps painting its final frame (it was started with
     * loop:false and has since finished), so nothing has to be re-triggered —
     * the pet just stops counting as busy. The parameter pins stay installed
     * on purpose, and playIdle() releases them when the body changes hands.
     */
    const settleHeld = () => {
      if (settled) return;
      settled = true;
      // `kind` returns to idle (so the body is up for grabs) but the GROUP is
      // deliberately kept: the pet really is parked in 掏出手机's final pose, and
      // both data-motion and the panel chip should keep saying so.
      kind = "idle";
      notify();
    };

    /**
     * Start one entry; false when the group is missing or the start threw.
     *
     * `keep` carries a parameter snapshot from an earlier motion in the same
     * chain: when 掏出手机 is prepended to 自拍, the phone must stay up across
     * both motions, so the second start must NOT re-snapshot (that would
     * capture the already-raised phone and "restore" it to raised forever).
     */
    const start = (entry, priority, options, keep) => {
      if (model === null || entry === null || vendor === null) return false;
      const opts = options || {};
      // `preset` pins parameters the ACTION needs but the motion itself does
      // not animate. 鲸鱼喷水 only writes `pengshui` (碰水); the whale that is
      // supposed to do the spraying is a separate parameter (`jingyu`) that
      // nothing in that motion touches — which is why it looked like a no-op.
      const preset = opts.preset ?? null;
      // 每帧按住的参数（见 actionHolds 的注释）。读宠物声明的 `holdParams`。
      const holdParams = opts.holdParams ?? null;
      actionHolds = holdParams !== null && typeof holdParams === 'object' ? Object.assign({}, holdParams) : null;
      // Stop ONLY when replaying the very same group+index, which is the one
      // case the engine refuses on its own. Clearing the queue unconditionally
      // removed the outgoing motion instantly, so there was nothing left to
      // fade OUT of and every switch became a hard cut — the transitions were
      // being destroyed by this one line.
      const replaying = currentEntry !== null
        && currentEntry.group === entry.group && currentEntry.index === entry.index;
      if (replaying) stopAll();
      // Releasing the previous action's pins before the new one starts keeps
      // two actions from fighting over the same parameter.
      // Snapshot BEFORE releasing the previous action's pins. restoreHeld()
      // replaces the release table a line later, and that table is part of the
      // pose being captured — taking the snapshot after it would drop exactly
      // the values that are holding the previous action's pose (see snapshot()).
      const saved = keep === undefined ? snapshot(entry.params, preset) : keep;
      if (keep === undefined) restoreHeld();
      // Snapshot first: it reads the OVERRIDDEN values, which is the true
      // pre-action state. Then hand back only the parameters this motion
      // actually drives — clearing the whole map here would wipe the release
      // that playIdle() had just installed a line earlier, since playIdle
      // calls restoreHeld() and then start().
      if (releasedOverrides !== null && keep === undefined) {
        for (const id of entry.params ?? []) delete releasedOverrides[id];
      }
      currentGroup = entry.group;
      currentEntry = entry;
      startedAt = Date.now();
      settled = false;
      try {
        // loop:false is essential. Every motion3.json in this model declares
        // "Loop": true, and the engine merges the motion's own flag with the
        // caller's (`setLoop(loop ?? motionData.loop)`), so a motion started
        // without an explicit flag loops forever and never holds a pose.
        void model.motion(entry.group, entry.index, priority, { loop: false });
      } catch {
        currentEntry = null;
        return false;
      }
      // Applied AFTER the snapshot, so retiring the action puts them back.
      if (preset !== null && keep === undefined) {
        for (const [id, value] of Object.entries(preset)) writeParameter(id, value);
      }
      // A chain keeps the ORIGINAL pre-action snapshot, so retiring it undoes
      // everything the whole chain touched rather than just the last motion.
      heldParams = { saved, holds: opts.holds || null };
      reapplyExpression();
      return true;
    };

    /**
     * Drop every override and return to the pristine initial state.
     *
     * Requirement #3: after any action or expression has had its moment, the pet
     * must end up exactly where it started — the idle loop, no pinned
     * expression, no parameter left behind by a motion. This is the one funnel
     * that guarantees it, and it is also what the sustain loop calls when a
     * session phase ends.
     */
    const resetToRest = () => {
      sustainPhase = null;
      window.clearTimeout(sustainTimer);
      sustainTimer = 0;
      restoreHeld();
      playIdle();
    };

    /** Return to the looping idle animation; the resting state of the pet. */
    const playIdle = () => {
      clearTimer();
      token += 1;
      kind = "idle";
      currentEntry = null;
      // 回待机 = 动作结束 ⇒ 松开"每帧按住"的表（见 actionHolds）。
      actionHolds = null;
      if (model === null || idleName === null) return;
      // Coming back to rest retires the previous action's parameter pins, so
      // the bubble-gum mouth (and anything else action-specific) is released
      // before the idle loop takes over.
      restoreHeld();
      const entry = entryFor(idleName, 0);
      if (entry === null) return;
      if (!start(entry, vendor.MotionPriority.IDLE)) return;
      // Idle is the resting state, so it deliberately highlights no chip —
      // notify() reports the committed action, not the running loop.
      currentGroup = null;
      notify();
      // Idle is also started with loop:false, so it has to be re-queued when
      // its declared duration elapses to keep looping.
      if (entry.duration > 0) {
        const mine = token;
        timer = window.setTimeout(() => {
          timer = 0;
          if (mine === token) playIdle();
        }, entry.duration + REACTION_TAIL_MS);
      }
    };

    /**
     * What an action does when its motion finishes.
     *
     * Order of precedence:
     *  1. a sustained session phase re-triggers its own motion (requirement #4),
     *  2. `hold: true` keeps the pose — but only until ACTION_HOLD_MAX_MS, so
     *     nothing can park the pet forever (requirement #3),
     *  3. otherwise fall back to the idle loop.
     */
    const finishAction = (opts) => {
      if (sustainPhase !== null) {
        const mine = token;
        window.clearTimeout(sustainTimer);
        sustainTimer = window.setTimeout(() => {
          sustainTimer = 0;
          if (mine === token && sustainPhase !== null) playSustained();
        }, PHASE_SUSTAIN_GAP_MS);
        return;
      }
      if (opts !== null && opts.hold === true) {
        settleHeld();
        // A SLOT's motion parks for good: 吹泡泡糖 belongs to the mouth slot and
        // 掏出手机 to the hand slot, so their pose is part of the chosen look and
        // must survive until the slot changes. Only an ad-hoc action (a preview
        // from the 动作 tab) is released by the watchdog.
        if (opts.persist === true) return;
        const mine = token;
        window.clearTimeout(sustainTimer);
        sustainTimer = window.setTimeout(() => {
          sustainTimer = 0;
          if (mine === token && sustainPhase === null) playIdle();
        }, ACTION_HOLD_MAX_MS);
        return;
      }
      // **把开演之前的动作接回去**（摸头/摸尾巴是一段临时表演，不该把用户的槽位动作还原）。
      // 检查顺序放在最后：`hold` 那条分支自己会 park（槽位动作在演），不需要接。
      if (resumeAfterAction !== null) {
        const resume = resumeAfterAction;
        resumeAfterAction = null;
        // 相位在这期间接管了就不接：相位优先，接了会跟它抢身体。
        if (sustainPhase === null && playOnce(resume.group, resume.index, resume.options)) return;
      }
      playIdle();
    };

    /** Re-trigger the sustained phase's motion; the sustain loop's heartbeat. */
    const playSustained = () => {
      if (sustainPhase === null) return;
      const group = phaseMotionFor(sustainPhase);
      if (group === undefined || !Array.isArray(groups[group])) {
        // The pet has no motion for this phase; the idle loop is the honest
        // representation of "nothing to show".
        playIdle();
        return;
      }
      playOnce(group, 0, { kind: "phase" });
    };

    /**
     * Play one motion, then either return to idle or hold its final pose.
     *
     * Every motion is started with loop:false, so the controller's own timer
     * always owns the lifetime — the model's declared Duration is what decides
     * how long that is. `hold: true` parks the pet in the last frame instead
     * of snapping back; `prepend` runs a prerequisite motion first.
     */
    const playOnce = (group, index, options) => {
      const entry = entryFor(group, index);
      if (entry === null || model === null || vendor === null) return false;
      // The pet's declared policy is the default; an explicit caller option
      // (the panel, or the session-phase driver) still wins.
      const opts = Object.assign({}, optionsFor(group), options || {});
      // A motion whose premise is missing must not play from ANY caller ——
      // 除非调用方明确 `force`（面板点播：前提已由 playMotion 尽量补齐，别再静默拦掉）。
      if (opts.force !== true && guardFor !== null && guardFor(group) !== true) return false;
      const mine = ++token;
      clearTimer();

      // A prerequisite action (掏出手机 before 拍照) runs first and chains into
      // the real motion. The snapshot is taken BEFORE the prerequisite so that
      // retiring the whole chain puts the phone back down.
      const prepend = opts.prepend === undefined ? null : entryFor(opts.prepend, 0);
      const first = prepend ?? entry;
      const cycleCount = typeof opts.cycles === "number" && opts.cycles > 0 ? opts.cycles : 1;
      const ms = (item) => (item.duration > 0 ? item.duration : REACTION_FALLBACK_MS);
      if (!start(first, vendor.MotionPriority.FORCE, opts)) return false;
      const chainSnapshot = heldParams === null ? null : heldParams.saved;

      kind = opts.kind || "action";
      notify();

      // Every motion in this model declares Loop, so none of them terminate on
      // their own and the controller always owns the lifetime.
      const holdMs = (prepend === null ? ms(entry) * cycleCount : PREPEND_HOLD_MS) + REACTION_TAIL_MS;
      timer = window.setTimeout(() => {
        timer = 0;
        if (mine !== token) return;
        // The prerequisite is done; run the action it was preparing for.
        if (prepend !== null) {
          if (!start(entry, vendor.MotionPriority.FORCE, opts, chainSnapshot)) { finishAction(opts); return; }
          // The chip and data-motion follow the committed action, so the second
          // half of a chain has to announce itself just like the first half.
          notify();
          timer = window.setTimeout(() => {
            timer = 0;
            if (mine !== token) return;
            finishAction(opts);
          }, ms(entry) * cycleCount + REACTION_TAIL_MS);
          return;
        }
        finishAction(opts);
      }, holdMs);
      return true;
    };

    /**
     * A motion that genuinely ended by itself releases the pet back to idle.
     *
     * The event is only trustworthy once the new motion has had time to become
     * the playing one; anything earlier is the stop() artifact described on
     * MOTION_FINISH_GUARD_MS. Because a looping motion never finishes on its
     * own, the duration timer armed by playOnce is the real backstop — this
     * handler exists for non-looping motions, where it retires the pet sooner
     * than the timer would.
     */
    const onMotionFinish = () => {
      if (Date.now() - startedAt < MOTION_FINISH_GUARD_MS) return;
      // Deliberately inert.
      //
      // Every motion is now started with loop:false, so they ALL finish on
      // their own — including the first half of a chain (掏出手机 → 自拍) and
      // actions that must hold their last pose. Acting on this event would
      // cancel the chain or drop the pose at exactly the wrong moment.
      //
      // The controller's own timers are the single authority on what happens
      // when an action ends, because only they know about chains and holds.
    };

    /** Index the model's real motion groups, enriched with declared timing. */
    const indexGroups = (nextModel, catalogMotions) => {
      const declared = {};
      for (const entry of catalogMotions || []) {
        if (entry !== null && typeof entry === "object" && Array.isArray(entry.items)) {
          declared[entry.group] = entry.items;
        }
      }
      const settings = nextModel?.internalModel?.settings?.motions ?? {};
      const out = {};
      for (const group of Object.keys(settings)) {
        const list = settings[group];
        if (!Array.isArray(list) || list.length === 0) continue;
        const meta = declared[group] || [];
        out[group] = list.map((_, index) => {
          const item = meta[index] || {};
          return {
            group,
            index,
            duration: typeof item.duration === "number" ? item.duration : 0,
            loop: item.loop === true,
            // Parameters this motion's curves touch; needed to undo them.
            params: Array.isArray(item.params) ? item.params : [],
          };
        });
      }
      return out;
    };

    const resolveIdleName = (built) => {
      for (const candidate of IDLE_CANDIDATES) {
        if (Array.isArray(built[candidate])) return candidate;
      }
      const keys = Object.keys(built);
      return keys.length > 0 ? keys[0] : null;
    };

    /**
     * 「氛围装饰」参数 = 待机驱动、而其它动作都不碰的那些。
     *
     * 不写死 `j*`：这是从动作自己的参数表里算出来的，换宠物、换模型都成立。
     * 这个模型的结果正好是爱心左/爱心右的 56 个位置参数。
     */
    const computeAmbientOnly = (built, idle) => {
      if (idle === null || !Array.isArray(built[idle])) return [];
      const touched = new Set();
      for (const [group, list] of Object.entries(built)) {
        if (group === idle) continue;
        for (const entry of list) for (const id of entry.params ?? []) touched.add(id);
      }
      const only = new Set();
      for (const entry of built[idle]) {
        for (const id of entry.params ?? []) if (!touched.has(id)) only.add(id);
      }
      return Array.from(only);
    };

    return {
      /** Bind a freshly loaded model and start its idle loop. */
      attach(nextVendor, nextModel, catalogMotions, nextOptions) {
        vendor = nextVendor;
        model = nextModel;
        groups = indexGroups(nextModel, catalogMotions);
        motionOptions = nextOptions ?? null;
        idleName = resolveIdleName(groups);
        // 氛围装饰参数（只有待机在动的那些）：换模型就重算，录像与快照作废。
        ambientOnly = computeAmbientOnly(groups, idleName);
        ambientSaved = null;
        ambientTrace = [];
        ambientCursor = 0;
        poseSnapshots.clear();
        paramIndexCache.clear();
        headIndices = null;
        const idleDuration = idleName === null ? 0 : (groups[idleName]?.[0]?.duration ?? 0);
        ambientPeriodMs = idleDuration > 0 ? idleDuration : 4000;
        // Locate the head once, from the model's own geometry; it is stored in
        // model space so it survives every later resize and drag.
        headBox = measureHead(nextModel);
        // Expressions are written by this controller, not the engine, so the
        // per-frame pass has to be armed on the freshly loaded core.
        installCoreHook(coreModel());
        token += 1;
        clearTimer();
        try {
          motionManager()?.on?.("motionFinish", onMotionFinish);
        } catch {
          /* older engine without the event: the duration timers carry it */
        }
        playIdle();
      },
      /** Unbind before the model is destroyed. */
      detach() {
        clearTimer();
        token += 1;
        model = null;
        vendor = null;
        groups = {};
        motionOptions = null;
        heldParams = null;
        idleName = null;
        kind = "idle";
        currentGroup = null;
        currentEntry = null;
        startedAt = 0;
        heldParams = null;
        settled = false;
        sustainPhase = null;
        window.clearTimeout(sustainTimer);
        sustainTimer = 0;
        phaseMotionFor = () => undefined;
        expressionLayers = [];
        // 淡入淡出的中间态也要清：换了宠物之后这些参数 id 属于上一个模型。
        expressionFade.clear();
        expressionFadeAt = 0;
        sweepSpec = null;
        hookedCore = null;
        drawnValues = null;
        releasedOverrides = null;
        headBox = null;
        hitMask = null;
        hitBox = null;
        tailBoxLive = null;
        tailBoxSampledAt = 0;
        tailIndices = null;
        tailFinIndices = null;
        headIndices = null;
      },
      playIdle,
      playOnce,
      /**
       * Replace the pinned expressions' parameter writes.
       *
       * The component owns the catalog and the pin set, so it hands down fully
       * resolved layers; the controller only applies them.
       */
      setExpressionLayers(layers) {
        expressionLayers = Array.isArray(layers) ? layers : [];
      },
      /** Install (or clear) the procedural sweep the pinned option asks for. */
      setSweep(spec) {
        sweepSpec = spec === undefined || spec === null ? null : spec;
      },
      /** Diagnostic: where the procedural sweep currently has the pen. */
      sweepPosition: () => (sweepSpec === null ? null : sweepLast),
      /** Diagnostic: how many parameter writes the pinned set contributes. */
      expressionLayerCount: () => expressionLayers.length,
      /**
       * Diagnostic: 每个表情参数的淡入淡出进度（0–1）。
       *
       * 淡入是**时间**上的效果，光看"图层在不在"（expressionLayerCount）是看不出来的
       * —— 断言只能读进度本身。
       */
      expressionFade: () => Array.from(expressionFade, ([id, entry]) => [id, Math.round(entry.weight * 1000) / 1000]),
      /**
       * Install the premise check for a motion group.
       *
       * Some motions only make sense in a particular state: a selfie needs the
       * phone already out, the whale spray needs a whale on screen, the ketchup
       * squeeze needs the omurice under it. The resolver answers whether the
       * pet is currently in that state, and playOnce REFUSES the motion when it
       * is not — so no path (panel, fidget, phase) can play an impossible one.
       */
      setGuardResolver(fn) {
        guardFor = typeof fn === "function" ? fn : null;
      },
      /**
       * Diagnostic: the value the last frame DREW for a parameter.
       *
       * The only honest way to assert on a per-frame write from outside the
       * frame: reading the model's live array between frames returns the
       * engine's own baseline, with every layer already loaded back off.
       */
      drawn: (id) => {
        const value = readDrawn(id);
        return value === undefined ? null : value;
      },
      /** Diagnostic: blinks started since load. */
      blinkCount: () => blinkCount,
      /**
       * Diagnostic: the core this controller hooked.
       *
       * An A/B harness reaches the model through its own path; if that path
       * resolves to a DIFFERENT core than the frame hook writes to, every
       * measurement of a per-frame write is worthless. Comparing identities is
       * the only way to rule that out.
       */
      coreIdentity: () => hookedCore,
      /** Diagnostic: the release override and the held snapshot. */
      releaseDebug: () => ({
        release: releasedOverrides === null ? null : Object.keys(releasedOverrides).length,
        releaseSample: releasedOverrides === null ? null : releasedOverrides.chuipaopao,
        held: heldParams === null ? null : Object.keys(heldParams.saved).length,
        heldSample: heldParams === null ? null : heldParams.saved.chuipaopao,
        // Proof that the frame hook runs at all, and that the release pass
        // really moved the parameter it says it moved.
        hookCalls,
        probe: hookProbe,
        /** 还钉着的参数个数（引擎自己还在动的那些已经被交还掉了）。 */
        released: releasedOverrides === null ? null : Object.keys(releasedOverrides).length,
        seamAt,
        loadCalls,
        loadSample,
        updateCalls,
        updateSample,
        seamOrder,
      }),
      /** Diagnostic: how shut the eyes were on the last frame, 0..1. */
      blinkAmount: () => blinkWrote,
      /**
       * Diagnostic: "每帧按住"那张表（`motionOptions.<组>.holdParams`）。
       *
       * 加它的原因：我按"抬手要每帧写值"实现了 `holdParams`，但实机读 `phone5` 仍是
       * 曲线值（8.88 而不是 10）—— 必须能直接看到"表到底有没有被装上、里面是什么"，
       * 否则只能在外面猜是没传进来还是被覆盖了。
       */
      holdDebug: () => ({
        holds: actionHolds === null ? null : Object.assign({}, actionHolds),
        group: currentEntry === null ? null : currentEntry.group,
        kind: kind,
        probe: holdProbe === null ? null : Object.assign({}, holdProbe),
      }),
      /** Force a blink now, so a test does not have to wait for one. */
      blinkNow: () => { blinkAt = 0; blinkStart = (typeof performance !== "undefined" ? performance.now() : Date.now()); },
      /** Diagnostic: how many motions the engine is cross-fading right now. */
      blending: () => {
        try {
          const manager = motionManager();
          if (manager === null || manager === undefined) return -1;
          for (const key of Object.keys(manager)) {
            const value = manager[key];
            if (Array.isArray(value)) return value.length;
          }
          return -2;
        } catch {
          return -3;
        }
      },
      /** Diagnostic: may this group play right now? */
      canPlay: (group) => guardFor === null || guardFor(group),
      /** Install the phase -> group resolver the sustain loop needs. */
      setPhaseResolver(fn) {
        phaseMotionFor = typeof fn === "function" ? fn : () => undefined;
      },
      /**
       * Enter (or leave) a sustained session phase.
       *
       * `null` leaves the phase and drops straight back to the initial idle
       * state, which is also what the watchdog does if a phase never ends.
       */
      setSustain(phase) {
        if (phase === sustainPhase) return;
        sustainPhase = phase === undefined ? null : phase;
        window.clearTimeout(sustainTimer);
        sustainTimer = 0;
        if (sustainPhase === null) {
          // The phase ended: leave whatever it was doing and go back to rest.
          if (kind === "phase") playIdle();
        }
        // A phase only ever STARTS through the component's applyPhase, which
        // runs the motion; this call just arms the sustain.
      },
      /** Force the pet back to its initial idle state (diagnostics / reset). */
      resetToRest,
      /** Diagnostic: the session phase currently being sustained, if any. */
      sustained: () => sustainPhase,
      /**
       * Aim the gaze at a point given in stage pixels.
       *
       * The engine's own model.focus(x, y) CANNOT be used for this. Its
       * implementation is:
       *
       *   const i = x / originalWidth * 2 - 1
       *   const n = y / originalHeight * 2 - 1
       *   const o = Math.atan2(n, i)
       *   focusController.focus(Math.cos(o), -Math.sin(o))
       *
       * It converts the point into a DIRECTION and then takes the unit vector, so
       * the DISTANCE from the centre is thrown away entirely. Every position,
       * however close to the middle, pulls the head to full deflection — and
       * crossing the centre flips the direction by 180 degrees, snapping the gaze
       * from full-left to full-right. That is why a millimetre of mouse movement
       * near the middle swung the whole body.
       *
       * Passing the normalized offset straight to the focus controller keeps the
       * magnitude, so the gaze is proportional to how far the pointer actually is.
       */
      /**
       * 把"指针相对她中心的偏移"翻成注视方向。
       *
       * 接口是**偏移量**（`dx/dy` 相对她中心）加**满偏半径**（`rangePx`），不是"指针坐标 +
       * 一个假盒子"。早先的写法是 `(x, y, width, height)`、内部拿 `width/2` 当中心，
       * 而调用方给的是**视口坐标** —— 两个坐标系混在一句话里，结果 `nx` 恒为满偏（实测：
       * 她中心 2386 配 width 640，`(2386-320)/320` 直接夹到 1）。实参读口一打出来就露了。
       *
       * 现在偏移归偏移、半径归半径，`rangePx` 就是"离她多远算看到最边上"。桌面端与网页端
       * 共用这一条，差别只在调用方给的半径。
       */
      /**
       * 把"指针相对她中心的偏移"翻成注视方向。
       *
       * 接口是**偏移量**（`dx/dy` 相对她中心）加**满偏半径**（`rangePx`），不是"指针坐标 +
       * 一个假盒子"。早先的写法是 `(x, y, width, height)`、内部拿 `width/2` 当中心，
       * 而调用方给的是**视口坐标** —— 两个坐标系混在一句话里，结果 `nx` 恒为满偏（实测：
       * 她中心 2386 配 width 640，`(2386-320)/320` 直接夹到 1）。实参读口一打出来就露了。
       *
       * **偏转强度用圆形范数**：两根轴同一个半径，合成长度压到 1 以内 —— 等距线是正圆。
       * （试过椭圆：竖直方向更宽容，但用户明确要正圆，而且"远近"本来就该由**一个**半径
       * 决定，多一个竖直半径只是多一个要调的旋钮。）
       */
      updatePointer(dx, dy, rangePx) {
        if (model === null) return;
        const range = Math.max(40, Number.isFinite(rangePx) ? rangePx : 320);
        // 诊断：把**进函数的实参**记下来（算错与传错是两回事，只看结果分不出来）。
        gazeTrace.current = Object.assign(gazeTrace.current ?? {}, {
          callIn: { dx: Math.round(dx), dy: Math.round(dy), range: Math.round(range) },
        });
        const shape = (value) => {
          // A small dead zone, so hand tremor near the centre does not make the
          // eyes wander, and a linear ramp beyond it up to full deflection.
          const size = Math.abs(value);
          if (size <= TUNING.gazeDeadzone) return 0;
          const t = Math.min(1, (size - TUNING.gazeDeadzone) / (1 - TUNING.gazeDeadzone));
          return value < 0 ? -t : t;
        };
        // 整体翻转时模型内部 x 轴是镜像的：屏幕上的"左"对应模型的"右"，所以注视的水平
        // 分量要取反，否则鼠标在左、眼睛却往右看（用户报的现象）。
        const shapedX = shape((gazeMirror.flip ? -dx : dx) / range);
        const shapedY = shape(dy / range);
        // 圆形范数：按"到她的距离"压合成长度，方向保留 —— 等距线是正圆。
        const norm = Math.hypot(shapedX, shapedY);
        const scale = norm > 1 ? 1 / norm : 1;
        const nx = shapedX * scale;
        const ny = shapedY * scale;
        gazeTarget = { x: nx, y: ny };
        // How far the pointer is, on the SAME normalized scale the gaze uses, so
        // the mouth and the eyes agree about how far away it is.
        mouthTargetFollow = Math.min(1, Math.hypot(nx, ny));
        // The mouth SHAPE follows the pointer VERTICALLY instead: up is positive
        // and down is negative, so the opening leans with the cursor rather than
        // always curving the same way. ny is screen-down-positive, hence the flip.
        mouthTargetLean = -ny;
        try {
          model.internalModel?.focusController?.focus(nx, -ny);
        } catch {
          /* an engine without a focus controller simply does not follow */
        }
      },
      /**
       * Diagnostic: the mouth parameters as written INSIDE the frame.
       *
       * Deliberately not a live read: outside the frame the engine has already
       * restored the pose, so a read there reports the resting value and looks
       * like nothing happened. That mistake is recorded in the project skill.
       */
      mouthDebug: () => mouthWritten,
      /** Diagnostic: 0..1 pointer distance driving the mouth. */
      mouthFollow: () => mouthFollow,
      /**
       * 诊断：氛围装饰这一层的内部状态。
       *
       * **必须在控制器里定义**：`ambientOnly`/`ambientTrace`/`currentGroup` 都是控制器
       * 闭包里的变量，写成组件作用域的读口会 ReferenceError —— 而且表现为**静默
       * undefined**，不是报错（探针里踩过一次：`JSON.parse(undefined)`）。
       *
       * `trace` 是录到的帧数（< 10 就会退回"冻住最后一帧"）、`group`/`idle` 用来看
       * 当时谁在驱动身体 —— "爱心不动"这类问题先看这几个数。
       */
      ambientDebug: () => ({
        only: ambientOnly.length,
        trace: ambientTrace.length,
        cursor: ambientCursor,
        period: ambientPeriodMs,
        group: currentGroup,
        idle: idleName,
      }),
      /** Diagnostic: the normalized gaze target the pointer last produced. */
      gazeTarget: () => gazeTarget,
      /** Diagnostic: 最近一次 pointermove 的跟随判据（舞台尺寸 / 满偏半径 / 是否算"在看"）。 */
      gazeTrace: () => gazeTrace.current,
      /** Diagnostic: 当前生效的可调项快照（排查"改了没生效"时先看它）。 */
      tuning: () => Object.assign({}, TUNING),
      /**
       * 别的槽位还选着动作时，替它们保住姿势（见 keptPoses 的注释）。
       *
       * 由组件在每次 `chooseSlotOption` 里重算并传进来：清掉某个槽位就等于把它从这张
       * 名单里去掉，它写过的手就交还出去。
       */
      setKeptPoses(groups) {
        keptPoses = Array.isArray(groups) ? groups.filter((g) => typeof g === "string") : [];
        // **不清录像**：名单空掉之后还会再有（先掏出手机、再吹泡泡糖），那时需要的是
        // 掏出手机**当时**录下的那一帧。录像是"永远录当前动作"，所以它一直都在。
      },
      /** Diagnostic: 正在替哪些动作保姿势。 */
      keptPoseDebug: () => ({ kept: keptPoses.slice(), snapshots: Array.from(poseSnapshots.keys()) }),
      /**
       * **诊断专用**：把某几个参数每帧强制写成给定值（传 `null` 清除）。
       *
       * 用途：量"某个参数到底驱动画面上哪一块几何" —— 把它推满量程，看哪几块 drawable
       * 在动。**不要用它当产品功能**：我上一轮拿它（和 `pin`）去"修"动作，把手机盖钉死、
       * 手机都打不开了（用户报的）。它只该出现在探针里。
       */
      forceParams: (map) => {
        forcedParams = map === null || map === undefined ? null : Object.assign({}, map);
      },
      /**
       * 让下一段临时表演**跑完接回**这里给的动作（`null` = 不接，回待机）。
       *
       * 用途：摸头 / 摸尾巴只是一段反应，不该把用户选好的槽位动作还原掉
       * （用户报的"摸头和摸尾巴不要还原当前动作"）。
       */
      resumeAfter: (plan) => {
        resumeAfterAction = plan === null || plan === undefined ? null : plan;
      },
      /** Diagnostic: 现在记着要接回哪个动作。 */
      resumeDebug: () => resumeAfterAction,
      setExpressionApplier(fn) {
        applyExpression = typeof fn === "function" ? fn : null;
      },
      /** Subscribe to motion transitions; the panel chip follows them. */
      subscribe(fn) {
        onChange = typeof fn === "function" ? fn : null;
      },
      /**
       * Install (or clear) the rendered-character alpha mask used to decide
       * whether a press landed on the pet rather than on empty canvas.
       */
      setHitMask(mask, box) {
        hitMask = mask;
        hitBox = box;
      },
      /**
       * Whether the given STAGE-local point is over the character. With no mask
       * available the whole box is accepted, which is the pre-mask behaviour.
       */
      /** Diagnostic: how many cells of the installed mask are opaque. */
      maskInfo() {
        if (hitMask === null) return { present: false };
        let count = 0;
        for (const value of hitMask.data) count += value;
        return { present: true, size: hitMask.width, opaque: count };
      },
      /**
       * The clickable silhouette as SVG path data, in stage-local pixels.
       *
       * Requirement #5: the pet must not swallow clicks meant for the page
       * underneath. DOM hit-testing follows `clip-path`, so an invisible proxy
       * carrying this path lets the transparent margin fall through to whatever
       * is behind while the character itself stays draggable — no per-event JS
       * and no full-canvas interception.
       *
       * The 64x64 grid is merged into rectangles so the path stays short.
       * Returns null while no mask is available (the whole box is live then,
       * which is the pre-mask behaviour).
       */
      maskPath() {
        if (hitMask === null) return null;
        const box = hitBox;
        if (box === null || box.width <= 0 || box.height <= 0) return null;
        const cols = hitMask.width;
        const rows = hitMask.height;
        const raw = hitMask.data;
        // Dilate by one cell so the clip matches hitsMask exactly: that test
        // accepts a hit when ANY neighbour within one cell is opaque, so the
        // exact grid left a one-cell ring (most visibly the top of the head)
        // where a press counted as "on the model" yet fell through the proxy.
        // The same tolerance is what makes edge clicks feel reliable, so the
        // proxy inherits it rather than the other way round.
        const data = new Uint8Array(cols * rows);
        for (let y = 0; y < rows; y += 1) {
          for (let x = 0; x < cols; x += 1) {
            let solid = 0;
            for (let dy = -1; dy <= 1 && solid === 0; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                if (raw[ny * cols + nx] === 1) { solid = 1; break }
              }
            }
            data[y * cols + x] = solid;
          }
        }
        const used = new Uint8Array(cols * rows);
        const cw = box.width / cols;
        const ch = box.height / rows;
        const parts = [];
        for (let y = 0; y < rows; y += 1) {
          for (let x = 0; x < cols; x += 1) {
            const at = y * cols + x;
            if (data[at] !== 1 || used[at] === 1) continue;
            // Extend right while the row stays opaque.
            let w = 1;
            while (x + w < cols && data[y * cols + x + w] === 1 && used[y * cols + x + w] === 0) w += 1;
            // Extend down while the whole span stays opaque.
            let h = 1;
            for (;;) {
              const ny = y + h;
              if (ny >= rows) break;
              let ok = true;
              for (let k = 0; k < w; k += 1) {
                const nAt = ny * cols + x + k;
                if (data[nAt] !== 1 || used[nAt] === 1) { ok = false; break }
              }
              if (!ok) break;
              h += 1;
            }
            for (let yy = y; yy < y + h; yy += 1) {
              for (let xx = x; xx < x + w; xx += 1) used[yy * cols + xx] = 1;
            }
            const px = (box.x + x * cw).toFixed(2);
            const py = (box.y + y * ch).toFixed(2);
            const pw = (w * cw).toFixed(2);
            const ph = (h * ch).toFixed(2);
            parts.push("M" + px + " " + py + "h" + pw + "v" + ph + "h-" + pw + "Z");
          }
        }
        return parts.length === 0 ? null : parts.join("");
      },
      hitsMask(x, y, width, height) {
        if (hitMask === null) return true;
        if (width <= 0 || height <= 0) return true;
        // "落点算不算落在她身上"必须与 **DOM 那一层完全一致**，否则两种坏法都会出现：
        // 事件能进来而判定说不在她身上（点了没反应），或者判定说有而事件进不来（穿透错）。
        // DOM 的 `clip-path` = 静态快照 + **尾巴当前那块矩形**，所以这里也就这两样：
        //   ① 尾巴当前盒子（`measureTailBox`，当前姿势）—— 尾鳍摆出快照时靠它接住；
        //   ② 开机抓的静态轮廓快照（下面那张网格 + 一格容差）。
        //
        // **不能**把头/尾的"几何"算进来：几何比像素宽，"只有几何、没有像素"的点会被判定
        // 说成在她身上，而 DOM 那层并不覆盖它 —— cdp-passthrough 立刻红（character click
        // 落到 page，实测）。头/尾几何是给**路由**用的（决定演什么），不是给"在不在她身上"。
        if (model !== null && vendor !== null) {
          try {
            const point = model.toModelPosition(new vendor.Point(x, y));
            const tailNow = measureTailBox();
            if (tailNow !== null
              && point.x >= tailNow.minX && point.x <= tailNow.maxX
              && point.y >= tailNow.minY && point.y <= tailNow.maxY) return true;
          } catch {
            /* 换算失败就只按网格 */
          }
        }
        return hitsMaskGrid(x, y, width, height);
      },
      /**
       * Diagnostic: 只按**开机抓的静态快照**那张网格判定（不含几何、不含尾巴实时盒子）。
       *
       * "尾鳍摆出快照"这件事没法凭空断言 —— 要证明"这一点在快照外、却在宽限之内"，
       * 就得能把两层分开读。它只用于测试与排查，不参与行为。
       */
      hitsMaskStatic: (x, y, width, height) => hitsMaskGrid(x, y, width, height),
      /** Head-part ids, pushed in by the component once the catalog is ready. */
      setHeadParts(ids) {
        headParts = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
        // 换宠物 / 换模型：下标缓存必须作废，否则会拿旧模型的 drawable 判定。
        headIndices = null;
      },
      /** Tail-part ids（同上，摸尾巴用）。 */
      setTailParts(ids) {
        tailParts = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
        tailIndices = null;
        tailFinIndices = null;
      },
      /**
       * 尾巴类 drawable 此刻的**并集包围盒**（模型空间），读不到返回 null。
       *
       * 用途：`hitsMask` 把它并进"算不算落在她身上"。轮廓遮罩是开机抓一次的静态网格，
       * 而尾鳍一直在摆 —— 摆动幅度大的时候，尾鳍会摆到网格之外，那一瞬间"点在尾巴上"
       * 会被判成"没落在她身上"，事件落空。并把集盒之后，尾巴摆到哪儿都算她。
       */
      tailBoxNow: () => measureTailBox(),
      /**
       * 尾巴这一层要画的形状：**按轮廓那套栅格重采一遍**（舞台局部像素矩形），读不到返回 null。
       *
       * 为什么不是"包围盒 / 凸包 / 逐块矩形"（三种都试过）：那些都是**几何并集**，而
       * `hitsMask` 用的静态轮廓是**栅格**（还是"一格膨胀"的保守版）。两套几何不一致，
       * 差集就成了"能摸到、判定却不算她"的空白区 —— 实测 14 格（网格 20×20），
       * 而**把这一层关掉，那 14 格直接变 0**。用户看到的就是"右下角明明什么都没有却能摸"。
       *
       * 所以这里从**模型空间的三角面**重采一份与静态轮廓同规格的栅格：
       *   * 落在同一个模型包络盒里（归一化方式和 `hitsMaskGrid` 完全一致）；
       *   * 格子边长与静态轮廓同量级，于是两边的贴合程度一样；
       *   * 输出的是矩形列表，由调用方拼成 `M x y h w v h h-w Z`（和 `maskPath()` 同形）。
       */
      tailRectNow: () => {
        const list = tailIndicesNow();
        const im = model?.internalModel;
        if (list.length === 0 || im === null || im === undefined) return null;
        // 目标格数：静态轮廓是 26×26 那一档；这里按包络盒的长边取 30，格子约 10px。
        const bounds = model?.getBounds?.();
        const envelope = bounds ?? hitBox;
        if (envelope === undefined || envelope === null) return null;
        const width = envelope.width;
        const height = envelope.height;
        if (!(width > 0) || !(height > 0)) return null;
        const cells = 30;
        const stepX = width / cells;
        const stepY = height / cells;
        const cols = Math.max(1, Math.round(width / stepX));
        const rows = Math.max(1, Math.round(height / stepY));
        const solid = new Uint8Array(cols * rows);
        const toStage = (x, y) => modelToStage(x, y);
        for (const entry of list) {
          let index = entry.index;
          if (typeof entry.id === "string" && typeof im.getDrawableIndex === "function") {
            const fresh = im.getDrawableIndex(entry.id);
            if (fresh >= 0) index = fresh;
          }
          let verts;
          try {
            verts = im.getDrawableVertices(index);
          } catch {
            continue;
          }
          if (verts === undefined || verts === null || verts.length < 6) continue;
          // 逐三角面打点：每个格心落在某个三角形里就算实心。隐藏配件会"缩放成一点"，
          // 退化三角形由 `pointInTriangle` 直接排掉（它按面积判）。
          const count = Math.floor(verts.length / 2);
          for (let t = 0; t + 2 < count; t += 3) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const k of [t, t + 1, t + 2]) {
              const vx = verts[k * 2];
              const vy = verts[k * 2 + 1];
              if (vx < minX) minX = vx;
              if (vx > maxX) maxX = vx;
              if (vy < minY) minY = vy;
              if (vy > maxY) maxY = vy;
            }
            if (!(maxX > minX) || !(maxY > minY)) continue;
            const gx0 = Math.max(0, Math.floor(((minX - envelope.x) / width) * cols) - 1);
            const gx1 = Math.min(cols - 1, Math.ceil(((maxX - envelope.x) / width) * cols) + 1);
            const gy0 = Math.max(0, Math.floor(((minY - envelope.y) / height) * rows) - 1);
            const gy1 = Math.min(rows - 1, Math.ceil(((maxY - envelope.y) / height) * rows) + 1);
            for (let gy = gy0; gy <= gy1; gy += 1) {
              for (let gx = gx0; gx <= gx1; gx += 1) {
                if (solid[gy * cols + gx] === 1) continue;
                const px = envelope.x + ((gx + 0.5) / cols) * width;
                const py = envelope.y + ((gy + 0.5) / rows) * height;
                if (pointInTriangle(px, py, verts, t, t + 1, t + 2) === true) solid[gy * cols + gx] = 1;
              }
            }
          }
        }
        // 实心格 → 舞台局部矩形（外扩 1px 抵挡 120ms 的摆动采样差；静态轮廓那边也有一格膨胀，
        // 量的口径一致）。相邻格各自成矩形没关系：`clip-path` 是并集。
        const rects = [];
        for (let gy = 0; gy < rows; gy += 1) {
          for (let gx = 0; gx < cols; gx += 1) {
            if (solid[gy * cols + gx] !== 1) continue;
            const x0 = envelope.x + (gx / cols) * width;
            const y0 = envelope.y + (gy / rows) * height;
            const x1 = envelope.x + ((gx + 1) / cols) * width;
            const y1 = envelope.y + ((gy + 1) / rows) * height;
            const a = toStage(x0, y0);
            const b = toStage(x1, y1);
            if (a === null || b === null) continue;
            rects.push({
              x0: Math.min(a.x, b.x) - 1,
              y0: Math.min(a.y, b.y) - 1,
              x1: Math.max(a.x, b.x) + 1,
              y1: Math.max(a.y, b.y) + 1,
            });
          }
        }
        return rects.length === 0 ? null : rects;
      },
      /**
       * 模型空间 → **舞台局部**坐标（CSS px），读不到返回 null。
       *
       * 就是 `hitsHead / hitsTail / hitsMask` 里那条映射的逆向（它们用
       * `model.toModelPosition()`）：用来把"尾巴此刻的包围盒"画到 DOM 上，
       * 做成那一层跟着摆动走的可点区域。
       */
      modelToStage: (x, y) => modelToStage(x, y),
      idleName: () => idleName,
      groups: () => groups,
      /** Declared playback policy for one motion group (diagnostics). */
      optionsFor,
      /** Whether the idle fidget is allowed to pick this motion group. */
      fidgetAllowed,
    /**
     * Whether a tap landed on the head (requirement #1).
       *
       * 有 cdi3 部件名时**按模型自己的三角面**判定：把点映到模型空间，对每个头部
       * drawable 先做包围盒快速排除，再做点在三角形内 —— 用的就是模型当前的几何
       * （发型边缘、脸部轮廓都对），而不是一个手调内边距的方框。顶点每次点击现读，
       * 所以头歪着、身体摆着也是准的。
       *
       * 没有部件名（换宠物、没 cdi3）时退回旧行为：用英文部件名猜出来的方框；
       * 连那个都测不到就返回 true —— 不认识的模型保持"点哪都算头"，而不是变哑巴。
       */
      hitsHead(x, y) {
        if (model === null || vendor === null) return true;
        try {
          // Pass one arg only: the engine then clones into a fresh Point, so
          // the stage-space input and the model-space output never alias.
          const point = model.toModelPosition(new vendor.Point(x, y));
          if (headParts.length > 0) {
            if (headIndices === null) headIndices = drawableIndicesForParts(headParts);
            const hit = hitsPartsGeometry(headIndices, point.x, point.y);
            // 几何判定只在"真的能读到顶点"时算数；读不到就落回方框。
            if (hit !== null) return hit;
          }
          if (headBox === null) return true;
          return point.x >= headBox.minX && point.x <= headBox.maxX
            && point.y >= headBox.minY && point.y <= headBox.maxY;
        } catch {
          return true;
        }
      },
      /**
       * 诊断：把**尾巴类** drawable 的**当前三角面**吐出来（模型空间）。
       *
       * 用来看"收窄前那一整份"里每块的几何落在哪儿（收窄结果见 `tailDebug()`）——
       * 正是靠它量出"16 块里 11 块是配件、横跨整个角色"，才决定按贴图收窄。
       *
       * 单位是模型空间（`toModelPosition` 的坐标系）；配合 `fitBox()` 能换算回屏幕。
       */
      tailDrawables: () => {
        const list = drawableIndicesForParts(tailParts);
        if (list === null) return [];
        const out = [];
        for (const entry of list) {
          let index = entry.index;
          if (typeof entry.id === "string" && typeof model?.internalModel?.getDrawableIndex === "function") {
            const fresh = model.internalModel.getDrawableIndex(entry.id);
            if (fresh >= 0) index = fresh;
          }
          const row = { id: entry.id, index };
          try {
            const verts = model.internalModel.getDrawableVertices(index);
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            const triangles = [];
            for (let i = 0; i + 1 < verts.length; i += 2) {
              const vx = verts[i];
              const vy = verts[i + 1];
              if (vx < minX) minX = vx;
              if (vx > maxX) maxX = vx;
              if (vy < minY) minY = vy;
              if (vy > maxY) maxY = vy;
            }
            const idx = model.internalModel.coreModel.getDrawableVertexIndices(index);
            for (let i = 0; i + 2 < idx.length && triangles.length < 400; i += 3) {
              triangles.push([
                verts[idx[i] * 2], verts[idx[i] * 2 + 1],
                verts[idx[i + 1] * 2], verts[idx[i + 1] * 2 + 1],
                verts[idx[i + 2] * 2], verts[idx[i + 2] * 2 + 1],
              ]);
            }
            const uvs = readUvs(index);
            Object.assign(row, {
              vertices: verts.length / 2,
              triangles: triangles.length,
              box: { minX, minY, maxX, maxY },
              tris: triangles,
              // 纹理坐标（归一化）：用来回答"这块在贴图的哪一块上" —— 贴图才是
              // "哪些部件真的是尾巴"的权威（作者自己画的图）。
              uvBox: uvs === null ? null : uvs,
            });
          } catch (error) {
            row.error = String(error?.message ?? error);
          }
          out.push(row);
        }
        return out;
      },
      /** 诊断：某块 drawable 的**原始 UV 数字**（不做任何换算，看表本身的形状）。 */
      uvRaw: (index = 0) => {
        const raw = model?.internalModel?.coreModel?._model;
        const table = raw?.drawables?.vertexUvs;
        if (table === undefined) return null;
        const entry = table[index];
        return entry === undefined ? null : Array.from(entry).slice(0, 16);
      },
      /** 诊断：core 里所有和 UV 有关的表名（不同版本字段名不一样，先看有什么）。 */
      uvTables: () => {
        const raw = model?.internalModel?.coreModel?._model;
        if (raw === undefined) return null;
        const out = {};
        for (const scope of ["drawables", "parts"]) {
          const table = raw[scope];
          if (table === undefined || table === null) continue;
          out[scope] = Object.keys(table);
        }
        out.drawableKeys = raw.drawables === undefined ? [] : Object.keys(raw.drawables);
        return out;
      },
      /** 诊断：模型自绘包围盒（模型空间）与舞台尺寸，供"模型空间 → 屏幕"换算。 */
      fitBox: () => {
        try {
          const b = model.getBounds();
          return {
            model: { x: b.x, y: b.y, width: b.width, height: b.height },
            scale: typeof model.scale?.x === "number" ? model.scale.x : null,
            position: { x: model.position?.x ?? null, y: model.position?.y ?? null },
            anchor: { x: model.anchor?.x ?? null, y: model.anchor?.y ?? null },
          };
        } catch {
          return null;
        }
      },
      /** Diagnostic: the measured head box in model space, or null. */
      headBox: () => headBox,
      /**
       * 这一下点在尾巴上吗？
       *
       * 和摸头同一套判定（模型自己的三角面），但部件集合不是"名字里带尾/翅的那些"，
       * 而是**再收窄一次**：只留贴图落在尾鳍区域的那几块（见 `tailIndices()`）。
       * 原因见那段注释 —— 16 块里 11 块是配件几何、横跨全身，全算上的话"处处是尾巴"，
       * 而路由摸头优先，可见的尾鳍反而永远轮不到。
       *
       * **没有尾巴部件时返回 false**（不是 true）：摸尾巴是个新增互动，测不出来就不该
       * 乱触发（摸头那边相反，它要兼容没有 cdi3 的旧模型）。
       */
      hitsTail(x, y) {
        if (model === null || vendor === null) return false;
        if (tailParts.length === 0) return false;
        try {
          const point = model.toModelPosition(new vendor.Point(x, y));
          const hit = hitsPartsGeometry(tailIndicesNow(), point.x, point.y);
          return hit === true;
        } catch {
          return false;
        }
      },
      /**
       * Diagnostic: **旧**方框规则（手调内边距的那个），用来跟几何判定对比。
       *
       * 存在的意义是测试：能证明"新规则真的不一样"，而不是两条路返回同一个答案。
       */
      hitsHeadBox: (x, y) => {
        if (headBox === null || model === null || vendor === null) return null;
        try {
          const point = model.toModelPosition(new vendor.Point(x, y));
          return point.x >= headBox.minX && point.x <= headBox.maxX
            && point.y >= headBox.minY && point.y <= headBox.maxY;
        } catch {
          return null;
        }
      },
      /** Diagnostic: 头部部件（来自 cdi3 的作者命名），空数组 = 退回旧判定。 */
      headPartIDs: () => headParts.slice(),
      /** Diagnostic: 模型声明的全部 drawable 名（认"头"只能靠这些名字）。 */
      drawableIDs: () => {
        const im = model?.internalModel;
        return typeof im?.getDrawableIDs === "function" ? Array.from(im.getDrawableIDs()).map(String) : [];
      },
      /**
       * 尾巴判定**实际用的**那几块 drawable（收窄的结果，见 `tailIndicesNow`）。
       */
      tailIndices: () => tailIndicesNow(),
      /** Diagnostic: 尾巴判定的收窄结果（收窄前 / 收窄后各是哪些、各自贴在哪块贴图上）。 */
      tailDebug: () => {
        if (tailIndices === null) tailIndices = drawableIndicesForParts(tailParts);
        const kept = tailIndicesNow();
        const rows = (tailIndices ?? []).map((entry) => {
          const uv = readUvs(entry.index);
          return {
            id: entry.id,
            part: entry.part,
            uv,
            inFin: uvInsideTailFin(uv) === true,
            kept: kept.some((row) => row.id === entry.id),
          };
        });
        return {
          parts: tailParts.length,
          before: (tailIndices ?? []).length,
          after: kept.length,
          region: TAIL_FIN_UV,
          // 实时盒子（hitsMask 会并进"算不算落在她身上"）与它的采样间隔。
          liveBox: tailBoxLive,
          sampleMs: TAIL_BOX_SAMPLE_MS,
          rows,
        };
      },
      /**
       * Diagnostic: 引擎原始表里 drawable → 父部件 的对应关系。
       *
       * cdi3 的 `Parts` 是**部件** id（`Part46` 这种），`getDrawableIndex()` 认的是
       * drawable id（`lianhong` 这种）—— 两个命名空间不同名，直接拿部件 id 去查永远是 -1。
       * 引擎的原始表里带着 `parentPartIndices`，把两边接起来才能用上作者的命名。
       */
      partTables: () => {
        const core = model?.internalModel?.coreModel;
        const raw = core?._model;
        const parts = raw?.parts;
        const drawables = raw?.drawables;
        return {
          partKeys: parts === undefined ? [] : Object.keys(parts),
          partIds: parts?.ids === undefined ? [] : Array.from(parts.ids).map(String),
          drawableKeys: drawables === undefined ? [] : Object.keys(drawables),
          parentPartIndices: drawables?.parentPartIndices === undefined
            ? null
            : Array.from(drawables.parentPartIndices).slice(0, 12),
        };
      },
      /**
       * Diagnostic: 摸头判定的内部状态。
       *
       * cdi3 的 `Parts` 是**部件**（part）id，而 `getDrawableIndex()` 认的是 **drawable**
       * id —— 两个命名空间不一定同名（这只模型里就不同）。所以这里要把"挑到的部件"
       * 和"真的能在模型里解出下标的"分开报，否则判定静默退回方框、外面看不出来。
       */
      headDebug: () => {
        if (headIndices === null) headIndices = drawableIndicesForParts(headParts);
        if (tailIndices === null) tailIndices = drawableIndicesForParts(tailParts);
        const im = model?.internalModel;
        const core = im?.coreModel;
        const has = (target) => ["getDrawableVertices", "getDrawableVertexIndices", "getDrawableIndex", "getDrawableBounds", "getDrawableIDs"]
          .filter((name) => typeof target?.[name] === "function");
        let vertexProbe = "n/a";
        try {
          const v = im?.getDrawableVertices?.(headIndices?.[0]?.index ?? 0);
          vertexProbe = v === undefined ? "undefined" : (v === null ? "null" : "len=" + v.length);
        } catch (error) {
          vertexProbe = "throw: " + String(error?.message ?? error);
        }
        const visible = (list) => (list === null ? 0 : list.filter((entry) => isDrawableVisible(entry)).length);
        return {
          parts: headParts.length,
          drawableIndices: headIndices === null ? 0 : headIndices.length,
          headVisible: visible(headIndices),
          tailParts: tailParts.length,
          tailDrawableIndices: tailIndices === null ? 0 : tailIndices.length,
          tailVisible: visible(tailIndices),
          apiOnInternalModel: has(im),
          apiOnCoreModel: has(core),
          vertexProbe,
          box: headBox,
        };
      },
      /**
       * Diagnostic: 逐部件的透明度 / 几何范围 / drawable 数。
       *
       * "摸头顺带把摸尾巴也触发"这类问题要先分清是**隐藏的配件**（同一时刻只有一个
       * 显形：狐狸尾 / 猫尾 / 狼尾 / 天使翅膀…）几何还留在原地，还是判定本身写错了。
       *
       * **必须挂在控制器上**：`tailParts` 是这一层的闭包变量，放到组件的 api 里会
       * `tailParts is not defined`（我就这么错过一次，调用直接抛异常、外面只看到 undefined）。
       */
      partsDebug: (which) => {
        const list = which === "tail" ? tailParts : headParts;
        const raw = model?.internalModel?.coreModel?._model;
        const im = model?.internalModel;
        const partIds = raw?.parts?.ids === undefined ? [] : Array.from(raw.parts.ids).map(String);
        const parent = raw?.drawables?.parentPartIndices;
        const out = [];
        for (const id of list) {
          const index = partIds.indexOf(id);
          const opacity = raw?.parts?.opacities?.[index];
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let drawables = 0;
          let visibleDrawables = 0;
          if (parent !== undefined) {
            for (let i = 0; i < parent.length; i += 1) {
              if (parent[i] !== index) continue;
              drawables += 1;
              if (isDrawableVisible({ index: i, part: index })) visibleDrawables += 1;
              try {
                const verts = im?.getDrawableVertices?.(i);
                if (verts === undefined || verts === null) continue;
                for (let k = 0; k < verts.length; k += 2) {
                  if (verts[k] < minX) minX = verts[k];
                  if (verts[k] > maxX) maxX = verts[k];
                  if (verts[k + 1] < minY) minY = verts[k + 1];
                  if (verts[k + 1] > maxY) maxY = verts[k + 1];
                }
              } catch {
                /* 读不到就跳过 */
              }
            }
          }
          out.push({
            id,
            partIndex: index,
            opacity: typeof opacity === "number" ? Math.round(opacity * 1000) / 1000 : null,
            drawables,
            visibleDrawables,
            box: maxX > minX
              ? { minX: Math.round(minX), maxX: Math.round(maxX), minY: Math.round(minY), maxY: Math.round(maxY) }
              : null,
          });
        }
        return out;
      },
      /**
       * Diagnostic: 每个部件在模型空间的命中点数（过滤前 / 过滤后）+ 它的 drawable
       * 透明度范围。
       *
       * 采样**直接在模型空间**做，不经过 `vendor.Point` —— 第一版在 api 闭包里用了
       * `vendor`（那是控制器里的变量，这里根本看不到），每次调用都抛异常被 catch 吞掉，
       * 于是所有部件都报 0，看着像"这个部件完全没几何"。
       */
      partHitCounts: (which, cols = 48, rows = 36) => {
        const parts = which === "tail" ? tailParts : headParts;
        const im = model?.internalModel;
        const raw = im?.coreModel?._model;
        const partIds = raw?.parts?.ids === undefined ? [] : Array.from(raw.parts.ids).map(String);
        const parent = raw?.drawables?.parentPartIndices;
        const out = [];
        for (const id of parts) {
          const partIndex = partIds.indexOf(id);
          const entries = [];
          if (parent !== undefined) {
            for (let i = 0; i < parent.length; i += 1) {
              if (partIndex >= 0) {
                if (parent[i] === partIndex) entries.push({ index: i, part: partIndex });
              } else if (typeof im?.getDrawableIndex === "function" && im.getDrawableIndex(id) === i) {
                // id 不在 parts.ids 里（它其实是个 drawable id）：按 drawable 找它自己。
                entries.push({ index: i, part: -1 });
              }
            }
          }
          const opacities = [];
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const entry of entries) {
            const value = raw?.drawables?.opacities?.[entry.index];
            if (typeof value === "number") opacities.push(Math.round(value * 1000) / 1000);
            try {
              const verts = im?.getDrawableVertices?.(entry.index);
              if (verts === undefined || verts === null) continue;
              for (let k = 0; k < verts.length; k += 2) {
                if (verts[k] < minX) minX = verts[k];
                if (verts[k] > maxX) maxX = verts[k];
                if (verts[k + 1] < minY) minY = verts[k + 1];
                if (verts[k + 1] > maxY) maxY = verts[k + 1];
              }
            } catch {
              /* 跳过 */
            }
          }
          let hitsAll = 0;
          let hitsVisible = 0;
          if (entries.length > 0 && maxX > minX && maxY > minY) {
            const visible = entries.filter((entry) => isDrawableVisible(entry));
            const pad = 20;
            for (let iy = 0; iy < rows; iy += 1) {
              for (let ix = 0; ix < cols; ix += 1) {
                const px = (minX - pad) + (maxX - minX + pad * 2) * (ix + 0.5) / cols;
                const py = (minY - pad) + (maxY - minY + pad * 2) * (iy + 0.5) / rows;
                if (hitsPartsGeometry(entries, px, py) === true) hitsAll += 1;
                if (visible.length > 0 && hitsPartsGeometry(visible, px, py) === true) hitsVisible += 1;
              }
            }
          }
          out.push({
            id,
            partIndex,
            drawables: entries.length,
            opacityMin: opacities.length === 0 ? null : Math.min(...opacities),
            opacityMax: opacities.length === 0 ? null : Math.max(...opacities),
            box: maxX > minX ? { minX: Math.round(minX), maxX: Math.round(maxX), minY: Math.round(minY), maxY: Math.round(maxY) } : null,
            hitsAll,
            hitsVisible,
            // 每块报：id / 包装层下标 / 原始表下标。
            // **别再在这里调 `api.xxx`**：`api` 是控制器返回出去的那个对象，控制器内部
            // 看不到它 —— 调了就是 `api is not defined`，整个函数抛异常、所有读数变 0，
            // 而外面看起来像"这个部件完全没有几何"（我为此白查了三轮）。
            entries: entries.map((entry) => ({
              id: entry.id ?? null,
              index: entry.index,
              core: entry.coreIndex,
              part: entry.part,
            })),
          });
        }
        return out;
      },
      /**
       * Diagnostic: 全部 drawable 的 id / 所属部件名 / 顶点数 / 包围盒（模型空间）。
       *
       * 找"她身上真正在画尾巴的那一个"用这个：作者给**部件**起了中文名（尾巴翅膀/猫尾/
       * 大翅膀…），但 drawable 本身多半叫 `ArtMesh123`。按包围盒的位置就能认出来
       * （尾巴在身体下后方、翅膀在两侧）。
       */
      drawableTable: () => {
        const im = model?.internalModel;
        const raw = im?.coreModel?._model;
        const ids = typeof im?.getDrawableIDs === "function" ? Array.from(im.getDrawableIDs()).map(String) : [];
        const partIds = raw?.parts?.ids === undefined ? [] : Array.from(raw.parts.ids).map(String);
        const parent = raw?.drawables?.parentPartIndices;
        const cdi3Names = MANIFEST.current?.partNames ?? {};
        return ids.map((id, index) => {
          const partIndex = parent === undefined ? -1 : parent[index];
          const partId = partIndex >= 0 && partIndex < partIds.length ? partIds[partIndex] : null;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let vertexCount = 0;
          try {
            const verts = im?.getDrawableVertices?.(index);
            if (verts !== undefined && verts !== null) {
              vertexCount = Math.floor(verts.length / 2);
              for (let k = 0; k < verts.length; k += 2) {
                if (verts[k] < minX) minX = verts[k];
                if (verts[k] > maxX) maxX = verts[k];
                if (verts[k + 1] < minY) minY = verts[k + 1];
                if (verts[k + 1] > maxY) maxY = verts[k + 1];
              }
            }
          } catch {
            /* 跳过 */
          }
          return {
            id,
            index,
            partId,
            partName: partId === null ? t("(无部件)") : (cdi3Names[partId] ?? partId),
            vertexCount,
            box: maxX > minX ? { minX: Math.round(minX), maxX: Math.round(maxX), minY: Math.round(minY), maxY: Math.round(maxY) } : null,
          };
        });
      },
      /**
       * Diagnostic: 单看一个 drawable 的三角面判定为什么命中/不命中。
       *
       * 头部判定好用、尾巴判定一个都不中（而它的几何明明又大又真）——这种"同一段代码
       * 对不同 drawable 表现不同"的问题，只能把中间量摊开看：顶点数、索引数、索引范围、
       * 以及用**它自己的重心**去测的结果。
       */
      drawableProbe: (id) => {
        const im = model?.internalModel;
        const index = typeof im?.getDrawableIndex === "function" ? im.getDrawableIndex(id) : -1;
        if (index < 0) return { id, found: false };
        const vertices = im?.getDrawableVertices?.(index);
        const indices = (typeof im?.getDrawableVertexIndices === "function"
          ? im.getDrawableVertexIndices(index)
          : im?.coreModel?.getDrawableVertexIndices?.(index));
        const verts = vertices === undefined || vertices === null ? [] : Array.from(vertices);
        const idx = indices === undefined || indices === null ? [] : Array.from(indices);
        let minIndex = Infinity;
        let maxIndex = -Infinity;
        for (const value of idx) {
          if (value < minIndex) minIndex = value;
          if (value > maxIndex) maxIndex = value;
        }
        const vertexCount = Math.floor(verts.length / 2);
        // 用顶点的平均位置当查询点：它一定在几何内部（凸的情况下）。
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < verts.length; i += 2) {
          sumX += verts[i];
          sumY += verts[i + 1];
        }
        const cx = vertexCount === 0 ? 0 : sumX / vertexCount;
        const cy = vertexCount === 0 ? 0 : sumY / vertexCount;
        let triangles = 0;
        let degenerate = 0;
        let contains = 0;
        for (let i = 0; i + 2 < idx.length; i += 3) {
          triangles += 1;
          const a = idx[i];
          const b = idx[i + 1];
          const c = idx[i + 2];
          if (a * 2 + 1 >= verts.length || b * 2 + 1 >= verts.length || c * 2 + 1 >= verts.length) continue;
          const area = (verts[b * 2] - verts[a * 2]) * (verts[c * 2 + 1] - verts[a * 2 + 1])
            - (verts[c * 2] - verts[a * 2]) * (verts[b * 2 + 1] - verts[a * 2 + 1]);
          if (Math.abs(area) < 1e-6) {
            degenerate += 1;
            continue;
          }
          if (pointInTriangle(cx, cy, verts, a, b, c)) contains += 1;
        }
        return {
          id,
          found: true,
          index,
          vertexCount,
          indexCount: idx.length,
          minIndex: Number.isFinite(minIndex) ? minIndex : null,
          maxIndex: Number.isFinite(maxIndex) ? maxIndex : null,
          triangles,
          degenerate,
          centroidHits: contains,
          centroid: { x: Math.round(cx), y: Math.round(cy) },
        };
      },
      /**
       * Play a motion with its declared policy applied; used by the panel, the
       * tap reaction and the session-phase driver.
       */
      playGroup(group, index, overrides) {
        return playOnce(group, index, overrides);
      },
      currentGroup: () => currentGroup,
      /**
       * Whether the body is actively animating something the user asked for.
       * A held pose has settled into rest, so it reports false — otherwise a
       * single 掏出手机 would suppress idle fidgets and session phases forever.
       */
      isPlaying: () => kind !== "idle" && !settled,
      /** Diagnostic: is the pet parked in a held pose? */
      isHeld: () => settled,
      /**
       * Which kind of action owns the body right now ('idle', 'tap', 'panel',
       * 'fidget', 'phase'). Session phases may preempt each other but must
       * never cut off something the user just triggered.
       */
      kind: () => kind,
    };
  }

  // ------------------------------------------------------------- storage

  function loadStored() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveStored(patch) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(Object.assign(loadStored(), patch)));
    } catch {
      /* storage is best-effort */
    }
  }

  // ------------------------------------------------------------- runtime

  /** Inject one classic script; repeat calls share the same in-flight promise. */
  const scriptCache = new Map();
  function injectScript(src) {
    let pending = scriptCache.get(src);
    if (pending === undefined) {
      pending = new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = src;
        tag.async = false;
        tag.onload = () => resolve();
        tag.onerror = () => reject(new Error("script failed: " + src));
        document.head.appendChild(tag);
      });
      scriptCache.set(src, pending);
    }
    return pending;
  }

  /** Ensure the user-supplied Cubism Core global exists. */
  async function ensureCore(coreUrl) {
    if (window.Live2DCubismCore !== undefined) return true;
    try {
      await injectScript(coreUrl);
    } catch {
      return false;
    }
    return window.Live2DCubismCore !== undefined;
  }

  async function ensureVendor(vendorUrl) {
    if (window.__dshLive2dPetVendor !== undefined) return window.__dshLive2dPetVendor;
    await injectScript(vendorUrl);
    return window.__dshLive2dPetVendor;
  }

  let vendorConfigured = false;
  function configureVendor(vendor) {
    if (vendorConfigured) return;
    vendorConfigured = true;
    vendor.extensions.add(vendor.Live2DPlugin);
    vendor.configureCubismSDK({ memorySizeMB: 64 });
  }

  // ---- 贴图从哪儿取：blob Worker，还是主线程（issue #10）----
  //
  // 症状（DSH NEXT 2.0.20-next 实测）：模型 JSON / moc3 / 动作都取得到，**只有贴图**
  // 403，宠物显示「加载失败」：
  //   [WorkerManager.loadImageBitmap] Failed to fetch
  //   dsh-app://app/api/live2d-pet/asset/<pet>/textures/texture_01.png: 403 Forbidden
  //
  // 根因在读图的那条路上：那一版给 `dsh-app:` 协议加了「渲染器能力令牌」，令牌只由
  // 主进程的 webRequest 给**主窗口帧发出的请求**补上；而 Electron 不把自定义协议上的
  // Worker 请求交给 webRequest（DSH 自己的注释也这么写）。Pixi 8 的 `loadTextures`
  // 默认就在 blob Worker 里 fetch（`WorkerManager.loadImageBitmap`），于是 Worker 里
  // 的每个贴图请求都撞门禁。官方桌面端同样是 `dsh-app:` 却正常 —— 那边没有这道门。
  //
  // 所以判据不能只看协议名（同名协议两种行为），只能真发一个请求问一句：同一个地址
  // Worker 取得到就继续用 Worker（保住 `createImageBitmap` 在 Worker 里解码的好处），
  // 取不到就让 Pixi 走主线程 fetch（主线程的请求会被补上令牌）。
  const TEXTURE_PROBE_TIMEOUT_MS = 1500;
  /** 探测只做一次：`null` = 还没问；决定之后这个 promise 一直复用。 */
  let textureTransport = null;
  /** 诊断读口：'worker' / 'main-thread' / 'default'（vendor 太老、没有 Assets 时）。 */
  let textureTransportName = "pending";

  /** 在 blob Worker 里取一次 `url`：取得到返回 true，任何失败（含超时）都算取不到。 */
  function workerCanFetch(url) {
    return new Promise((resolve) => {
      let worker = null;
      let objectUrl = "";
      let timer = 0;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker !== null) worker.terminate();
        if (objectUrl !== "") URL.revokeObjectURL(objectUrl);
        resolve(ok);
      };
      timer = setTimeout(() => finish(false), TEXTURE_PROBE_TIMEOUT_MS);
      try {
        const code = "self.onmessage = (event) => { fetch(event.data).then("
          + "(response) => self.postMessage(response.ok ? \"ok\" : \"status:\" + response.status),"
          + "(error) => self.postMessage(\"error:\" + ((error && error.message) || error))); };";
        objectUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        worker = new Worker(objectUrl);
        worker.onmessage = (event) => finish(event.data === "ok");
        worker.onerror = () => finish(false);
        worker.postMessage(url);
      } catch {
        finish(false);
      }
    });
  }

  /**
   * 尽早把探测发出去：它只依赖 `Worker` 与地址，不依赖 core / vendor / renderer。
   * 与那些初始化并行跑，正常网络下几乎不占首屏时间；结果只在取贴图前才需要。
   */
  let textureProbe = null;
  function startTextureProbe(probeUrl) {
    if (textureProbe === null) textureProbe = workerCanFetch(probeUrl);
    return textureProbe;
  }

  /**
   * 决定贴图取法。**必须在 `Live2DModel.from` 之前跑完** —— Pixi 在模型加载里就会去取贴图。
   *
   * 探测的是模型自己的地址：门禁按路径前缀拦（`/api/*`），贴图与模型 JSON 同一条路，
   * 而且这个请求紧接着就会被引擎再取一次（浏览器缓存命中），等于不额外花钱。
   */
  function prepareTextureTransport(vendor, probe) {
    if (textureTransport !== null) return textureTransport;
    textureTransport = (async () => {
      const assets = vendor.Assets;
      if (assets === undefined || typeof assets.setPreferences !== "function") {
        // 老 vendor（没有 Assets 导出）：按默认走，绝不能因为这个把宠物卡住。
        textureTransportName = "default";
        return;
      }
      if (await probe) {
        textureTransportName = "worker";
        return;
      }
      assets.setPreferences({ preferWorkers: false });
      textureTransportName = "main-thread";
    })();
    return textureTransport;
  }

  // --------------------------------------------------------------- style

  const STYLE_ID = "dsh-live2d-pet-style";
  // The selector every rule below hangs off is the PET's own root div
  // ('data-dsh-live2d-pet'), not the bare React container that carries
  // ROOT_ATTR — the container is only a mount point and a takeover marker.
  const ROOT_SEL = "[" + PET_ATTR + "]";
  /**
   * 滑杆的样子（**只管外观，不管布局**）。两个地方共用：DSH 设置页那排滑杆、
   * 右键面板底部那个"大小"滑杆。
   *
   * 原生 range 在 Chromium 上就是"一根粗蓝棍 + 一个大圆钮"，和旁边那套细线药丸
   * 完全不是一个语言。压成 3px 轨道 + 12px 圆钮：轨道只是一条线，圆钮略带投影浮在
   * 上面，已拖过的一段用强调色填满 —— 一眼能看出"这根已经推到哪了"。
   *
   * 填充比例由每个 input 自己带的 `--fill` 提供。那是**一个值**（不是布局），
   * 所以写在行内不违反"布局全在样式表里"那条约定；样式表只负责读它。
   * 顺带把 `accent-color` 去掉了：圆钮现在是自己画的，留着它只会让 focus 之类的
   * 原生着色跟手工圆钮打架。
   *
   * 尺寸做成 `--slider-track` / `--slider-thumb` 两个 token，**挂在元素上**而不是
   * 只写在伪元素里：Chromium 的 CSSOM 不认识 webkit 伪元素 ——
   * `getComputedStyle(el, "::-webkit-slider-thumb")` 会**静默退化成返回元素自身**的
   * 计算样式（实测读回 366px×18px，正是 input 自己的盒子），所以轨道/圆钮的尺寸
   * 在伪元素上根本量不到。token 挂在元素上就能精确断言，伪元素只负责引用它们。
   */
  const sliderLook = (sel) => [
    sel + "{-webkit-appearance:none;appearance:none;background:transparent;border:0;"
      + "padding:0;height:18px;cursor:pointer;--slider-track:3px;--slider-thumb:12px}",
    sel + "::-webkit-slider-runnable-track{height:var(--slider-track);border-radius:999px;"
      + "background:linear-gradient(to right,rgba(120,170,255,.9) 0 var(--fill,0%),"
      + "rgba(127,127,127,.22) var(--fill,0%) 100%)}",
    // margin-top 用 calc 由 token 推：圆钮要垂直居中到轨道上，就是 (轨道-圆钮)/2。
    sel + "::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;"
      + "width:var(--slider-thumb);height:var(--slider-thumb);"
      + "margin-top:calc((var(--slider-track) - var(--slider-thumb)) / 2);border:0;border-radius:50%;"
      + "background:rgba(120,170,255,1);box-shadow:0 1px 3px rgba(0,0,0,.28);"
      + "transition:transform .12s ease-out}",
    sel + ":hover::-webkit-slider-thumb{transform:scale(1.15)}",
    sel + ":active::-webkit-slider-thumb{transform:scale(1.28)}",
    sel + ":focus-visible{outline:2px solid rgba(120,170,255,.55);outline-offset:3px;border-radius:4px}",
    // Firefox 一并给：它没有 webkit 那套伪元素，但有原生的 ::-moz-range-progress。
    sel + "::-moz-range-track{height:var(--slider-track);border-radius:999px;background:rgba(127,127,127,.22)}",
    sel + "::-moz-range-progress{height:var(--slider-track);border-radius:999px;background:rgba(120,170,255,.9)}",
    sel + "::-moz-range-thumb{width:var(--slider-thumb);height:var(--slider-thumb);border:0;border-radius:50%;"
      + "background:rgba(120,170,255,1);box-shadow:0 1px 3px rgba(0,0,0,.28)}",
  ];
  const CSS = [
    // The root never takes the pointer itself (requirement #5): a transparent
    // div still swallows clicks across its whole box, which is what made the
    // empty margin of the canvas block the page behind it. Only the explicitly
    // re-armed children below are interactive.
    ROOT_SEL + "{position:fixed;z-index:2147483000;user-select:none;-webkit-user-select:none;touch-action:none;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;pointer-events:none}",
    // The stage itself never takes the pointer: it would swallow every click in
    // the transparent margin. The proxy below is the only interactive layer.
    ROOT_SEL + " [data-stage]{position:relative;width:100%;height:100%;border-radius:14px;overflow:visible;pointer-events:none}",
    ROOT_SEL + " [data-stage][data-dragging]{cursor:grabbing}",
    ROOT_SEL + " [data-stage] canvas{display:block;width:100%!important;height:100%!important}",
    // The hit-through proxy: an invisible box clipped to the character's
    // silhouette. DOM hit-testing honours clip-path, so the transparent margin
    // falls through to the page while the character stays draggable (#5).
    // While no mask is ready the proxy is hidden and the stage keeps the whole
    // box live, which is the safe pre-mask behaviour.
    ROOT_SEL + " [data-hit]{position:absolute;inset:0;cursor:grab;pointer-events:auto}",
    ROOT_SEL + " [data-stage][data-dragging] [data-hit]{cursor:grabbing}",
    ROOT_SEL + " [data-hit][data-off]{display:none}",
    // 尾巴那一块（那一截矩形由 JS 每 ~120ms 跟着摆动重建，见 hitPath）。
    // Until the silhouette is known the whole box stays live, so the pet is
    // never inert; it degrades to the pre-mask behaviour instead of nothing.
    ROOT_SEL + " [data-stage][data-nomask]{pointer-events:auto;cursor:grab}",
    // ---- 主题：面板 / 气泡的两套配色 ------------------------------------
    // 面板和气泡是**我们自己的**表面，但宿主有浅色与深色两套主题，写死一套必然有一
    // 边瞎（用户："现在是浅色模式，点开却是深色面板"）。
    //
    // 基准取**左侧边栏**的 backgroundColor（项目规则：主题色一律以它为准），
    // 由 readHostTheme() 读出来写成根节点上的 `data-theme`，这里只负责配色。
    ROOT_SEL + "{--pp-surface:rgba(22,29,46,.95);--pp-bubble-a:rgba(38,52,84,.95);"
      + "--pp-bubble-b:rgba(21,28,46,.95);--pp-ink:#e8eefc;--pp-ink-strong:#eaf1ff;"
      + "--pp-chip-ink:#dce6f8;--pp-muted:#9fb0cf;--pp-dim:#8ea3c8;--pp-faint:#7f90ad;"
      + "--pp-line:rgba(120,170,255,.24);--pp-line-soft:rgba(120,170,255,.14);"
      + "--pp-line-strong:rgba(160,200,255,.55);--pp-chip:rgba(255,255,255,.055);"
      + "--pp-soft:rgba(255,255,255,.08);--pp-hover:rgba(255,255,255,.14);"
      + "--pp-accent:rgba(120,170,255,.2);--pp-accent-2:rgba(120,170,255,.24);"
      + "--pp-accent-3:rgba(120,170,255,.34);--pp-shadow:0 14px 40px rgba(0,0,0,.44);"
      + "--pp-shadow-sm:0 8px 24px rgba(0,0,0,.35)}",
    // 浅色：底色换白、墨色换近黑。强调色仍是同一个蓝，只把透明度降下来 ——
    // 深底上合适的 20% 蓝放到白底上会发脏。
    ROOT_SEL + "[data-theme='light']{--pp-surface:rgba(255,255,255,.94);"
      + "--pp-bubble-a:rgba(255,255,255,.97);--pp-bubble-b:rgba(243,246,251,.97);"
      + "--pp-ink:#1f2733;--pp-ink-strong:#101725;--pp-chip-ink:#26313f;"
      + "--pp-muted:#5d6b82;--pp-dim:#6b7a91;--pp-faint:#7c8a9e;"
      + "--pp-line:rgba(28,42,74,.16);--pp-line-soft:rgba(28,42,74,.1);"
      + "--pp-line-strong:rgba(60,110,200,.45);--pp-chip:rgba(20,30,50,.045);"
      + "--pp-soft:rgba(20,30,50,.05);--pp-hover:rgba(20,30,50,.09);"
      + "--pp-accent:rgba(90,140,230,.15);--pp-accent-2:rgba(90,140,230,.18);"
      + "--pp-accent-3:rgba(90,140,230,.26);--pp-shadow:0 14px 34px rgba(20,30,50,.18);"
      + "--pp-shadow-sm:0 8px 20px rgba(20,30,50,.14)}",
    // 漫画对白：实色纸面、墨线和短尾巴，让文字属于角色；深色主题保留柔和对比。
    ROOT_SEL + " [data-bubble]{--speech-paper:#fffaf0;--speech-ink:#34465a;--speech-line:#8b9eae;position:fixed;left:50%;top:12%;z-index:2;box-sizing:border-box;max-width:min(15.7143em,calc(100vw - 24px));width:max-content;padding:.8571em 1.1429em;border-radius:1.7143em 2em 1.8571em 1.4286em / 1.5714em 1.7143em 1.4286em 1.8571em;background:var(--speech-paper);border:clamp(1px,.1071em,2px) solid var(--speech-line);box-shadow:0 4px 12px rgba(48,67,86,.12);color:var(--speech-ink);font-family:inherit;font-size:calc(14px * var(--speech-scale,1));font-weight:500;line-height:1.65;letter-spacing:.02em;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;visibility:hidden;transition:left 140ms ease-out,top 140ms ease-out}",
    ROOT_SEL + "[data-theme='dark'] [data-bubble]{--speech-paper:#344457;--speech-ink:#f0eee7;--speech-line:#72869c;box-shadow:0 4px 14px rgba(0,0,0,.2)}",
    // 继承根节点的可见性：让位时根节点是 hidden，气泡不能自己顶成 visible
    // （fixed 不被 hidden 祖先裁掉，visibility 却会被子元素覆盖）。
    ROOT_SEL + " [data-bubble][data-placed]{visibility:inherit}",
    ROOT_SEL + " [data-bubble]::after{content:'';position:absolute;right:.7143em;bottom:-.5em;width:.7143em;height:.7143em;background:var(--speech-paper);border-right:clamp(1px,.1071em,2px) solid var(--speech-line);border-bottom:clamp(1px,.1071em,2px) solid var(--speech-line);transform:skewX(28deg);border-radius:0 0 .2143em 0}",
    ROOT_SEL + " [data-bubble][data-side='right']::after{right:auto;left:.7143em;transform:skewX(-28deg);border-right:0;border-left:clamp(1px,.1071em,2px) solid var(--speech-line)}",
    "@media (prefers-reduced-motion:reduce){" + ROOT_SEL + " [data-bubble]{transition:none}}",
    // Sits outside the pet's box entirely, so it must re-arm itself.
    ROOT_SEL + " [data-panel]{position:absolute;right:calc(100% + 10px);bottom:0;width:270px;max-height:min(440px,72vh);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--pp-surface);backdrop-filter:blur(14px);border:1px solid var(--pp-line);box-shadow:var(--pp-shadow);color:var(--pp-ink);font:400 12px/1.5 inherit;pointer-events:auto}",
    ROOT_SEL + " [data-panel] header{display:flex;align-items:center;gap:6px;padding:9px 11px;border-bottom:1px solid var(--pp-line-soft);font-weight:600}",
    ROOT_SEL + " [data-panel] header select{flex:1;min-width:0;background:var(--pp-soft);color:inherit;border:1px solid var(--pp-line);border-radius:7px;padding:4px 6px;font:inherit}",
    ROOT_SEL + " [data-panel] header [data-title]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ROOT_SEL + " [data-panel] header [data-close]{margin-left:auto;flex:none;width:22px;height:22px;padding:0;line-height:1;border:0;border-radius:6px;background:transparent;color:var(--pp-muted);font:400 15px/1 inherit;cursor:pointer}",
    ROOT_SEL + " [data-panel] header [data-close]:hover{background:var(--pp-hover);color:var(--pp-ink-strong)}",
    // The panel is the whole UI now, so it also owns the hint that tells you
    // how to get rid of it.
    ROOT_SEL + " [data-panel] [data-hintrow]{padding:0 10px 7px;color:var(--pp-faint);font-size:10px;line-height:1.5}",
    ROOT_SEL + " [data-panel] [data-tabs]{display:flex;gap:2px;padding:6px 8px 0}",
    ROOT_SEL + " [data-panel] [data-tabs] button{flex:1;border:0;background:transparent;color:var(--pp-muted);font:600 11px/2 inherit;border-radius:7px;cursor:pointer}",
    ROOT_SEL + " [data-panel] [data-tabs] button[data-on]{background:var(--pp-accent);color:var(--pp-ink-strong)}",
    ROOT_SEL + " [data-panel] [data-body]{flex:1;overflow:auto;padding:8px}",
    // 桌面端的「设置」页签把面板加宽一档：设置正文是**表格**（池子、相位、关系），
    // 270px 里那几列会挤成一团。加宽只发生在这一个页签上，别的页签宽度不变。
    ROOT_SEL + " [data-panel][data-wide]{width:342px}",
    // 面板里的设置正文：字体与卡片内边距比设置页收一档，同样的内容不至于翻半天。
    ROOT_SEL + " [data-panel-settings] [data-card-body]{padding:7px 9px}",
    ROOT_SEL + " [data-panel-settings] [data-pool-row]{grid-template-columns:minmax(0,1fr) 64px 18px 52px;gap:3px}",
    ROOT_SEL + " [data-panel] [data-group]{margin-bottom:9px}",
    ROOT_SEL + " [data-panel] [data-group]>span{display:block;margin:0 0 4px 2px;color:var(--pp-dim);font-size:10px;letter-spacing:.06em}",
    ROOT_SEL + " [data-panel] [data-chips]{display:flex;flex-wrap:wrap;gap:4px}",
    ROOT_SEL + " [data-panel] [data-chips] button{border:1px solid var(--pp-line);background:var(--pp-chip);color:var(--pp-chip-ink);font:400 11px/1.5 inherit;padding:3px 8px;border-radius:999px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ROOT_SEL + " [data-panel] [data-chips] button:hover{background:var(--pp-accent-2)}",
    ROOT_SEL + " [data-panel] [data-chips] button[data-on]{background:var(--pp-accent-3);border-color:var(--pp-line-strong)}",
    ROOT_SEL + " [data-panel] footer{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--pp-line-soft);color:var(--pp-muted);font-size:11px}",
    ROOT_SEL + " [data-panel] footer input[type=range]{flex:1;min-width:0}",
    // 面板底部那根"大小"滑杆和设置页那排是同一套外观。
    ...sliderLook(ROOT_SEL + " [data-panel] footer input[type=range]"),
    // 面板只有 270px 宽，条目行的固定列要收一档，占比数字让位（条本身还在）——
    // 五列按设置页的宽度会把标签挤没。
    ROOT_SEL + " [data-settings] [data-pool-row]"
      + "{grid-template-columns:minmax(0,1fr) 72px 34px 18px 58px;gap:4px}",
    ROOT_SEL + " [data-settings] [data-share]{display:none}",
    ROOT_SEL + " [data-panel] footer [data-sizelabel]{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}",
    ROOT_SEL + " [data-panel] footer button{border:0;background:transparent;color:#9fb0cf;font:inherit;cursor:pointer}",
    ROOT_SEL + " [data-hint]{position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;color:#c3cee6;font-size:12px;line-height:1.6}",
    ROOT_SEL + " [data-hint] code{display:block;margin-top:5px;font-size:11px;opacity:.85;word-break:break-all}",
  ].join("\n");

  /**
   * 设置页那一节的样式。
   *
   * 这一节渲染在宠物根节点**之外**（DSH 的设置界面里），ROOT_SEL 作用域下的
   * 上百条规则一条也管不到它 —— 表现就是"样式没读取上"：光秃秃的 select 和 input。
   *
   * 颜色刻意**不写死**：宿主有浅色与深色两套主题，用 currentColor 和中性灰透明，
   * 跟着宿主走才不会一边好看一边瞎。
   */
  const SETTINGS_SEL = "[data-pet-settings]";
  /**
   * 同一套表格在两个地方渲染，样式也就得有两份作用域。
   *
   * 早先只给了 `[data-pet-settings]`：DSH 设置页好看了，右键面板里那同一张表
   * 仍然是一列没对齐的裸控件（它挂在 `[data-panel] [data-settings]` 下）。
   * 规则只写一遍、作用域各来一份，两个地方就不会再走岔。
   */
  const SETTINGS_SCOPES = [SETTINGS_SEL, ROOT_SEL + " [data-settings]"];

  /**
   * 是不是跑在桌面端（`dsh-live2d-pet-desktop` 的那个壳里）。
   *
   * 判据是页面运行时留下的标记，不是 UA、也不是壳直接告诉我们的：桌面端没有 DSH 的
   * 客户端壳，所以 `ctx.slots` 那一节挂不上，设置正文得有**另一个**入口 —— 也就是
   * 右键面板的第三个页签。**网页端不认这个标记，行为一个字都不变**（那里设置正文
   * 的家仍然是 DSH 设置页）。
   */
  const desktopNow = () =>
    typeof window !== "undefined" && window.__petDesktop !== undefined && window.__petDesktop !== null;
  /**
   * 视觉语言：**卡片**。每一组设置是一张卡片（标题条 + 内容区），池子、相位都住在
   * 卡片里，层级靠"卡片 > 行 > 药丸"三层表达，而不是一堆同权重的裸控件。
   *
   * 颜色**一律不写死**：正文用 currentColor，底色/描边用中性灰的透明度，
   * 强调色只出现在浅色药丸和权重条上（都带透明度和自带描边），所以浅色与深色
   * 两套主题下都成立 —— 宿主主题不由我们决定，写死就必然一边好看一边瞎。
   *
   * 布局**全部在样式表里**：行内样式优先级更高，之前把 flex/grid 写在行上，
   * 结果怎么调样式表都不生效（"你确定这个样式生效了？"那次）。
   */
  const SETTINGS_CSS = [].concat(...SETTINGS_SCOPES.map((scope) => [
    scope + "{font:400 12px/1.7 inherit;color:inherit;max-width:560px}",
    scope + " [data-setting]{margin:0 0 10px}",

    // ---- 卡片 ----------------------------------------------------------
    scope + " [data-card]{border:1px solid rgba(127,127,127,.24);border-radius:10px;"
      + "margin:0 0 10px;overflow:hidden}",
    scope + " [data-card-head]{display:flex;align-items:center;gap:8px;padding:7px 11px;"
      + "background:rgba(127,127,127,.07);border-bottom:1px solid rgba(127,127,127,.16)}",
    scope + " [data-card-title]{font-size:12px;font-weight:600;letter-spacing:.02em;opacity:.92}",
    scope + " [data-card-hint]{margin-left:auto;font-size:10px;opacity:.5;font-weight:400}",
    scope + " [data-card-body]{padding:9px 11px}",
    scope + " [data-card-body]:empty{display:none}",

    // ---- 行：标签 / 权重（条+占比）/ 权重值 / × / ＋关系 ----------------
    // 用通用标记 `[data-pool-row]`（两张表都带），不是各自的唯一键属性 ——
    // 否则这里得把两个属性名都抄一遍，抄漏一个就是"那一层没排版"。
    //
    // **列宽只由 grid 说了算**：输入框/下拉一律 width:100% 填满自己的格子。
    // 之前 input 自己写着 width:44px，实际（padding+border）占 58px，比 grid 的
    // 列宽，就漫出来压住了 ×。
    scope + " [data-field],"
      + scope + " [data-pool-row]{display:grid;align-items:center;gap:6px;padding:2px 0}",
    scope + " [data-field]{grid-template-columns:104px 1fr 46px}",
    // 标签给固定宽、**条那一格吃掉剩下的空间**：条是这一行的主视觉（概率分布），
    // 拉长才好横向比；标签留 1fr 会把条挤到右边，中间空一大片。
    scope + " [data-pool-row]{grid-template-columns:120px minmax(60px,1fr) 40px 18px 64px}",
    // 没有关系的条目：关系块是空的，`grid-column:1/-1` 的空元素不占高度（下面那条），
    // 于是整条就是干干净净一行。
    scope + " [data-relations]:empty{display:none}",
    scope + " [data-row-label]{font-size:11px;opacity:.85;overflow:hidden;"
      + "text-overflow:ellipsis;white-space:nowrap}",

    // ---- 权重：一眼看出这个池子的概率分布 ------------------------------
    // 视觉重量要跟着**信息**重量走：这一行真正有用的是"抽中概率"，所以条是主角
    // （加粗、填色），占比数字紧随其后；而权重原始值只是个旋钮，收成行尾一行小字
    // （它以前是全行最抢眼的带框数字，正好倒挂）。
    scope + " [data-weight-cell]{display:flex;align-items:center;gap:6px;min-width:0}",
    // `display:block` 不能省：span 默认是 inline，高度会被直接忽略 —— 表现是
    // "权重条根本没渲染出来"，而 DOM 里它明明在。
    scope + " [data-weight-bar]{display:block;position:relative;height:6px;flex:1;min-width:0;"
      + "border-radius:999px;background:rgba(127,127,127,.2);overflow:hidden}",
    scope + " [data-weight-bar]>i{display:block;height:100%;border-radius:999px;"
      + "background:rgba(120,170,255,.85);transition:width .12s ease-out}",
    scope + " [data-share]{flex:0 0 32px;text-align:right;font-size:10px;opacity:.55;"
      + "font-variant-numeric:tabular-nums}",
    scope + " [data-pool-row][data-off] [data-weight-bar]>i{background:rgba(127,127,127,.5)}",
    scope + " [data-pool-row][data-off] [data-row-label]{opacity:.45;text-decoration:line-through}",

    // ---- 输入控件 ------------------------------------------------------
    scope + " select{box-sizing:border-box;font:inherit;color:inherit;width:100%;"
      + "background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.28);"
      + "border-radius:7px;padding:1px 6px;max-width:100%}",
    scope + " select:hover{border-color:rgba(127,127,127,.5)}",
    // 权重值是个"读数 + 旋钮"，不是输入框：去边框去底色，居中等宽数字，
    // 平时几乎隐形，hover 才浮出一点底色提示"这里能改"。
    scope + " input[type=number]{box-sizing:border-box;width:100%;text-align:center;"
      + "font-size:11px;font-variant-numeric:tabular-nums;color:inherit;background:transparent;"
      + "border:0;border-radius:5px;padding:1px 3px;opacity:.8;-moz-appearance:textfield}",
    scope + " input[type=number]:hover{background:rgba(127,127,127,.1)}",
    scope + " input[type=number]:focus-visible{outline:2px solid rgba(120,170,255,.5);outline-offset:1px}",
    scope + " input[type=number]::-webkit-outer-spin-button,"
      + scope + " input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
    scope + " input[type=range]{flex:1;min-width:80px}",
    // 滑杆外观（轨道/圆钮/填充）和面板底部那根共用，见 sliderLook。
    ...sliderLook(scope + " input[type=range]"),
    scope + " input[type=checkbox]{accent-color:rgba(120,170,255,.9)}",
    // ---- 台词 / 互动 ---------------------------------------------------
    // 台词是**文本**输入（不是数字），要能看清自己写了什么：给足宽度、字色正常，
    // 只在 hover/focus 时提亮边框 —— 和权重那个"读数旋钮"是两种东西，别共用样式。
    scope + " [data-line-row]{display:grid;grid-template-columns:120px 1fr;align-items:center;"
      + "gap:6px;padding:2px 0}",
    // 行内下拉与原菜单文本输入同字号（11px），别用全局 select 的默认字号。
    scope + " [data-line-row] select{font-size:11px;padding:2px 7px}",
    // 「会话提醒」子区块：字号/间距与原菜单行一致（11px 标签 + 11px 下拉）。
    scope + " [data-notify-block]{font-size:11px;margin:0 0 6px}",
    scope + " [data-notify-block] [data-line-row]{font-size:11px}",
    scope + " [data-notify-block] select{font-size:11px;padding:2px 7px}",
    scope + " input[type=text]{box-sizing:border-box;width:100%;min-width:0;font:inherit;"
      + "font-size:11px;color:inherit;background:rgba(127,127,127,.08);"
      + "border:1px solid rgba(127,127,127,.28);border-radius:7px;padding:2px 7px}",
    scope + " input[type=text]:hover{border-color:rgba(127,127,127,.5)}",
    scope + " input[type=text]:focus-visible{outline:2px solid rgba(120,170,255,.5);outline-offset:1px}",
    scope + " [data-note-inline]{font-size:10px;opacity:.55;margin-left:6px}",
    // 反应候选：一行 chips（和槽位选项同一套观感），选中的加底色。
    scope + " [data-reaction-set]{padding:5px 0 2px}",
    scope + " [data-reaction-set] [data-chips]{display:flex;flex-wrap:wrap;gap:4px;padding-top:4px}",
    scope + " [data-reaction-set] [data-chips] button{font-size:10px;padding:2px 8px;"
      + "border-radius:999px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08)}",
    scope + " [data-reaction-set] [data-chips] button[data-on]{background:rgba(120,170,255,.28);"
      + "border-color:rgba(120,170,255,.6)}",
    scope + " code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;"
      + "opacity:.7;font-variant-numeric:tabular-nums}",

    // ---- 药丸按钮：＋ 添加 / ＋ 关系 / 相位名 --------------------------
    scope + " button{font:inherit;color:inherit;background:transparent;border:0;"
      + "cursor:pointer;padding:0}",
    scope + " [data-add-row]{display:flex;flex-wrap:wrap;gap:5px;padding-top:7px}",
    scope + " [data-add-option],"
      + scope + " [data-reset],"
      + scope + " [data-phase-add],"
      + scope + " [data-phase-slot-add],"
      + scope + " [data-relation-add]{width:auto;font-size:10.5px;line-height:1.7;"
      + "border:1px dashed rgba(127,127,127,.45);border-radius:999px;padding:0 9px;"
      + "color:inherit;opacity:.72;background:transparent;cursor:pointer;"
      + "-webkit-appearance:none;appearance:none;max-width:240px}",
    // 下拉型的"按钮"：去掉原生外观（没有箭头），看起来才像按钮而不是输入框。
    // 宽度填满 grid 给的格子（列宽才是唯一来源）；弹出列表不受这个宽度影响。
    scope + " [data-phase-add]," + scope + " [data-phase-slot-add]{text-align:left;padding:0 9px}",
    scope + " [data-relation-add]{text-align:left;padding:0 6px;width:100%;font-size:10px}",
    scope + " [data-add-option]:hover," + scope + " [data-reset]:hover,"
      + scope + " [data-phase-add]:hover,"
      + scope + " [data-phase-slot-add]:hover," + scope + " [data-relation-add]:hover{"
      + "opacity:1;border-style:solid;border-color:rgba(120,170,255,.75);"
      + "background:rgba(120,170,255,.12)}",
    // ---- 「加槽位」和「加候选」必须长得不一样 --------------------------
    // 两者用同一种药丸时，点错的后果不一样：池内那个是"往这张表加一条"，
    // 底下那个是"新建一张表"。所以加槽位换成实线描边 + 淡蓝底，且前面带一行小字
    // 说明它加的是什么。
    scope + " [data-add-title]{flex:0 0 auto;font-size:10px;opacity:.5;margin-right:2px}",
    scope + " [data-add-row][data-slot-row]{align-items:center}",
    scope + " [data-slot-chip]{border-style:solid !important;border-color:rgba(120,170,255,.45) !important;"
      + "background:rgba(120,170,255,.08);opacity:.85}",

    // ---- 关系：两种关系刻意长得不一样 ----------------------------------
    scope + " [data-relations]{grid-column:1/-1;display:flex;flex-wrap:wrap;"
      + "align-items:center;gap:5px;padding:0 0 2px 2px}",
    scope + " [data-relation]{display:inline-flex;align-items:center;gap:5px;"
      + "font-size:10px;line-height:1.8;border-radius:999px;padding:0 3px 0 8px;"
      + "border:1px solid transparent;white-space:nowrap}",
    scope + " [data-relation]>b{font-weight:600;opacity:.8}",
    scope + " [data-relation='pair']{background:rgba(120,170,255,.16);"
      + "border-color:rgba(120,170,255,.42)}",
    scope + " [data-relation='require']{background:rgba(240,180,90,.18);"
      + "border-color:rgba(230,170,80,.5)}",
    scope + " [data-relation-remove]{font-size:11px;line-height:1;opacity:.45;"
      + "padding:1px 3px;border-radius:999px;color:inherit}",
    scope + " [data-relation-remove]:hover{opacity:1;background:rgba(127,127,127,.22)}",

    // ---- × 删除 --------------------------------------------------------
    scope + " [data-pool-remove]," + scope + " [data-pool-remove-slot]{justify-self:center;"
      + "width:20px;height:20px;line-height:1;font-size:13px;border-radius:6px;"
      + "opacity:.4;color:inherit}",
    scope + " [data-pool-remove]:hover," + scope + " [data-pool-remove-slot]:hover{opacity:1;"
      + "background:rgba(232,120,120,.2);color:#e87878}",
    // 槽位那一行的 × 贴在右边（它是"整张表"的动作，不是"这一条"的）。
    scope + " [data-pool-remove-slot]{margin-left:auto}",

    // ---- 相位：概览、台词/音符、动作槽位分层 ----------------------------
    scope + " [data-phase]{border:1px solid rgba(127,127,127,.24);border-radius:10px;"
      + "margin:0 0 9px;overflow:hidden}",
    scope + " [data-phase-head]{padding:7px 10px 8px;background:rgba(127,127,127,.07);"
      + "border-bottom:1px solid rgba(127,127,127,.16)}",
    scope + " [data-phase-head][data-collapsed]{border-bottom:0}",
    scope + " [data-phase-head-main]{display:flex;align-items:center;gap:6px;min-width:0}",
    scope + " [data-phase-remove]{flex:none;font-size:10px;color:inherit;opacity:.75;"
      + "border:1px solid rgba(127,127,127,.3);border-radius:999px;padding:1px 7px}",
    scope + " [data-phase-remove]:hover{opacity:1;border-color:rgba(120,170,255,.7);"
      + "background:rgba(120,170,255,.12)}",
    scope + " [data-phase-toggle]{display:flex;align-items:center;gap:7px;flex:1;min-width:0;"
      + "font-size:12px;font-weight:600;text-align:left;color:inherit}",
    scope + " [data-phase-toggle]:focus-visible{outline:2px solid rgba(120,170,255,.7);"
      + "outline-offset:2px;border-radius:4px}",
    scope + " [data-caret]{font-size:10px;opacity:.7;width:9px;flex:none}",
    scope + " [data-phase-name]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    scope + " [data-phase-toggle] code{font:400 10px/1.4 inherit;opacity:.55;flex:none}",
    scope + " [data-phase-meta]{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0 0 16px;"
      + "font-size:10px;font-variant-numeric:tabular-nums}",
    scope + " [data-phase-chip]{display:inline-block;padding:0 6px;border-radius:999px;"
      + "border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.05);opacity:.7}",
    scope + " [data-phase-chip][data-custom]{border-color:rgba(120,170,255,.5);"
      + "background:rgba(120,170,255,.13);opacity:1}",
    scope + " [data-phase-details]{padding:8px 10px 9px;background:rgba(127,127,127,.025);"
      + "border-bottom:1px solid rgba(127,127,127,.16)}",
    scope + " [data-phase-section-title]{font-size:10px;font-weight:600;opacity:.65;margin-bottom:3px}",
    scope + " [data-phase-line]{display:flex;align-items:center;gap:6px;min-width:0}",
    scope + " [data-phase-line] [data-line-row]{grid-template-columns:84px minmax(0,1fr);"
      + "flex:1;min-width:0}",
    scope + " [data-phase-line] [data-reset]{flex:none;white-space:nowrap}",
    scope + " [data-phase-sound]{display:grid;grid-template-columns:84px minmax(0,1fr);"
      + "align-items:center;gap:6px;padding:3px 0;min-width:0}",
    scope + " [data-phase-sound-control]{display:flex;align-items:center;gap:7px;min-width:0}",
    scope + " [data-phase-sound] input{margin:0;flex:none}",
    scope + " [data-phase-sound] [data-note-inline]{min-width:0;margin-left:0;"
      + "line-height:1.5;overflow-wrap:anywhere}",
    scope + " [data-phase-upload]{display:flex;align-items:center;flex-wrap:wrap;gap:6px;"
      + "min-width:0;margin:6px 0 0 90px}",
    scope + " [data-upload-picker]," + scope + " [data-upload-reset],"
      + scope + " [data-phase-preview]{position:relative;"
      + "border:1px solid rgba(120,170,255,.5);border-radius:7px;"
      + "background:rgba(120,170,255,.1);color:inherit;font-size:10px;"
      + "padding:2px 8px;line-height:1.7;cursor:pointer}",
    // 没有可试听的来源时按钮就该点不动 —— 别让它装作可点，那只会变成"点了没反应"。
    scope + " [data-phase-preview]:disabled{opacity:.45;cursor:default}",
    scope + " [data-upload-picker]:focus-within{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}",
    scope + " [data-upload-picker] input[type=file]{position:absolute;inset:0;opacity:0;"
      + "width:100%;height:100%;cursor:pointer}",
    scope + " [data-upload-hint]{font-size:10px;opacity:.55}",
    scope + " [data-upload-error]{flex-basis:100%;font-size:10px;"
      + "background:rgba(232,120,120,.16);border-radius:5px;padding:2px 6px}",
    scope + " [data-phase-motion-head]{display:flex;align-items:center;gap:8px;"
      + "padding:7px 10px 5px;font-size:10px;font-weight:600;opacity:.8}",
    scope + " [data-phase-motion-hint]{font-weight:400;opacity:.65}",
    scope + " [data-phase-motion-head]+[data-pool-empty]{padding:4px 10px}",
    scope + " [data-pool]{padding:7px 10px 8px 12px;"
      + "border-top:1px solid rgba(127,127,127,.13)}",
    scope + " [data-phase-motion-head]+[data-pool]{border-top:0}",
    scope + " [data-pool-head]{display:flex;align-items:center;gap:8px;padding:0 0 3px}",
    scope + " [data-pool-title]{font-size:11px;font-weight:600;opacity:.88}",
    scope + " [data-pool-meta]{font-size:10px;opacity:.42;font-variant-numeric:tabular-nums}",
    scope + " [data-pool-empty]{" + "font-size:10.5px;opacity:.45;padding:2px 0}",

    // ---- 空态 / 说明 ---------------------------------------------------
    scope + " [data-empty]{font-size:11px;opacity:.5;padding:6px 0}",
    scope + " [data-note]{font-size:10.5px;opacity:.55;padding-top:4px}",
    scope + " label{display:flex;align-items:center;gap:7px}",
  ]));
  // DSH 设置页用两列概览；右键窄面板仍沿用单列，以免池子表格被挤窄。
  const PAGE_PHASE_CSS = [
    SETTINGS_SEL + "{max-width:880px;container:pet-settings/inline-size}",
    SETTINGS_SEL + " [data-setting=phases]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}",
    SETTINGS_SEL + " [data-setting=phases] [data-phase]{margin:0;min-width:0}",
    SETTINGS_SEL + " [data-setting=phases] [data-phase][data-expanded]{grid-column:1/-1}",
    SETTINGS_SEL + " [data-phase-head]{padding:10px 12px 11px}",
    SETTINGS_SEL + " [data-phase-toggle]{font-size:13px}",
    SETTINGS_SEL + " [data-phase-meta]{font-size:11px;gap:5px;margin-top:7px}",
    SETTINGS_SEL + " [data-phase-chip]{padding:1px 7px}",
    SETTINGS_SEL + " [data-phase-details]{padding:11px 14px}",
    SETTINGS_SEL + " [data-phase-section-title]{font-size:11px;opacity:.8}",
    SETTINGS_SEL + " [data-phase][data-expanded] [data-phase-head]{background:rgba(120,170,255,.1)}",
    "@container pet-settings (max-width:620px){"
      + SETTINGS_SEL + " [data-setting=phases]{grid-template-columns:minmax(0,1fr)}",
    "}",
  ];
  /**
   * 官方「插件」页那一节的微调（作用域 = 两个属性同时在的那个根节点）。
   *
   * 只有两条，都是有理由的：
   *  * 状态行（"她现在在哪"）本来借的是 `[data-note]` 的灰度 —— 那是给补充说明用的，
   *    而这一行是这一节**最先要回答**的问题，按 55% 透明度画就太虚了；
   *  * 插件页是窄栏，卡片间距收一档，四张卡不至于要滚半天。
   */
  const PLUGIN_PAGE_CSS = [
    SETTINGS_SEL + "[data-pet-plugin-page]>[data-plugin-status]{font-size:11px;opacity:.85;padding:0 0 9px}",
    SETTINGS_SEL + "[data-pet-plugin-page] [data-card]{margin-bottom:8px}",
  ];
  const STYLE_TEXT = CSS + "\n" + SETTINGS_CSS.join("\n") + "\n" + PLUGIN_PAGE_CSS.join("\n")
    + "\n" + PAGE_PHASE_CSS.join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = STYLE_TEXT;
    document.head.appendChild(tag);
  }

  // ------------------------------------------------------------ lines

  /**
   * 台词：**宠物默认 + 用户覆盖**。
   *
   * 默认值写在 pet.json 的 `live2d.lines` 里（宠物自己的声音），用户在设置页改过的存
   * 浏览器（`PHASE_OVERRIDES.lines`）。每条都是**一组**（随机挑一句），相位台词是单句。
   */
  const LINE_KEYS = ["greet", "click", "pat", "tail", "spin", "reset", "loadFailed"];
  const PHASE_LINE_KEYS = ["thinking", "tool", "waiting", "asking", "helper", "queued", "done", "failed"];

  /** 把一条"用 | 分隔"的输入切成台词数组（设置页的输入框就是这个格式）。 */
  const splitLineInput = (text) =>
    String(text ?? "")
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part !== "");

  /** 台词数组 -> 输入框里的一行。 */
  const joinLineInput = (list) => (Array.isArray(list) ? list.join(" | ") : "");

  /** 有效台词：宠物默认 + 用户覆盖（覆盖为空就退回默认）。 */
  const linesNow = () => {
    const base = petDefaultLines();
    const over = PHASE_OVERRIDES.lines ?? {};
    const out = {};
    for (const key of LINE_KEYS) {
      const mine = Array.isArray(over[key]) ? over[key].filter((s) => typeof s === "string" && s !== "") : [];
      const fallback = Array.isArray(base[key]) ? base[key].filter((s) => typeof s === "string" && s !== "") : [];
      out[key] = mine.length > 0 ? mine : fallback;
    }
    out.phase = {};
    for (const key of PHASE_LINE_KEYS) {
      const mine = typeof over.phase?.[key] === "string" ? over.phase[key] : undefined;
      const fallback = typeof base.phase?.[key] === "string" ? base.phase[key] : "";
      out.phase[key] = mine !== undefined ? mine : fallback;
    }
    return out;
  };

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------------------------------------------------------- the pet

  /** The layout callback the boot effect publishes for resize handling. */
  const layoutRef = { current: null };

  /** The mask rebuild hook the boot effect publishes (null before boot). */
  const rebuildMaskRef = { current: null };

  /** The active pet's fit adjustments (manifest live2d.scale / translate). */
  const fitRef = { scale: 1, x: 0, y: 0 };

  /**
   * 可调参数：设置面板能改的都在这里，默认值就是原来写死的那些。
   *
   * 放模块作用域是故意的 —— 控制器每帧读它，组件（设置面板）直接改它，
   * 不需要再穿一层 setter。写进去下一帧就生效。
   */
  const TUNING = {
    /**
     * **注视满偏半径**，px：离她中心多远算"看到最边上"（视线到这儿就满偏）。
     *
     * 它只是**满偏那一圈**，不是"还看不看她"（那是下面 `gazeWatchingRatio` 的倍数）。
     * 两者合起来是一条连续的曲线（**正圆，只有一个半径**）：
     *   * 距离比 0 → 1（= 这个半径）：视线按距离成比例偏转，到这儿满偏；
     *   * 再往外到 `× gazeWatchingRatio`：强度缓动衰减到 0；
     *   * 更远：当她没在看，视线回正。
     * 早先只有"贴边"没有"衰减/回正"，于是 220px 之外一律"贴边斜眼" —— 鼠标跑到别的屏上
     * 就变成"全屏都在追"（用户两次报的就是这个）。只贴边不回正，等于一直在盯着你。
     *
     * 上限是**视口的一半**：半径超过视野没有意义（远处一律贴边），而正圆不像椭圆那样能
     * "竖直方向借一点"，所以可用半径就是这个框能容下的最大圆。
     */
    gazeRangePx: 220,
    /**
     * **视线能跟多远**（相对满偏半径的倍数）。
     *
     * 跟随强度由**到她的圆形距离比**决定，只有一处曲线，没有硬边界：
     *
     *   距离比 0 → 1（= `gazeRangePx`）        强度 0 → 1（成比例，到这儿满偏）
     *   =1 … `gazeWatchingRatio`                强度 1 → 0（缓动衰减）
     *   ≥ 倍数                                   强度 0：当她没在看，视线回正
     *
     * 为什么不要硬边界：早先写成"超过阈值立刻回正"，于是她要么满偏斜眼盯着、要么啪一下
     * 回正，中间没有过渡 —— 用户看到的就是"全屏都在追踪"（贴边）或"突然不看了"。衰减
     * 让远处"渐渐不感兴趣"，这也更像活物。
     *
     * 2.7 是按实际几何定的：她贴屏幕底边，桌面端视口高 1392 → 页面正中就离她 546px，
     * 而满偏半径 220 × 2.7 ≈ 594 > 546，所以"在屏幕中部动鼠标"仍在范围内（只是强度很弱）。
     * 小于 2.5 的话竖直方向会白白浪费掉半屏。
     */
    gazeWatchingRatio: 2.7,
    /** 中心附近被忽略的比例（死区）：没有它，手抖一像素眼珠就动。 */
    gazeDeadzone: 0.12,
    /** 嘴部：跟随强度 / 形状强度 / 缓动时间常数（ms）。 */
    mouthFollow: 0.65,
    mouthDrop: 0.7,
    mouthEaseMs: 170,
    /** 眨眼间隔范围（ms）。 */
    blinkMinMs: 2200,
    blinkMaxMs: 6400,
    /** 摸鱼：静置多久才算「闲下来」，以及之后每次摸鱼的随机间隔上界（ms）。 */
    fidgetQuietMs: 12000,
    fidgetGapMs: 26000,
    /** 气泡相对角色默认位置（头顶）的偏移，px；以及一句话停留多久。 */
    bubbleOffsetX: 0,
    bubbleOffsetY: 0,
    bubbleHoldMs: 4200,
    /** 鼠标绕圈：在 spinWindowMs 内累计转过 spinTurns 圈就算转晕。 */
    spinTurns: 2,
    spinWindowMs: 1600,
    /** 会话提示音音量，0 为无声。 */
    soundVolume: 0.35,
  };

  /** 出厂值快照（「恢复默认」用）。 */
  const TUNING_DEFAULTS = Object.freeze(Object.assign({}, TUNING));

  /**
   * 可调项的描述：设置面板按它渲染，读写都按 key 走。
   *
   * min/max 也是**校验边界** —— 本地存档里的值会被夹进来，免得一个坏值
   * （比如死区 5）把宠物彻底冻住。
   */
  const TUNING_FIELDS = [
    { key: "gazeDeadzone", label: t("注视死区"), min: 0, max: 0.6, step: 0.01 },
    // 「满偏半径」：离她多远算"看到最边上"。**调大 = 范围更大**（220 是"一个巴掌"）。
    { key: "gazeRangePx", label: t("注视满偏 px"), min: 80, max: 900, step: 20 },
    // 「收回倍数」：满偏的多大倍数之外当她没在看（中间那段是缓动衰减，不是硬边界）。
    { key: "gazeWatchingRatio", label: t("收回倍数"), min: 1.2, max: 6, step: 0.1 },
    { key: "mouthFollow", label: t("嘴跟随意"), min: 0, max: 1, step: 0.05 },
    { key: "mouthDrop", label: t("嘴形强度"), min: -1, max: 1, step: 0.05 },
    { key: "mouthEaseMs", label: t("嘴缓动 ms"), min: 30, max: 800, step: 10 },
    { key: "blinkMinMs", label: t("眨眼最短 ms"), min: 600, max: 20000, step: 100 },
    { key: "blinkMaxMs", label: t("眨眼最长 ms"), min: 800, max: 40000, step: 100 },
    // 摸鱼那一组单独排，界面上分开展示（见 TUNING_GROUPS）。
    { key: "fidgetQuietMs", label: t("静置多久开始"), min: 2000, max: 120000, step: 1000, group: "fidget" },
    { key: "fidgetGapMs", label: t("之后最长间隔"), min: 4000, max: 300000, step: 1000, group: "fidget" },
    // 互动与气泡（见「互动」那张卡）。
    { key: "bubbleOffsetX", label: t("气泡左右偏移 px"), min: -240, max: 240, step: 2, group: "bubble" },
    { key: "bubbleOffsetY", label: t("气泡上下偏移 px"), min: -240, max: 240, step: 2, group: "bubble" },
    { key: "bubbleHoldMs", label: t("一句话停留 ms"), min: 800, max: 15000, step: 200, group: "bubble" },
    { key: "spinTurns", label: t("转几圈算晕"), min: 1, max: 6, step: 0.5, group: "interact" },
    { key: "spinWindowMs", label: t("要在多少 ms 内"), min: 300, max: 6000, step: 100, group: "interact" },
    { key: "soundVolume", label: t("提示音音量"), min: 0, max: 1, step: 0.05, group: "sound" },
  ];
  /** 可调项的分组（没写 group 的都归「手感」）。hint 显示在卡片右上角。 */
  const TUNING_GROUPS = [
    { id: "feel", label: t("手感"), hint: t("指针 / 嘴 / 眨眼") },
    { id: "fidget", label: t("摸鱼节奏"), hint: t("多久开始、间隔多长") },
    { id: "interact", label: t("互动"), hint: t("摸头 / 摸尾巴 / 转圈") },
    { id: "bubble", label: t("气泡"), hint: t("显示什么 · 在哪") },
  ];
  /** 这几组自己排进了「互动」「气泡」卡里，不要再单独出一张卡。 */
  const TUNING_GROUPS_INLINE = ["fidget", "interact", "bubble"];
  const tuningGroupOf = (field) => field.group ?? "feel";
  const TUNING_KEY = "dsh-pet-live2d.settings.v1";
  /** 装扮存档的 key。放这里是因为开关（applyFlag）也要用它清存档。 */
  const OUTFIT_KEY = "dsh-pet-live2d:outfit";

  // ---------------------------------------------------------------------------
  // 共享设置：**宿主优先，localStorage 兜底**
  //
  // 用户报的"桌面的设置与 DSH 里的设置没有同步"。根因不是"同步没写"，而是**两边根本
  // 不共享存储**：桌面端页面是 `http://127.0.0.1:<壳的随机端口>`，DSH 是
  // `http://127.0.0.1:3080` —— localStorage 按 origin 隔离，各存一份、永不互见。
  //
  // 所以三类**跨窗口该一致**的设置（可调项 / 相位池子覆盖+开关 / 装扮）走宿主：
  // 插件宿主半区把它们落在 `%DSH_HOME%\pet-settings.json`，两个页面都读它。
  // 窗口自己的东西（位置、大小）仍然留在 localStorage —— 那本来就该各窗口不同。
  //
  // 独立模式（DSH 不在）时 `/api/live2d-pet/settings` 是 404，于是自然退回 localStorage，
  // 行为与以前一致。
  // ---------------------------------------------------------------------------
  const SETTINGS_URL = "/api/live2d-pet/settings";
  /** 轮询间隔：跨窗口同步靠它（localStorage 的 `storage` 事件不跨 origin）。 */
  const SHARED_POLL_MS = 3000;
  /** 轮询定时器（模块级一份 —— 热重载/重复 apply 不该堆出好几个）。 */
  let sharedPoll = 0;
  /**
   * 把"宿主拉回来的装扮"应用到画面上的回调。
   *
   * **必须是模块级的桥**：槽位选择与 pin 都在 `Pet` 组件里（`slotSelectionsRef` /
   * `commitPinsRef`），而拉取/轮询是模块级的 `apply()` 起的 —— 直接引用会 ReferenceError，
   * 而且是**静默**的那种（client-state skill 里那几次都是这个）。所以由 `Pet` 挂上来。
   */
  const applyOutfitRef = { current: null };
  /**
   * 宿主存档里的键 → localStorage 键。
   *
   * ⚠️ **必须惰性构造**：`OVERRIDE_KEY` 在下面（和 `saveOverrides` 挨着）才声明，
   * 在模块加载期直接写一个对象字面量会撞 TDZ —— 症状是**整个插件 import 失败**：
   *   `dsh-pet-live2d: import failed: Cannot access 'OVERRIDE_KEY' before initialization`
   * （我第一版就是这么写的，直接把页面打成 "Failed to load plugins"。）
   */
  const sharedKeys = () => ({ tuning: TUNING_KEY, overrides: OVERRIDE_KEY, outfit: OUTFIT_KEY });
  /** 宿主那份的版本号；每次 POST 回来或轮询发现变化时更新。 */
  let sharedRev = -1;
  /** 宿主可用吗（第一次探测的结果；404 就不再问了，省得每 3 秒白跑一次）。 */
  let hostAvailable = null;
  /** 正在把宿主的改动往内存里灌 —— 期间不要回写宿主，否则自己写自己读打转。 */
  let applyingHost = false;

  const readLocal = (key) => {
    try {
      const raw = storage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const writeLocal = (key, value) => {
    try {
      if (value === null || value === undefined) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch {
      /* 无痕模式之类：这次生效，下次不记得 */
    }
  };

  /** 把一份宿主存档按 key 写进 localStorage 并调用方负责灌内存。 */
  const cacheHost = (payload) => {
    for (const [name, key] of Object.entries(sharedKeys())) {
      const value = payload?.[name];
      if (value === undefined) continue;
      writeLocal(key, value === null ? null : value);
    }
  };

  /**
   * 三个界面（DSH 设置页 / 桌面右键面板 / 独立模式的桌面壳）共用同一份值的落点。
   *
   * 有宿主就写宿主（两端都能看见），同时留一份 localStorage 当"宿主不在时的兜底"。
   */
  const persistShared = (patch) => {
    for (const [name, key] of Object.entries(sharedKeys())) {
      if (patch[name] === undefined) continue;
      writeLocal(key, patch[name]);
    }
    if (applyingHost) return;
    if (hostAvailable === false) return;
    try {
      void fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
        cache: "no-store",
      }).then((response) => {
        if (response.status === 404) { hostAvailable = false; return null; }
        if (!response.ok) return null;
        return response.json();
      }).then((payload) => {
        if (payload === null || payload === undefined) return;
        hostAvailable = true;
        if (typeof payload.rev === "number") sharedRev = payload.rev;
      }).catch(() => { /* 宿主不在就算了，本地那份已经写好了 */ });
    } catch {
      /* 同上 */
    }
  };

  /**
   * 拉一次宿主存档；有变化就灌进内存并广播。
   *
   * 这是"另一个窗口改了、这个窗口跟着变"的唯一途径 —— localStorage 的 `storage` 事件
   * **不会跨 origin 触发**，所以必须轮询（3 秒一次，代价可以忽略）。
   */
  const pullShared = async (apply) => {
    if (hostAvailable === false) return false;
    let payload = null;
    try {
      const response = await fetch(SETTINGS_URL, { cache: "no-store" });
      if (response.status === 404) { hostAvailable = false; return false; }
      if (!response.ok) return false;
      payload = await response.json();
    } catch {
      return false;
    }
    if (payload === null || typeof payload !== "object") return false;
    hostAvailable = true;
    const rev = typeof payload.rev === "number" ? payload.rev : 0;
    if (rev === sharedRev) return false;
    sharedRev = rev;
    cacheHost(payload);
    applyingHost = true;
    try {
      apply(payload);
    } finally {
      applyingHost = false;
    }
    return true;
  };

  /** 把一份共享存档灌进内存（tuning / overrides / outfit 各自的应用由调用方给）。 */
  const applyShared = (payload, hooks) => {
    if (payload?.tuning !== null && payload?.tuning !== undefined) hooks.tuning(payload.tuning);
    if (payload?.overrides !== null && payload?.overrides !== undefined) hooks.overrides(payload.overrides);
    if (payload?.outfit !== null && payload?.outfit !== undefined) hooks.outfit(payload.outfit);
  };

  /** 把存档里的值夹进合法区间 —— 坏值不能让宠物动不了。 */
  const clampSetting = (field, value) => Math.min(field.max, Math.max(field.min, value));

  /**
   * 设置的订阅者。
   *
   * 同一份值现在有两个界面在用：DSH 自己的设置页（正牌）和宠物的右键面板
   * （用户说是过渡）。两边都必须立刻看到对方的改动，所以值放模块作用域，
   * 改完广播一次。
   */
  /**
   * 相位映射与摸鱼权重的**用户覆盖**（DSH 设置页可改）。
   *
   * 默认值来自 pet.json（motionsByPhase / expressionsByPhase / 各槽位的
   * fidgetNone 与各选项的 fidgetWeight）；这里只放用户改过的部分，
   * 键都按名字存，换宠物时对不上的覆盖会被忽略（和装扮存档同一套思路）。
   *
   *   phases: { <相位>: { pools: { <槽位>: 条目表 } } }
   *   fidget: { <槽位>: { entries: 条目表 } }
   *   relations: { "<槽位>:<标签>": { pairs, requires } }
   *   interactions: { <patReactions|tailReactions|spinReactions>: [标签] }
   *   lines: { <键>: [台词] , phase: { <相位>: 台词 } }
   *   sounds: { <相位>: [[频率 Hz, 起始秒数], ...] }（空数组 = 静音）
   */
  /** 当前宠物的清单，给设置界面用（DSH 设置页拿不到组件里的 pet）。 */
  const MANIFEST = { current: null };

  /**
   * 宠物文案的显示语言：**模块加载时判定一次**。
   *
   * 来源是 `navigator.language` —— 浏览器 / WebView2 给的就是系统或浏览器语言，正是
   * 我们要的。**不要用 `document.documentElement.lang`**：DSH 网页入口写死
   * `<html lang="en">`，桌面端宠物页写死 `<html lang="zh">`；拿它当依据会让中文网页用户
   * 看到英文、英文桌面用户永远看不到英文（PR #14 review 里实测过）。
   *
   * 判定：`zh*` 保持清单原文（随包 pet.json 就是中文）；其它语言优先用宠物自带的覆盖层
   * （`<pet>/locale/<lang>.json`，宿主随 catalog 下发），没有覆盖层就退回清单原文；
   * 读不到语言（空串）时**回落 zh** —— 清单原文就是宠物自己的语言。
   *
   * 测试钩子：页面可以在本模块求值前设置 `window.__petLocale`（"zh" / "en" / "en-US"…）
   * 强制语言。回归驱动除了用这个钩子，还会用 Chromium 的 `--accept-lang` 真实改
   * `navigator.language`（`Emulation.setLocaleOverride` 只改 `Intl` 的 locale，不改它），
   * 确定性地走一遍"非中文 → 英文"。
   *
   * 这里只决定**拿哪一份显示文案**，不碰任何身份字段 —— 槽位 id、选项标签
   * （`option.label`）、`looksByPhase` / `pairs` / `requires` 的值、`data-*` 属性
   * 全部保持清单原文，因为 `slotOfLabel()` / `relationsOf()` 以及用户存档都按字符串
   * 相等比较。
   */
  /** 宠物文案用同一个判定（见上方 `UI_LOCALE`）。 */
  const PET_LOCALE = UI_LOCALE;

  /** 当前宠物在当前语言下的覆盖层；中文或没有覆盖层时返回 null（显示退回清单原文）。 */
  const petOverlay = () => {
    if (PET_LOCALE === "zh") return null;
    const locales = MANIFEST.current?.locales;
    if (locales === null || typeof locales !== "object") return null;
    const overlay = locales[PET_LOCALE];
    return overlay !== null && typeof overlay === "object" ? overlay : null;
  };

  /** 覆盖层里按路径取值；取不到返回 undefined。 */
  const overlayAt = (...keys) => {
    let node = petOverlay();
    for (const key of keys) {
      if (node === null || typeof node !== "object") return undefined;
      node = node[key];
    }
    return node;
  };

  const pickText = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);

  /** 显示用的宠物名 / 描述。参数是 catalog 里的一只宠物，可能不是当前这只。 */
  const petDisplayName = (pet) => pickText(pet?.locales?.[PET_LOCALE]?.displayName, pet?.displayName ?? "");
  const petDescription = (pet) => pickText(pet?.locales?.[PET_LOCALE]?.description, pet?.description ?? "");

  /** 台词默认值：覆盖层优先，缺哪句退哪句；用户覆盖仍由 `linesNow()` 再叠一层。 */
  const petDefaultLines = () => {
    const base = MANIFEST.current?.lines ?? {};
    const overlay = overlayAt("lines");
    if (overlay === null || typeof overlay !== "object") return base;
    const merged = Object.assign({}, base);
    if (overlay.phase !== null && typeof overlay.phase === "object") {
      merged.phase = Object.assign({}, base.phase ?? {}, overlay.phase);
    }
    for (const key of Object.keys(overlay)) {
      if (key !== "phase" && Array.isArray(overlay[key])) merged[key] = overlay[key];
    }
    return merged;
  };

  /** 槽位 / 选项 / 动作 / 表情的**显示**标签；身份字段仍是清单原文。 */
  const displaySlotLabel = (slotId) => pickText(
    overlayAt("slots", slotId, "label"),
    (MANIFEST.current?.expressionSlots ?? []).find((slot) => slot.id === slotId)?.label ?? slotId,
  );
  const displaySlotNone = (slot) => pickText(overlayAt("slots", slot?.id, "none"), slot?.none ?? "");
  const displayOptionLabel = (slotId, label) => pickText(overlayAt("slots", slotId, "options", label), label);
  const displayMotionLabel = (motion) => pickText(overlayAt("catalog", "motions", motion?.group), motion?.label ?? "");
  const displayExpressionLabel = (expression) => pickText(
    overlayAt("catalog", "expressions", expression?.name),
    expression?.label ?? "",
  );

  /**
   * 选项的**关系**覆盖，键 `<槽位>:<选项标签>`。
   *
   *   pairs:    { <槽位>: <选项标签> }   —— 「同时」：选了它就一起点亮
   *   requires: [ { slot, label } ]      —— 「前提」：必须先处于那个状态才播得出来
   *
   * 关系的**归属是选项，不是池子里的某一条**：`喵喵手` 会带出猫猫贴纸，这是这个
   * 姿势本身的性质 —— 在摸鱼表里改它，右键面板点同一个姿势、相位池里抽到它，
   * 行为必须一致。所以它单独存一层，而不是挂在条目上。
   */
  // 六个键都要在这里给出来（哪怕只是空壳）：`applyOverride()` 是**原地往这个对象上写**的，
  // 少一个键就等于那条路径第一次改设置时静默丢掉 —— 互动反应候选原来就是这么漏的
  // （读的地方全写着 `?.`，所以"能读、写不进去"，只有正面写它的界面会踩到）。
  const PHASE_OVERRIDES = { phases: {}, fidget: {}, relations: {}, interactions: {}, lines: {}, sounds: {}, notify: { currentMode: "hidden", scope: "wait" } };

  /** 槽位 id -> **显示**标签（覆盖层优先；关系行显示「贴纸」而不是 `sticker`）。 */
  const slotLabelOf = (slotId) => displaySlotLabel(slotId);

  /** 某个选项标签属于哪个槽位；找不到返回 null（前提可以只写标签）。 */
  const slotOfLabel = (label) =>
    (MANIFEST.current?.expressionSlots ?? [])
      .find((slot) => (slot.options ?? []).some((option) => option.label === label))?.id ?? null;

  /**
   * 一个选项最终生效的关系：pet.json 声明 <- 用户覆盖。
   *
   * `requires` 在 pet.json 里是**标签数组**（历史形状），显示与前提检查都需要知道
   * 它属于哪个槽位，所以统一归一成 `[{ slot, label }]`。
   */
  const relationsOf = (slotId, label) => {
    const override = PHASE_OVERRIDES.relations[slotId + ":" + label];
    const option = (MANIFEST.current?.expressionSlots ?? [])
      .find((slot) => slot.id === slotId)?.options?.find((o) => o.label === label);
    const pairs = override?.pairs ?? option?.pairs ?? {};
    const requires = override?.requires
      ?? (option?.requires ?? []).map((name) => ({ slot: slotOfLabel(name), label: name }));
    return { pairs, requires };
  };

  /**
   * 某个动作组（group）的「前提」清单：所有把 motion 指向它的选项，各自 `requires`
   * 的并集。
   *
   * 动作的前提原来**只认 `pet.json` 的 `motionGuards`**，UI 里给选项加的「前提」只对
   * 表情生效 —— 所以用户给「自拍」加了「前提：右手=掏出手机」，动作那边根本没人看
   * （用户报的"我设置了拍照的前提是右手手机，为什么还会右手比耶然后拍照"）。
   *
   * `pet.json` 的 motionGuards 是"槽位 = 标签白名单"，自动满足不了，只能拦；这里的
   * requires 是"槽位 = 某一个标签"，所以既能拦、也能在手动点选时替用户补上。
   */
  const motionRequiresFor = (group) => {
    const out = [];
    for (const slot of MANIFEST.current?.expressionSlots ?? []) {
      for (const option of slot.options ?? []) {
        if (option.motion !== group) continue;
        for (const need of relationsOf(slot.id, option.label).requires) {
          if (need !== null && typeof need.slot === "string" && typeof need.label === "string") out.push(need);
        }
      }
    }
    return out;
  };

  /**
   * 把选项合成成运行时认的那一个对象：关系走上面那层覆盖。
   *
   * 运行时（面板点选、摸鱼抽中、相位抽中）只认这一个函数的结果，所以三处的行为
   * 不可能不一致 —— 这是"改一处、到处生效"的唯一入口。
   */
  const effectiveOption = (slotId, option) => {
    if (option === null || option === undefined) return option;
    const { pairs, requires } = relationsOf(slotId, option.label);
    const ownPairs = option.pairs ?? {};
    const samePairs = Object.keys(pairs).length === Object.keys(ownPairs).length
      && Object.entries(pairs).every(([id, label]) => ownPairs[id] === label);
    const ownRequires = (option.requires ?? []).map((name) => ({ slot: slotOfLabel(name), label: name }));
    const sameRequires = ownRequires.length === requires.length
      && ownRequires.every((row, at) => requires[at]?.label === row.label && requires[at]?.slot === row.slot);
    if (samePairs && sameRequires) return option;
    return Object.assign({}, option, {
      pairs: Object.assign({}, pairs),
      requires: requires.map((row) => row.label),
    });
  };

  /** 写一条关系（增/改）。kind 是 "pairs" 或 "requires"。 */
  const setRelation = (key, kind, row) => {
    const current = PHASE_OVERRIDES.relations[key] ?? {};
    const [slotId, label] = key.split(":");
    // 先物化当前生效的关系，再改一条 —— 否则「加一条」会把原有的关系抹掉。
    const base = relationsOf(slotId, label);
    const next = {
      pairs: Object.assign({}, current.pairs ?? base.pairs),
      requires: (current.requires ?? base.requires).slice(),
    };
    if (kind === "pairs") next.pairs[row.slot] = row.label;
    else if (!next.requires.some((item) => item.slot === row.slot && item.label === row.label)) {
      next.requires.push(row);
    }
    PHASE_OVERRIDES.relations[key] = next;
    saveOverrides();
    notifySettings();
  };

  /** 删一条关系（按 kind + 目标槽位 + 标签）。 */
  const removeRelation = (key, kind, row) => {
    const [slotId, label] = key.split(":");
    const base = relationsOf(slotId, label);
    const current = PHASE_OVERRIDES.relations[key] ?? {};
    const next = {
      pairs: Object.assign({}, current.pairs ?? base.pairs),
      requires: (current.requires ?? base.requires).slice(),
    };
    if (kind === "pairs") delete next.pairs[row.slot];
    else next.requires = next.requires.filter((item) => !(item.slot === row.slot && item.label === row.label));
    PHASE_OVERRIDES.relations[key] = next;
    saveOverrides();
    notifySettings();
  };

  /**
   * 开关类设置（数字之外的那些）。
   *
   *   outfitArchive —— 装扮是否跨启动记住（那六件穿在身上的东西）
   *
   * 和数字项分开存：它们不是滑杆，校验方式也不同（true/false）。
   */
  const FLAGS = {
    /** 装扮是否跨启动记住（那六件穿在身上的东西）。 */
    outfitArchive: true,
    /** 气泡总开关：关掉之后任何台词都不弹（含问候、摸头、相位）。 */
    bubbleEnabled: true,
    /** 摸头互动（判定用的是模型自己的几何，见 hitsHead）。 */
    patEnabled: true,
    /** 摸尾巴互动。 */
    tailEnabled: true,
    /** 鼠标绕圈转晕。 */
    spinEnabled: true,
    /** 首次使用默认静音，避免装上插件后突然响铃。 */
    soundEnabled: false,
  };
  const FLAG_DEFAULTS = Object.freeze(Object.assign({}, FLAGS));
  const OVERRIDE_KEY = "dsh-pet-live2d.settings.v2";

  // 浏览器只允许用户操作后播放声音；文件由宿主按宠物和相位保存在独立目录。
  const SOUND_URL = "/api/live2d-pet/sound";
  const UPLOADED_SOUNDS = { petId: null, sounds: {} };
  let playingUploaded = null;
  let playingUploadedPhase = null;
  const stopUploadedSound = () => {
    if (playingUploaded !== null) playingUploaded.pause();
    playingUploaded = null;
    playingUploadedPhase = null;
  };
  const uploadedSoundFor = (phase) => UPLOADED_SOUNDS.petId === MANIFEST.current?.id
    ? UPLOADED_SOUNDS.sounds[phase] : undefined;
  const pullUploadedSounds = async () => {
    const id = MANIFEST.current?.id;
    if (typeof id !== "string") return false;
    try {
      const response = await fetch(SOUND_URL + "/" + encodeURIComponent(id), { cache: "no-store" });
      if (!response.ok) return false;
      const payload = await response.json();
      if (MANIFEST.current?.id !== id || payload?.ok !== true) return false;
      const sounds = {};
      for (const phase of PHASE_LINE_KEYS) {
        const entry = payload.sounds?.[phase];
        if (entry !== null && typeof entry === "object" && /^[a-f0-9]{64}$/.test(entry.token)
          && ["audio/wav", "audio/mpeg", "audio/ogg"].includes(entry.mime)) sounds[phase] = entry;
      }
      if (UPLOADED_SOUNDS.petId !== id || JSON.stringify(UPLOADED_SOUNDS.sounds) !== JSON.stringify(sounds)) {
        UPLOADED_SOUNDS.petId = id;
        UPLOADED_SOUNDS.sounds = sounds;
        notifySettings();
      }
      return true;
    } catch { return false; }
  };
  const changeUploadedSound = async (phase, file) => {
    const id = MANIFEST.current?.id;
    if (typeof id !== "string" || !PHASE_LINE_KEYS.includes(phase)) throw new Error(t("宠物尚未加载"));
    if (file && file.size > 1024 * 1024) throw new Error(t("音频文件不能超过 1 MB"));
    if (file !== null) {
      const previewUrl = URL.createObjectURL(file);
      const preview = new window.Audio();
      let timer;
      try {
        await new Promise((resolve, reject) => {
          preview.preload = "metadata";
          preview.onloadedmetadata = () => resolve();
          preview.onerror = () => reject(new Error(t("音频文件损坏或格式不受支持")));
          timer = window.setTimeout(() => reject(new Error(t("读取音频超时，请换一个文件"))), 5000);
          preview.src = previewUrl;
          preview.load();
        });
      } finally {
        window.clearTimeout(timer);
        preview.removeAttribute("src");
        preview.load();
        URL.revokeObjectURL(previewUrl);
      }
    }
    const base64 = file === null ? null : await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error(t("读取音频文件失败")));
      reader.readAsDataURL(file);
    });
    const response = await fetch(SOUND_URL + "/" + encodeURIComponent(id) + "/" + phase, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(file === null ? { action: "reset" } : { base64 }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error === "invalid-audio" ? t("仅支持 MP3、WAV、OGG 音频（最大 1 MB）")
        : result.error === "body-too-large" ? t("音频文件不能超过 1 MB")
          : t("保存音频失败（") + response.status + "）");
    }
    await pullUploadedSounds();
  };
  let soundContext = null;
  /**
   * 按需建/恢复 AudioContext。相位提示音与设置页的「试听」共用同一个实例。
   *
   * 返回 null 表示这台机器没有 Web Audio（或浏览器禁用了）——调用方各自决定怎么退。
   */
  const ensureSoundContext = () => {
    if (soundContext === null) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext === undefined) return null;
      soundContext = new AudioContext();
    }
    if (soundContext.state === "suspended") void soundContext.resume().catch(() => {});
    return soundContext;
  };
  const unlockSound = () => {
    if (!FLAGS.soundEnabled) return;
    try {
      ensureSoundContext();
    } catch {
      /* 无音频设备或浏览器禁用 Web Audio：只保留视觉状态 */
    }
  };
  // 未声明 sounds 的旧宠物沿用原来的四声；声明了 sounds 的宠物只响自己列出的相位。
  // 内置默认提示音（随包，无需上传）：取自 dsh-session-notification 的四种合成音；
  // 用户上传了对应相位则优先用上传音频，没上传就用这里的默认音。
  const DEFAULT_SOUND_AUDIO = {
    done: "data:audio/wav;base64,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aQA0APr/wv+N/2D/PP8l/xz/If80/1P/fv+w/+f/IABXAIgAsQDOAN8A4QDWAL0AmABqADYA/v/G/5L/Zf9C/yv/If8l/zb/Vf9+/6//5f8cAFIAgwCrAMkA2gDdANIAuwCYAGsAOAABAMr/l/9q/0f/MP8l/yj/Of9W/37/rf/i/xkATgB+AKYAwwDVANkAzwC5AJcAbAA6AAQAzv+c/3D/Tf81/yr/LP88/1j/fv+s/+D/FQBJAHkAoQC+ANAA1QDMALcAlgBsADsABwDS/6D/df9S/zr/Lv8w/z7/Wf9+/6v/3f8SAEUAdACbALkAywDRAMkAtQCVAGwAPQAKANb/pf96/1f/P/8z/zP/Qf9a/37/qv/b/w8AQQBvAJYAtADHAM0AxgCzAJQAbQA/AAwA2v+p/3//XP9D/zf/N/9E/1z/f/+p/9n/CwA9AGsAkgCvAMIAyQDDALEAkwBtAEAADwDd/67/g/9h/0j/O/87/0b/Xv9//6j/1/8IADkAZgCNAKoAvgDFAMAArgCSAG0AQQASAOH/sv+I/2b/Tf8//z7/Sf9f/3//qP/V/wYANQBiAIgApgC5AMEAvACsAJEAbQBDABQA5P+2/4z/av9R/0T/Qv9M/2H/gP+n/9P/AwAyAF4AhAChALUAvQC5AKoAkABuAEQAFgDn/7r/kf9v/1b/SP9F/07/Yv+A/6b/0v8AAC4AWQB/AJ0AsAC5ALYAqACPAG4ARQAYAOr/vv+V/3P/Wv9M/0n/Uf9k/4H/pv/Q//3/KwBVAHsAmACsALUAswCmAI4AbQBGABoA7f/B/5n/eP9f/1D/TP9U/2b/gv+l/8//+/8nAFEAdgCUAKgAsQCwAKMAjQBtAEcAHADw/8X/nf98/2P/VP9Q/1b/aP+C/6X/zf/4/yQATgByAI8ApACuAK0AoQCMAG0ASAAeAPP/yP+h/4D/Z/9Y/1P/Wf9p/4P/pf/M//b/IQBKAG4AiwCgAKoAqgCfAIoAbQBJACAA9v/M/6X/hP9r/1z/Vv9c/2v/hP+k/8v/9P8eAEYAagCHAJwApgCnAJ0AiQBtAEkAIgD4/8//qf+I/2//YP9a/17/bf+F/6T/yf/y/xsAQwBmAIMAmACjAKQAmwCIAGwASgAjAPv/0v+t/4z/c/9j/13/Yf9v/4b/pP/I//D/GAA/AGIAfwCUAJ8AoQCYAIYAbABLACUA/f/V/7D/kP93/2f/YP9j/3D/hv+k/8f/7v8WADwAXwB7AJAAnACeAJYAhQBrAEsAJgD//9j/tP+U/3v/a/9j/2b/cv+H/6T/xv/s/xMAOQBbAHcAjACYAJsAlACDAGsATAAoAAIA2/+3/5j/f/9u/2f/af90/4j/pP/F/+r/EQA2AFcAdACJAJUAmACSAIIAagBMACkABADe/7v/m/+D/3L/av9r/3b/if+k/8T/6f8OADMAVABwAIUAkgCVAI8AgQBqAEwAKgAGAOH/vv+f/4b/df9t/27/eP+K/6T/xP/n/wwAMABRAGwAgQCOAJIAjQB/AGkATQAsAAgA4//B/6L/iv95/3D/cP96/4v/pP/D/+X/CQAtAE0AaQB+AIsAjwCLAH4AaQBNAC0ACgDm/8T/pv+N/3z/c/9z/3z/jf+l/8L/5P8HACoASgBmAHsAiACNAIkAfABoAE0ALgALAOj/x/+p/5H/f/92/3X/ff+O/6X/wv/j/wUAJwBHAGIAdwCFAIoAhgB7AGcATQAvAA0A6//K/6z/lP+D/3n/eP9//4//pf/B/+H/AwAlAEQAXwB0AIIAhwCEAHkAZgBNADAADwDt/83/sP+X/4b/fP96/4H/kP+m/8H/4P8BACIAQQBcAHEAfgCEAIIAeABmAE0AMAAQAO//z/+z/5v/if9//33/g/+R/6b/wP/f////IAA+AFkAbQB7AIIAgAB2AGUATQAxABIA8f/S/7b/nv+M/4L/f/+F/5L/pv/A/97//f8dADsAVQBqAHgAfwB+AHQAZABNADIAEwD0/9X/uf+h/4//hf+C/4f/lP+n/8D/3f/8/xsAOQBSAGcAdQB8AHwAcwBjAE0AMgAVAPb/1/+7/6T/kv+H/4T/if+V/6f/wP/c//r/GQA2AFAAZABzAHoAeQBxAGIATQAzABYA9//a/77/p/+V/4r/h/+L/5b/qP+//9v/+P8XADMATQBhAHAAdwB3AHAAYQBNADQAFwD5/9z/wf+q/5j/jf+J/43/l/+o/7//2v/3/xQAMQBKAF4AbQB1AHUAbgBgAE0ANAAYAPv/3v/E/63/m/+Q/4v/jv+Z/6n/v//Z//X/EgAuAEcAXABqAHIAcwBtAF8ATAA1ABoA/f/h/8b/r/+e/5L/jv+Q/5r/qv+//9j/9P8QACwARABZAGcAcABxAGsAXwBMADUAGwD//+P/yf+y/6H/lf+Q/5L/m/+q/7//2P/z/w8AKgBCAFYAZQBtAG8AaQBeAEwANQAcAAAA5f/L/7X/o/+X/5L/lP+c/6v/v//X//H/DQAnAD8AUwBiAGsAbQBoAF0ASwA2AB0AAgDn/83/t/+m/5r/lf+W/57/rP+//9b/8P8LACUAPQBRAGAAaABrAGYAXABLADYAHQADAOn/0P+6/6j/nP+X/5j/n/+s/7//1v/v/wkAIwA6AE4AXQBmAGkAZQBaAEsANgAeAAUA6//S/7z/q/+f/5n/mf+g/63/v//V/+7/CAAhADgATABbAGQAZwBjAFkASgA2AB8ABgDs/9T/v/+u/6H/m/+b/6L/rv+//9X/7f8GAB8ANgBJAFgAYQBlAGIAWABKADYAIAAHAO7/1v/B/7D/pP+d/53/o/+v/7//1P/s/wUAHQAzAEcAVgBfAGMAYABXAEkANwAhAAkA8P/Z/8T/sv+m/5//n/+k/6//wP/U/+v/AwAbADEARABTAF0AYQBeAFYASQA3ACEACgDy/9v/xv+1/6j/ov+h/6b/sP/A/9T/6v8CABkALwBCAFEAWwBfAF0AVQBIADcAIgALAPP/3f/I/7f/q/+k/6L/p/+x/8D/0//p/wAAFwAtAEAATwBZAF0AWwBUAEgANwAiAAwA9f/e/8r/uf+t/6b/pP+o/7L/wP/T/+j///8WACsAPgBMAFYAWwBaAFMARwA3ACMADQD2/+D/zP+7/6//qP+m/6r/s//B/9P/5//+/xQAKQA8AEoAVABZAFgAUgBGADcAIwAOAPj/4v/O/77/sf+q/6j/q/+0/8H/0//n//z/EgAnADkASABSAFcAVwBRAEYANwAkAA8A+f/k/9D/wP+z/6z/qf+s/7X/wv/S/+b/+/8RACUANwBGAFAAVQBVAFAARQA2ACQAEAD7/+b/0v/C/7X/rv+r/67/tf/C/9L/5f/6/w8AIwA1AEQATgBUAFQATwBFADYAJQARAPz/5//U/8T/t/+v/63/r/+2/8L/0v/l//n/DgAiADMAQgBMAFIAUgBNAEQANgAlABIA/f/p/9b/xv+5/7H/rv+w/7f/w//S/+T/+P8MACAAMgBAAEoAUABRAEwAQwA2ACUAEgD+/+r/2P/I/7v/s/+w/7L/uP/D/9L/5P/3/wsAHgAwAD4ASABOAE8ASwBDADYAJgATAP//7P/a/8r/vf+1/7H/s/+5/8T/0v/j//b/CgAdAC4APABGAEwATgBKAEIANQAmABQAAQDt/9v/zP+//7f/s/+0/7r/xP/S/+P/9f8JABsALAA6AEUASwBMAEkAQQA1ACYAFAACAO//3f/N/8H/uf+1/7X/u//F/9L/4v/0/wcAGgAqADgAQwBJAEsASABAADUAJgAVAAMA8P/f/8//w/+6/7b/t/+8/8X/0v/i//T/BgAYACkANwBBAEcASQBHAEAANQAmABYABADx/+D/0f/F/7z/uP+4/73/xv/S/+L/8/8FABcAJwA1AD8ARgBIAEYAPwA0ACYAFgAFAPP/4v/T/8b/vv+5/7n/vv/G/9L/4f/y/wQAFQAlADMAPgBEAEcARQA+ADQAJwAXAAUA9P/j/9T/yP+//7v/u/+//8f/0v/h//H/AwAUACQAMQA8AEMARQBDAD0ANAAnABcABgD1/+X/1v/K/8H/vP+8/8D/x//T/+H/8f8CABMAIgAwADoAQQBEAEIAPQAzACcAGAAHAPb/5v/X/8v/w/++/73/wP/I/9P/4P/w/wEAEQAhAC4AOQA/AEIAQQA8ADMAJwAYAAgA9//n/9n/zf/E/7//vv/B/8j/0//g//D/AAAQAB8ALQA3AD4AQQBAADsAMgAnABgACQD5/+n/2//P/8b/wf/A/8L/yf/T/+D/7////w8AHgArADUAPABAAD8AOgAyACcAGQAJAPr/6v/c/9D/x//C/8H/w//K/9P/4P/u//7/DgAcACkANAA7AD4APgA6ADIAJwAZAAoA+//r/93/0v/J/8T/wv/E/8r/1P/g/+7//f8NABsAKAAyADoAPQA9ADkAMQAnABkACwD8/+3/3//T/8r/xf/D/8X/y//U/+D/7f/8/wsAGgAnADEAOAA8ADwAOAAxACYAGgALAPz/7v/g/9X/zP/G/8T/xv/M/9T/4P/t//z/CgAZACUALwA3ADsAOwA3ADAAJgAaAAwA/f/v/+L/1v/N/8j/xv/H/8z/1f/g/+3/+/8JABcAJAAuADUAOQA6ADYAMAAmABoADQD+//D/4//X/8//yf/H/8j/zf/V/+D/7P/6/wgAFgAiAC0ANAA4ADkANgAvACYAGgANAP//8f/k/9n/0P/K/8j/yf/N/9X/3//s//n/BwAVACEAKwAzADcAOAA1AC8AJgAbAA4AAADy/+X/2v/R/8z/yf/K/87/1f/f/+z/+f8HABQAIAAqADEANgA3ADQALgAmABsADgABAPP/5//b/9P/zf/K/8v/z//W/+D/6//4/wYAEwAfACkAMAA0ADUAMwAuACYAGwAPAAEA9P/o/93/1P/O/8v/zP/P/9b/4P/r//j/BQASAB0AJwAvADMANAAyAC0AJQAbAA8AAgD1/+n/3v/V/8//zP/N/9D/1//g/+v/9/8EABEAHAAmAC0AMgAzADIALQAlABsADwADAPb/6v/f/9f/0P/N/83/0f/X/+D/6v/3/wMAEAAbACUALAAxADIAMQAsACUAGwAQAAQA9//r/+D/2P/S/87/zv/R/9f/4P/q//b/AgAPABoAJAArADAAMQAwACwAJQAbABAABAD4/+z/4v/Z/9P/0P/P/9L/2P/g/+r/9v8CAA4AGQAiACoALwAwAC8AKwAkABsAEQAFAPn/7f/j/9r/1P/R/9D/0//Y/+D/6v/1/wEADQAYACEAKQAuADAALwArACQAGwARAAUA+f/u/+T/2//V/9L/0f/T/9n/4P/q//X/AAAMABcAIAAoACwALwAuACoAJAAbABEABgD6/+//5f/c/9b/0//S/9T/2f/g/+r/9P8AAAsAFgAfACYAKwAuAC0AKgAkABsAEQAGAPv/8P/m/97/1//U/9P/1f/Z/+D/6f/0////CgAVAB4AJQAqAC0ALAApACMAGwASAAcA/P/x/+f/3//Y/9X/1P/V/9r/4f/p//P//v8JABQAHQAkACkALAArACgAIwAbABIABwD8//L/6P/g/9n/1v/U/9b/2v/h/+n/8//+/wkAEwAcACMAKAArACsAKAAjABsAEgAIAP3/8//p/+H/2//X/9X/1//b/+H/6f/z//3/CAASABsAIgAnACoAKgAnACIAGwASAAgA/v/z/+r/4v/c/9j/1v/X/9v/4f/p//L//f8HABEAGgAhACYAKQApACcAIgAbABIACQD+//T/6//j/93/2f/X/9j/3P/h/+n/8v/8/wYAEAAZACAAJQAoACgAJgAiABsAEwAJAP//9f/s/+T/3v/Z/9j/2f/c/+L/6f/y//z/BgAPABgAHwAkACcAKAAmACEAGwATAAkAAAD2/+3/5f/e/9r/2f/Z/9z/4v/p//L/+/8FAA8AFwAeACMAJgAnACUAIQAbABMACgAAAPf/7f/m/9//2//Z/9r/3f/i/+n/8f/7/wQADgAWAB0AIgAmACYAJQAhABsAEwAKAAEA9//u/+f/4P/c/9r/2//d/+L/6f/x//r/BAANABUAHAAiACUAJgAkACAAGgATAAoAAQD4/+//5//h/93/2//b/97/4//p//H/+v8DAAwAFAAbACEAJAAlACMAIAAaABMACwACAPn/8P/o/+L/3v/c/9z/3v/j/+n/8f/6/wMACwAUABsAIAAjACQAIwAgABoAEwALAAIA+f/x/+n/4//f/93/3f/f/+P/6f/x//n/AgALABMAGgAfACIAIwAiAB8AGgATAAsAAwD6//H/6v/k/+D/3f/d/9//4//p//H/+f8BAAoAEgAZAB4AIQAjACIAHwAaABMADAADAPr/8v/r/+X/4P/e/97/4P/k/+n/8P/4/wEACQARABgAHQAhACIAIQAeABoAEwAMAAQA+//z/+z/5v/h/9//3v/g/+T/6f/w//j/AAAJABEAFwAcACAAIQAhAB4AGQATAAwABAD8//T/7P/m/+L/4P/f/+H/5P/p//D/+P8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    failed: "data:audio/wav;base64,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R/9K/07/Uf9V/1j/XP9f/2P/Zv9q/27/cf91/3j/fP9//4L/hv+J/43/kP+U/5f/m/+e/6L/pf+p/6z/r/+z/7b/uv+9/8D/xP/H/8v/zv/R/9X/2P/b/9//4v/m/+n/7P/w//P/9v/6//3/AAAEAAcACgANABEAFAAXABsAHgAhACQAKAArAC4AMQA1ADgAOwA+AEIARQBIAEsATgBSAFUAWABbAF4AYgBlAGgAawBuAHEAdQB4AHsAfgCBAIQAiACLAI4AkQCUAJcAmgCdAKAApACnAKoArQCwALMAtgC5ALwAvwDCAMUAyADLAM4A0QAt/zD/M/82/zr/Pf9A/0T/R/9K/03/Uf9U/1f/Wv9e/2H/ZP9n/2v/bv9x/3T/eP97/37/gf+E/4j/i/+O/5H/lP+X/5v/nv+h/6T/p/+q/67/sf+0/7f/uv+9/8D/w//H/8r/zf/Q/9P/1v/Z/9z/3//i/+X/6P/s/+//8v/1//j/+//+/wEABAAHAAoADQAQABMAFgAZABwAHwAiACUAKAArAC4AMQA0ADcAOgA9AEAAQgBFAEgASwBOAFEAVABXAFoAXQBgAGMAZQBoAGsAbgBxAHQAdwB6AHwAfwCCAIUAiACLAI4AkACTAJYAmQCcAJ8AoQCkAKcAqgCtAK8AsgC1ALgAugC9AMAAP/9C/0X/SP9L/07/Uf9U/1f/Wv9d/2D/Y/9m/2n/bP9v/3L/df94/3v/fv+B/4T/h/+K/43/kP+T/5X/mP+b/57/of+k/6f/qv+t/7D/sv+1/7j/u/++/8H/xP/G/8n/zP/P/9L/1f/X/9r/3f/g/+P/5f/o/+v/7v/x//P/9v/5//z///8BAAQABwAKAAwADwASABUAFwAaAB0AIAAiACUAKAAqAC0AMAAzADUAOAA7AD0AQABDAEUASABLAE0AUABTAFUAWABbAF0AYABjAGUAaABqAG0AcAByAHUAeAB6AH0AfwCCAIUAhwCKAIwAjwCRAJQAlwCZAJwAngChAKMApgCoAKsArQCwAFH/U/9W/1n/XP9e/2H/ZP9n/2n/bP9v/3H/dP93/3r/fP9//4L/hP+H/4r/jP+P/5L/lf+X/5r/nf+f/6L/pP+n/6r/rP+v/7L/tP+3/7r/vP+//8H/xP/H/8n/zP/O/9H/1P/W/9n/2//e/+H/4//m/+j/6//t//D/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xv/H/8n/yv/M/83/z//Q/9H/0//U/9b/1//Y/9r/2//d/97/3//h/+L/5P/l/+b/6P/p/+r/7P/t/+//8P/x//P/9P/1//f/+P/5//v//P/+////AAACAAMABAAGAAcACAAKAAsADAAOAA8AEAASABMAFAAWABcAGAAZABsAHAAdAB8AIAAhACMAJAAlACcAKAApACoALAAtAC4AMAAxADIAMwA1ADYANwA5ADoAOwA8AD4APwBAAEEAQwBEAEUARgBIAEkASgBLAE0ATgBPAFAAUgBTAFQAVQCq/6v/rf+u/7D/sf+y/7T/tf+2/7j/uf+6/7v/vf++/7//wf/C/8P/xf/G/8f/yf/K/8v/zf/O/8//0P/S/9P/1P/W/9f/2P/Z/9v/3P/d/9//4P/h/+L/5P/l/+b/5//p/+r/6//t/+7/7//w//L/8//0//X/9//4//n/+v/8//3//v///wAAAgADAAQABQAHAAgACQAKAAsADQAOAA8AEAASABMAFAAVABYAGAAZABoAGwAcAB4AHwAgACEAIgAjACUAJgAnACgAKQArACwALQAuAC8AMAAyADMANAA1ADYANwA5ADoAOwA8AD0APgA/AEEAQgBDAEQARQBGAEcASQBKAEsATABNAE4Asv+z/7T/tf+3/7j/uf+6/7z/vf++/7//wP/C/8P/xP/F/8b/yP/J/8r/y//M/87/z//Q/9H/0v/U/9X/1v/X/9j/2v/b/9z/3f/e/9//4f/i/+P/5P/l/+b/6P/p/+r/6//s/+3/7v/w//H/8v/z//T/9f/2//j/+f/6//v//P/9//7/AAABAAIAAwAEAAUABgAHAAgACgALAAwADQAOAA8AEAARABIAFAAVABYAFwAYABkAGgAbABwAHQAeACAAIQAiACMAJAAlACYAJwAoACkAKgArACwALgAvADAAMQAyADMANAA1ADYANwA4ADkAOgA7ADwAPQA+AD8AQABBAEMARABFAEYARwBIALn/uv+7/7z/vf++/7//wf/C/8P/xP/F/8b/x//I/8n/y//M/83/zv/P/9D/0f/S/9P/1P/V/9f/2P/Z/9r/2//c/93/3v/f/+D/4f/i/+P/5f/m/+f/6P/p/+r/6//s/+3/7v/v//D/8f/y//P/9P/1//b/9//5//r/+//8//3//v///wAAAQACAAMABAAFAAYABwAIAAkACgALAAwADQAOAA8AEAARABIAEwAUABUAFgAXABgAGQAaABsAHAAdAB4AHwAgACEAIgAjACQAJQAmACcAKAApACoAKwAsAC0ALgAvADAAMQAyADMAMwA0ADUANgA3ADgAOQA6ADsAPAA9AD4APwBAAEEAQgC//8D/wf/C/8P/xP/F/8b/x//I/8n/yv/L/8z/zf/O/8//0P/R/9L/0//U/9X/1v/X/9j/2f/a/9v/3P/d/97/3//g/+H/4v/j/+T/5f/m/+f/6P/p/+r/6//s/+3/7v/v//D/8f/y//P/9P/1//b/9//3//j/+f/6//v//P/9//7///8AAAEAAgADAAQABQAGAAcABwAIAAkACgALAAwADQAOAA8AEAARABIAEwATABQAFQAWABcAGAAZABoAGwAcAB0AHQAeAB8AIAAhACIAIwAkACUAJgAmACcAKAApACoAKwAsAC0ALQAuAC8AMAAxADIAMwA0ADQANQA2ADcAOAA5ADoAOwA7AMT/xf/G/8f/yP/J/8r/yv/L/8z/zf/O/8//0P/R/9L/0//U/9X/1v/W/9f/2P/Z/9r/2//c/93/3v/f/+D/4P/h/+L/4//k/+X/5v/n/+j/6f/p/+r/6//s/+3/7v/v//D/8f/x//L/8//0//X/9v/3//j/+P/5//r/+//8//3//v/+////AAABAAIAAwAEAAQABQAGAAcACAAJAAoACgALAAwADQAOAA8ADwAQABEAEgATABQAFAAVABYAFwAYABkAGQAaABsAHAAdAB4AHgAfACAAIQAiACIAIwAkACUAJgAnACcAKAApACoAKwArACwALQAuAC8ALwAwADEAMgAyADMANAA1ADYANgDJ/8r/y//M/83/zv/O/8//0P/R/9L/0//U/9T/1f/W/9f/2P/Z/9n/2v/b/9z/3f/e/97/3//g/+H/4v/j/+P/5P/l/+b/5//n/+j/6f/q/+v/7P/s/+3/7v/v//D/8P/x//L/8//0//T/9f/2//f/+P/4//n/+v/7//z//P/9//7///8AAAAAAQACAAMAAwAEAAUABgAHAAcACAAJAAoACgALAAwADQAOAA4ADwAQABEAEQASABMAFAAUABUAFgAXABcAGAAZABoAGgAbABwAHQAdAB4AHwAgACAAIQAiACMAIwAkACUAJgAmACcAKAAoACkAKgArACsALAAtAC4ALgAvADAAMAAxADIAzv/P/9D/0f/R/9L/0//U/9T/1f/W/9f/1//Y/9n/2v/b/9v/3P/d/97/3v/f/+D/4f/h/+L/4//k/+T/5f/m/+f/5//o/+n/6v/q/+v/7P/t/+3/7v/v//D/8P/x//L/8//z//T/9f/2//b/9//4//j/+f/6//v/+//8//3//v/+////AAAAAAEAAgADAAMABAAFAAUABgAHAAgACAAJAAoACgALAAwADQANAA4ADwAPABAAEQARABIAEwATABQAFQAWABYAFwAYABgAGQAaABoAGwAcABwAHQAeAB4AHwAgACAAIQAiACIAIwAkACQAJQAmACYAJwAoACgAKQAqACoAKwAsACwALQAuANP/0//U/9X/1f/W/9f/2P/Y/9n/2v/a/9v/3P/d/93/3v/f/9//4P/h/+H/4v/j/+T/5P/l/+b/5v/n/+j/6P/p/+r/6v/r/+z/7P/t/+7/7//v//D/8f/x//L/8//z//T/9f/1//b/9//3//j/+f/5//r/+//7//z//f/9//7//////wAAAQABAAIAAwADAAQABAAFAAYABgAHAAgACAAJAAoACgALAAwADAANAA0ADgAPAA8AEAARABEAEgATABMAFAAUABUAFgAWABcAGAAYABkAGQAaABsAGwAcAB0AHQAeAB4AHwAgACAAIQAhACIAIwAjACQAJQAlACYAJgAnACgAKAApACkAKgDX/9f/2P/Z/9n/2v/b/9v/3P/d/93/3v/e/9//4P/g/+H/4v/i/+P/5P/k/+X/5f/m/+f/5//o/+n/6f/q/+v/6//s/+z/7f/u/+7/7//w//D/8f/x//L/8//z//T/9P/1//b/9v/3//j/+P/5//n/+v/7//v//P/8//3//v/+//////8AAAEAAQACAAIAAwAEAAQABQAFAAYABwAHAAgACAAJAAoACgALAAsADAAMAA0ADgAOAA8ADwAQABEAEQASABIAEwATABQAFQAVABYAFgAXABcAGAAZABkAGgAaABsAGwAcABwAHQAeAB4AHwAfACAAIAAhACEAIgAjACMAJAAkACUAJQAmANr/2v/b/9z/3P/d/93/3v/e/9//4P/g/+H/4f/i/+P/4//k/+T/5f/m/+b/5//n/+j/6P/p/+r/6v/r/+v/7P/s/+3/7v/u/+//7//w//H/8f/y//L/8//z//T/9P/1//b/9v/3//f/+P/4//n/+v/6//v/+//8//z//f/9//7//v///wAAAAABAAEAAgACAAMAAwAEAAQABQAGAAYABwAHAAgACAAJAAkACgAKAAsACwAMAA0ADQAOAA4ADwAPABAAEAARABEAEgASABMAEwAUABQAFQAVABYAFwAXABgAGAAZABkAGgAaABsAGwAcABwAHQAdAB4AHgAfAB8AIAAgACEAIQAiACIAIwDd/97/3v/f/9//4P/g/+H/4f/i/+P/4//k/+T/5f/l/+b/5v/n/+f/6P/o/+n/6v/q/+v/6//s/+z/7f/t/+7/7v/v/+//8P/w//H/8f/y//L/8//z//T/9f/1//b/9v/3//f/+P/4//n/+f/6//r/+//7//z//P/9//3//v/+//////8AAAAAAQABAAIAAgADAAMABAAEAAUABQAGAAYABwAHAAgACAAJAAkACgAKAAsACwAMAAwADQANAA4ADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    asking: "data:audio/wav;base64,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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    waiting: "data:audio/wav;base64,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AQEBAQABAAH/AP4A/gD9AP0A/AAF/wX/Bv8G/wf/CP8I/wn/Cf8K/wr/C/8M/wz/Df8N/w7/8QDxAPAA8ADvAO8A7gDuAO0A7ADsAOsA6wDqAOoA6QAY/xj/Gf8Z/xr/Gv8b/xv/HP8c/x3/Hf8e/x//H/8g/yD/3wDfAN4A3gDdAN0A3ADcANsA2wDaANoA2QDZANgA2ADXACr/Kv8r/yv/LP8s/y3/Lf8u/y7/L/8v/zD/MP8x/zH/zwDOAM4AzQDNAMwAzADLAMsAygDKAMkAyQDIAMgAxwDHADr/Ov87/zv/PP88/zz/Pf89/z7/Pv8//z//QP9A/0H/Qf+/AL4AvgC9AL0AvAC8ALsAuwC6ALoAugC5ALkAuAC4ALcASf9J/0r/Sv9L/0v/TP9M/0z/Tf9N/07/Tv9P/0//T/+wALAArwCvAK4ArgCuAK0ArQCsAKwArACrAKsAqgCqAKoAV/9X/1j/WP9Y/1n/Wf9a/1r/Wv9b/1v/XP9c/1z/Xf9d/6MAogCiAKEAoQChAKAAoACfAJ8AnwCeAJ4AngCdAJ0AZP9k/2T/Zf9l/2X/Zv9m/2b/Z/9n/2j/aP9o/2n/af9p/5YAlgCWAJUAlQCVAJQAlACTAJMAkwCSAJIAkgCRAJEAkQBw/3D/cP9x/3H/cf9y/3L/cv9z/3P/c/90/3T/dP91/4sAiwCKAIoAigCJAIkAiQCIAIgAiACHAIcAhwCGAIYAhgB7/3v/e/97/3z/fP98/33/ff99/37/fv9+/3//f/9//3//gACAAIAAfwB/AH8AfgB+AH4AfQB9AH0AfQB8AHwAfAB7AIX/hf+F/4b/hv+G/4f/h/+H/4f/iP+I/4j/if+J/4n/dwB2AHYAdgB1AHUAdQB1AHQAdAB0AHMAcwBzAHMAcgByAI7/jv+P/4//j/+P/5D/kP+Q/5H/kf+R/5H/kv+S/5L/kv9tAG0AbQBtAGwAbABsAGwAawBrAGsAawBqAGoAagBqAJf/l/+X/5f/mP+Y/5j/mP+Z/5n/mf+Z/5r/mv+a/5r/m/9lAGUAZQBkAGQAZABkAGMAYwBjAGMAYwBiAGIAYgBiAGEAn/+f/5//oP+g/6D/oP+g/6H/of+h/6H/ov+i/6L/ov9eAF0AXQBdAF0AXABcAFwAXABcAFsAWwBbAFsAWgBaAFoApv+m/6f/p/+n/6f/p/+o/6j/qP+o/6j/qf+p/6n/qf+q/1YAVgBWAFYAVQBVAFUAVQBVAFQAVABUAFQAVABTAFMAUwCt/63/rv+u/67/rv+u/67/r/+v/6//r/+v/7D/sP+w/1AAUABPAE8ATwBPAE8ATgBOAE4ATgBOAE4ATQBNAE0ATQCz/7T/tP+0/7T/tP+0/7X/tf+1/7X/tf+2/7b/tv+2/7b/SgBJAEkASQBJAEkASQBIAEgASABIAEgASABHAEcARwC5/7n/uf+6/7r/uv+6/7r/uv+7/7v/u/+7/7v/u/+8/7z/RABEAEQARABDAEMAQwBDAEMAQwBCAEIAQgBCAEIAQgBCAL//v/+//7//v/+//8D/wP/A/8D/wP/A/8D/wf/B/8H/wf8/AD8APgA+AD4APgA+AD4APgA9AD0APQA9AD0APQA9AMT/xP/E/8T/xP/E/8T/xf/F/8X/xf/F/8X/xf/G/8b/xv86ADoAOgA6ADoAOQA5ADkAOQA5ADkAOQA4ADgAOAA4ADgAyP/I/8j/yf/J/8n/yf/J/8n/yf/K/8r/yv/K/8r/yv82ADYANQA1ADUANQA1ADUANQA1ADQANAA0ADQANAA0ADQAzP/N/83/zf/N/83/zf/N/83/zv/O/87/zv/O/87/zv/O/zIAMQAxADEAMQAxADEAMQAxADAAMAAwADAAMAAwADAA0P/Q/9H/0f/R/9H/0f/R/9H/0f/R/9L/0v/S/9L/0v/S/y4ALgAuAC0ALQAtAC0ALQAtAC0ALQAtAC0ALAAsACwALADU/9T/1P/U/9T/1f/V/9X/1f/V/9X/1f/V/9X/1f/W/9b/KgAqACoAKgAqACoAKgAqACkAKQApACkAKQApACkAKQDX/9f/2P/Y/9j/2P/Y/9j/2P/Y/9j/2P/Y/9n/2f/Z/9n/JwAnACcAJwAnACcAJwAmACYAJgAmACYAJgAmACYAJgAmANr/2//b/9v/2//b/9v/2//b/9v/2//b/9z/3P/c/9z/JAAkACQAJAAkACQAJAAkACMAIwAjACMAIwAjACMAIwAjAN3/3f/d/97/3v/e/97/3v/e/97/3v/e/97/3v/e/9//3/8hACEAIQAhACEAIQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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LP8s/y3/Lf8u/y7/L/8v/zD/MP8x/zH/zwDOAM4AzQDNAMwAzADLAMsAygDKAMkAyQDIAMgAxwDHADr/Ov87/zv/PP88/zz/Pf89/z7/Pv8//z//QP9A/0H/Qf+/AL4AvgC9AL0AvAC8ALsAuwC6ALoAugC5ALkAuAC4ALcASf9J/0r/Sv9L/0v/TP9M/0z/Tf9N/07/Tv9P/0//T/+wALAArwCvAK4ArgCuAK0ArQCsAKwArACrAKsAqgCqAKoAV/9X/1j/WP9Y/1n/Wf9a/1r/Wv9b/1v/XP9c/1z/Xf9d/6MAogCiAKEAoQChAKAAoACfAJ8AnwCeAJ4AngCdAJ0AZP9k/2T/Zf9l/2X/Zv9m/2b/Z/9n/2j/aP9o/2n/af9p/5YAlgCWAJUAlQCVAJQAlACTAJMAkwCSAJIAkgCRAJEAkQBw/3D/cP9x/3H/cf9y/3L/cv9z/3P/c/90/3T/dP91/4sAiwCKAIoAigCJAIkAiQCIAIgAiACHAIcAhwCGAIYAhgB7/3v/e/97/3z/fP98/33/ff99/37/fv9+/3//f/9//3//gACAAIAAfwB/AH8AfgB+AH4AfQB9AH0AfQB8AHwAfAB7AIX/hf+F/4b/hv+G/4f/h/+H/4f/iP+I/4j/if+J/4n/dwB2AHYAdgB1AHUAdQB1AHQAdAB0AHMAcwBzAHMAcgByAI7/jv+P/4//j/+P/5D/kP+Q/5H/kf+R/5H/kv+S/5L/kv9tAG0AbQBtAGwAbABsAGwAawBrAGsAawBqAGoAagBqAJf/l/+X/5f/mP+Y/5j/mP+Z/5n/mf+Z/5r/mv+a/5r/m/9lAGUAZQBkAGQAZABkAGMAYwBjAGMAYwBiAGIAYgBiAGEAn/+f/5//oP+g/6D/oP+g/6H/of+h/6H/ov+i/6L/ov9eAF0AXQBdAF0AXABcAFwAXABcAFsAWwBbAFsAWgBaAFoApv+m/6f/p/+n/6f/p/+o/6j/qP+o/6j/qf+p/6n/qf+q/1YAVgBWAFYAVQBVAFUAVQBVAFQAVABUAFQAVABTAFMAUwCt/63/rv+u/67/rv+u/67/r/+v/6//r/+v/7D/sP+w/1AAUABPAE8ATwBPAE8ATgBOAE4ATgBOAE4ATQBNAE0ATQCz/7T/tP+0/7T/tP+0/7X/tf+1/7X/tf+2/7b/tv+2/7b/SgBJAEkASQBJAEkASQBIAEgASABIAEgASABHAEcARwC5/7n/uf+6/7r/uv+6/7r/uv+7/7v/u/+7/7v/u/+8/7z/RABEAEQARABDAEMAQwBDAEMAQwBCAEIAQgBCAEIAQgBCAL//v/+//7//v/+//8D/wP/A/8D/wP/A/8D/wf/B/8H/wf8/AD8APgA+AD4APgA+AD4APgA9AD0APQA9AD0APQA9AMT/xP/E/8T/xP/E/8T/xf/F/8X/xf/F/8X/xf/G/8b/xv86ADoAOgA6ADoAOQA5ADkAOQA5ADkAOQA4ADgAOAA4ADgAyP/I/8j/yf/J/8n/yf/J/8n/yf/K/8r/yv/K/8r/yv82ADYANQA1ADUANQA1ADUANQA1ADQANAA0ADQANAA0ADQAzP/N/83/zf/N/83/zf/N/83/zv/O/87/zv/O/87/zv/O/zIAMQAxADEAMQAxADEAMQAxADAAMAAwADAAMAAwADAA0P/Q/9H/0f/R/9H/0f/R/9H/0f/R/9L/0v/S/9L/0v/S/y4ALgAuAC0ALQAtAC0ALQAtAC0ALQAtAC0ALAAsACwALADU/9T/1P/U/9T/1f/V/9X/1f/V/9X/1f/V/9X/1f/W/9b/KgAqACoAKgAqACoAKgAqACkAKQApACkAKQApACkAKQDX/9f/2P/Y/9j/2P/Y/9j/2P/Y/9j/2P/Y/9n/2f/Z/9n/JwAnACcAJwAnACcAJwAmACYAJgAmACYAJgAmACYAJgAmANr/2//b/9v/2//b/9v/2//b/9v/2//b/9z/3P/c/9z/JAAkACQAJAAkACQAJAAkACMAIwAjACMAIwAjACMAIwAjAN3/3f/d/97/3v/e/97/3v/e/97/3v/e/97/3v/e/9//3/8hACEAIQAhACEAIQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEAgwDEAAUBRwGIAckBCwJMAo0CzwIQA678bfws/Or7qfto+yb75fqk+mL6Ifrg+Z75owbkBiYHZweoB+oHKwhtCK4I7wgxCXIJTfYL9sr1ifVH9Qb1xfSD9EL0AfS/837zPfMFDUYNhw3JDQoOTA6NDs4OEA9RD5IP1A/r76rvaO8n7+bupO5j7iLu4O2f7V7tHO3b7GYTqBPpEysUbBStFO8UMBVxFbMV9BU1FonpSOkH6cXohOhD6AHowOd/5z3n/Oa65nnmyBkKGksajBrOGg8bUBuSG9MbFBxWHJccKOPm4qXiZOIi4uHhoOFe4R3h2+Ca4FngF+AqIGsgrSDuIC8hcSGyIfMhNSJ2Irci+SLG3IXcQ9wC3MHbf9s+2/zau9p62jja99m22YwmzSYOJ1AnkSfSJxQoVSiWKNgoGSlaKWTWI9bh1aDVX9Ud1dzUm9RZ1BjU19OV01TT7SzgLNMsxiy5LKwsnyySLIQsdyxqLF0ssNO908rT19Pj0/DT/dMK1BfUJNQx1D7UStSpK5wrjyuCK3YraStcK1ArQys2KyorHSvw1PzUCdUW1SLVL9U71UjVVNVh1W3VetWG1W0qYSpVKkgqPCovKiMqFyoKKv4p8inlKdkpM9Y/1kzWWNZk1nDWfNaJ1pXWodat1rnWOykvKSMpFykLKf8o8yjnKNsozyjDKLcoqyhh123XedeF15HXnNeo17TXwNfM19fX49cRKAUo+ifuJ+In1ifLJ78nsyeoJ5wnkSeFJ4fYktie2KnYtdjA2MzY19jj2O7Y+tgF2fAm5CbZJs0mwia3JqsmoCaVJokmfiZzJmgmpNmv2brZxdnR2dzZ59ny2f3ZCNoU2h/a1iXLJcAltSWqJZ8llCWJJX4lcyVoJV0lUiW52sTaz9ra2uTa79r62gXbENsb2yXbMNvFJLokrySlJJokjySEJHokbyRkJFokTyREJMbb0dvb2+bb8dv72wbcENwb3CXcMNw63LsjsSOmI5wjkiOHI30jciNoI14jUyNJIz4jzNzW3ODc69z13P/cCt0U3R7dKN0y3T3duSKvIqUimyKRIoYifCJyImgiXiJUIkoiQCLK3dTd3t3o3fLd/N0G3hDeGt4k3i7eON6+IbQhqyGhIZchjSGDIXkhcCFmIVwhUiFIIcHey97V3t7e6N7y3vzeBd8P3xnfIt8s3zXfwSC3IK4gpCCbIJEgiCB+IHQgayBhIFggsd+738Tfzt/X3+Hf6t/z3/3fBuAQ4BngIuDUH8sfwh+4H68fph+dH5Mfih+BH3gfbh+b4KTgreC24MDgyeDS4Nvg5ODt4Pbg/+AJ4e4e5R7cHtMeyh7BHrgerx6mHp0elB6LHn7hh+GQ4ZjhoeGq4bPhvOHF4c7h1+Hf4ejhDx4GHv0d9R3sHeMd2h3RHckdwB23Ha8dWuJj4mvidOJ94oXijuKX4p/iqOKw4rniwuI2HS0dJR0cHRQdCx0DHfoc8hzpHOEc2Bww4znjQeNK41LjWuNj42vjdON844TjjeOV42McWhxSHEocQhw5HDEcKRwgHBgcEBwIHADk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+wkI9gv2DvYR9hT2F/Ya9h32IPYi9iX2KPYr9tIJzwnMCckJxwnECcEJvgm7CbgJtQmzCVD2U/ZW9ln2XPZe9mH2ZPZn9mr2bfZv9nL2iwmICYUJgwmACX0Jegl4CXUJcglvCWwJlvaZ9pz2n/ah9qT2p/aq9qz2r/ay9rT2t/ZGCUMJQQk+CTsJOQk2CTMJMAkuCSsJKAkmCd324Pbi9uX26Pbq9u328Pby9vX2+Pb69gMJAAn+CPsI+Qj2CPMI8QjuCOsI6QjmCOQIH/ci9yT3J/cp9yz3L/cx9zT3Nvc59zv3wgi/CL0Iugi4CLUIswiwCK4IqwioCKYIowhf92L3ZPdn92n3bPdu93H3c/d293j3e/eDCIAIfgh7CHkIdgh0CHEIbwhsCGoIZwhlCJ33oPei96X3p/eq96z3r/ex97P3tve490UIQwhACD4IPAg5CDcINAgyCDAILQgrCCgI2vfc99/34ffk9+b36Pfr9+337/fy9/T3CggHCAUIAggACP4H+wf5B/cH9AfyB/AH7QcV+Bf4Gvgc+B74IPgj+CX4J/gq+Cz4LvjPB80HywfJB8YHxAfCB78HvQe7B7kHtge0B074UPhT+FX4V/hZ+Fz4Xvhg+GL4Zfhn+JcHlQeTB5AHjgeMB4oHiAeFB4MHgQd/B30HhviI+Ir4jPiO+JH4k/iV+Jf4mfib+J74YAdeB1wHWgdYB1UHUwdRB08HTQdLB0kHRge8+L74wPjC+MT4xvjI+Mv4zfjP+NH40/jV+CkHJwclByMHIAceBxwHGgcYBxYHFAcSB/D48vj0+Pb4+Pj7+P34//gB+QP5BfkH+Qn59QbzBvEG7wbtBusG6QbnBuUG4wbhBt8GI/kl+Sf5Kfkr+S35L/kx+TP5Nfk3+Tn5O/nDBsEGvwa9BrsGuQa3BrUGswaxBq8GrQZV+Vf5Wflb+V35X/lg+WL5ZPlm+Wj5avls+ZIGkAaOBowGigaIBoYGhQaDBoEGfwZ9BoX5h/mJ+Yv5jfmO+ZD5kvmU+Zb5mPma+Zz5YwZhBl8GXQZbBlkGVwZVBlQGUgZQBk4GtPm2+bf5ufm7+b35v/nB+cL5xPnG+cj5yvk0BjMGMQYvBi0GKwYqBigGJgYkBiIGIQbh+eP55fnn+ej56vns+e758Pnx+fP59fn3+QgGBgYEBgIGAQb/Bf0F+wX5BfgF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wgDCAMIAwgDBAMEAP/8//z//QP9A/0D/QP9B/0H/Qf9B/0H/Qv++AL4AvgC9AL0AvQC9AL0AvAC8ALwAvAC8AEX/Rf9F/0X/Rv9G/0b/Rv9G/0f/R/9H/7kAuQC4ALgAuAC4ALcAtwC3ALcAtwC2ALYASv9K/0r/S/9L/0v/S/9L/0z/TP9M/0z/tACzALMAswCzALMAsgCyALIAsgCxALEAsQBP/0//UP9Q/1D/UP9Q/1H/Uf9R/1H/Uf+uAK4ArgCuAK4ArQCtAK0ArQCtAKwArACsAFT/VP9V/1X/Vf9V/1X/Vf9W/1b/Vv9W/6oAqQCpAKkAqQCpAKgAqACoAKgAqACnAKcAWf9Z/1n/Wv9a/1r/Wv9a/1r/W/9b/1v/pQClAKQApACkAKQApACjAKMAowCjAKMAowBe/17/Xv9e/17/X/9f/1//X/9f/2D/YP+gAKAAoACgAJ8AnwCfAJ8AnwCeAJ4AngCeAGL/Yv9j/2P/Y/9j/2P/ZP9k/2T/ZP9k/5wAmwCbAJsAmwCbAJsAmgCaAJoAmgCaAJkAZ/9n/2f/Z/9n/2j/aP9o/2j/aP9o/2n/lwCXAJcAlwCXAJYAlgCWAJYAlgCVAJUAlQBr/2v/a/9s/2z/bP9s/2z/bP9t/23/bf9t/5MAkwCSAJIAkgCSAJIAkgCRAJEAkQCRAG//b/9w/3D/cP9w/3D/cP9x/3H/cf9x/3H/jwCOAI4AjgCOAI4AjgCNAI0AjQCNAI0Ac/9z/3T/dP90/3T/dP90/3X/df91/3X/df+LAIoAigCKAIoAigCKAIkAiQCJAIkAiQB3/3f/eP94/3j/eP94/3j/ef95/3n/ef95/4cAhwCGAIYAhgCGAIYAhgCFAIUAhQCFAHv/e/97/3z/fP98/3z/fP98/33/ff99/33/gwCDAIMAggCCAIIAggCCAIIAggCBAIEAf/9//3//f/9//4D/gP+A/4D/gP+A/4H/gf9/AH8AfwB/AH8AfgB+AH4AfgB+AH4AfgCD/4P/g/+D/4P/g/+D/4T/hP+E/4T/hP+E/3wAewB7AHsAewB7AHsAewB6AHoAegB6AIb/hv+G/4f/h/+H/4f/h/+H/4f/h/+I/4j/eAB4AHgAeAB4AHcAdwB3AHcAdwB3AHcAiv+K/4r/iv+K/4r/iv+K/4v/i/+L/4v/i/91AHUAdAB0AHQAdAB0AHQAdAB0AHMAcwBzAI3/jf+N/43/jv+O/47/jv+O/47/jv+O/3EAcQBxAHEAcQBxAHEAcQBwAHAAcABwAHAAkP+Q/5D/kf+R/5H/kf+R/5H/kf+S/5L/bgBuAG4AbgBuAG4AbQBtAG0AbQBtAG0AbQCT/5T/lP+U/5T/lP+U/5T/lP+V/5X/lf9rAGsAawBrAGsAawBqAGoAagBqAGoAagBqAJb/l/+X/5f/l/+X/5f/l/+X/5j/mP+Y/2gAaABoAGgAaABoAGcAZwBnAGcAZwBnAGcAmf+a/5r/mv+a/5r/mv+a/5r/mv+b/5v/ZQBlAGUAZQBlAGUAZABkAGQAZABkAGQAZACc/5z/nf+d/53/nf+d/53/nf+d/53/nv9iAGIAYgBiAGIAYgBiAGIAYQBhAGEAYQBhAJ//n/+f/5//oP+g/6D/oP+g/6D/oP+g/2AAXwBfAF8AXwBfAF8AXwBfAF8AXgBeAF4Aov+i/6L/ov+i/6L/o/+j/6P/o/+j/6P/XQBdAF0AXQBcAFwAXABcAFwAXABcAFwAXACl/6X/pf+l/6X/pf+l/6X/pf+l/6b/pv9aAFoAWgBaAFoAWgBaAFkAWQBZAFkAWQBZAKf/p/+n/6f/qP+o/6j/qP+o/6j/qP+o/6j/WABXAFcAVwBXAFcAVwBXAFcAVwBXAFYAqv+q/6r/qv+q/6r/qv+q/6r/q/+r/6v/q/9VAFUAVQBVAFUAVQBVAFQAVABUAFQAVACs/6z/rP+s/6z/rf+t/63/rf+t/63/rf+t/1MAUwBTAFIAUgBSAFIAUgBSAFIAUgBSAK7/r/+v/6//r/+v/6//r/+v/6//r/+v/7D/UABQAFAAUABQAFAAUABQAFAAUABPAE8Asf+x/7H/sf+x/7H/sf+x/7H/sv+y/7L/sv9OAE4ATgBOAE4ATgBOAE0ATQBNAE0ATQCz/7P/s/+z/7P/s/+z/7T/tP+0/7T/tP+0/0wATABMAEwATABLAEsASwBLAEsASwBLALX/tf+1/7X/tf+2/7b/tv+2/7b/tv+2/7b/SgBKAEoASQBJAEkASQBJAEkASQBJAEkAt/+3/7f/uP+4/7j/uP+4/7j/uP+4/7j/uP9IAEgASABHAEcARwBHAEcARwBHAEcARwC5/7n/uf+6/7r/uv+6/7r/uv+6/7r/uv+6/0YARgBFAEUARQBFAEUARQBFAEUARQBFAEUAu/+7/7z/vP+8/7z/vP+8/7z/vP+8/7z/RABEAEQAQwBDAEMAQwBDAEMAQwBDAEMAQwC9/73/vf++/77/vv++/77/vv++/77/vv9CAEIAQgBCAEEAQQBBAEEAQQBBAEEAQQBBAL//v/+//7//v//A/8D/wP/A/8D/wP/A/0AAQABAAEAAQABAAD8APwA/AD8APwA/AD8Awf/B/8H/wf/B/8H/wf/C/8L/wv/C/8L/PgA+AD4APgA+AD4APgA+AD4APQA9AD0APQDD/8P/w//D/8P/w//D/8P/w//D/8T/xP88ADwAPAA8ADwAPAA8ADwAPAA8ADwAPAA8AMX/xf/F/8X/xf/F/8X/xf/F/8X/xf/F/zsAOwA7ADoAOgA6ADoAOgA6ADoAOgA6ADoAxv/G/8b/xv/G/8f/x//H/8f/x//H/8f/OQA5ADkAOQA5ADkAOQA5ADgAOAA4ADgAOADI/8j/yP/I/8j/yP/I/8j/yP/I/8j/yf83ADcANwA3ADcANwA3ADcANwA3ADcANwA3AMn/yf/K/8r/yv/K/8r/yv/K/8r/yv/K/8r/NgA2ADYANgA2ADUANQA1ADUANQA1ADUAy//L/8v/y//L/8v/y//L/8v/zP/M/8z/zP80ADQANAA0ADQANAA0ADQANAA0ADQANADM/83/zf/N/83/zf/N/83/zf/N/83/zf/N/zMAMwAzADMAMwAyADIAMgAyADIAMgAyAM7/zv/O/87/zv/O/87/zv/O/87/zv/P/8//MQAxADEAMQAxADEAMQAxADEAMQAxADEAz//P/8//z//Q/9D/0P/Q/9D/0P/Q/9D/0P8wADAAMAAwADAAMAAwADAAMAAvAC8ALwDR/9H/0f/R/9H/0f/R/9H/0f/R/9H/0f/R/y8ALwAuAC4ALgAuAC4ALgAuAC4ALgAuANL/0v/S/9L/0v/S/9L/0v/S/9P/0//T/9P/LQAtAC0ALQAtAC0ALQAtAC0ALQAtAC0A0//T/9P/0//U/9T/1P/U/9T/1P/U/9T/1P8sACwALAAsACwALAAsACwALAAsACwAKwDV/9X/1f/V/9X/1f/V/9X/1f/V/9X/1f/V/ysAKwArACsAKwArACoAKgAqACoAKgAqACoA1v/W/9b/1v/W/9b/1v/W/9b/1v/W/9b/KgAqACkAKQApACkAKQApACkAKQApACkAKQDX/9f/1//X/9f/1//X/9f/1//X/9j/2P8oACgAKAAoACgAKAAoACgAKAAoACgAKAAoANj/2P/Y/9j/2P/Y/9j/2f/Z/9n/2f/Z/ycAJwAnACcAJwAnACcAJwAnACcAJwAnACcA2f/Z/9n/2f/a/9r/2v/a/9r/2v/a/9r/JgAmACYAJgAmACYAJgAmACYAJgAmACYAJgDa/9r/2//b/9v/2//b/9v/2//b/9v/2/8lACUAJQAlACUAJQAlACUAJQAlACUAJQAlANv/3P/c/9z/3P/c/9z/3P/c/9z/3P/c/yQAJAAkACQAJAAkACQAJAAkACQAJAAkACQA3f/d/93/3f/d/93/3f/d/93/3f/d/93/IwAjACMAIwAjACMAIwAjACMAIwAjACMAIwDe/97/3v/e/97/3v/e/97/3v/e/97/3v8iACIAIgAiACIAIgAiACIAIgAiACIAIgAiAN7/3//f/9//3//f/9//3//f/9//3//f/yEAIQAhACEAIQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  const BUILTIN_SOUNDS = {
    done: [[660, 0], [880, 0.13]],
    failed: [[370, 0], [277, 0.16]],
    waiting: [[520, 0], [660, 0.16]],
    asking: [[520, 0], [780, 0.16]],
  };
  /** 内置默认音频（随包，非上传）；用户没上传该相位就用它。 */
  const defaultSoundFor = (phase) => DEFAULT_SOUND_AUDIO[phase];
  const cleanSoundNotes = (raw) => Array.isArray(raw) && raw.length <= 8
    && raw.every((note) => Array.isArray(note) && note.length === 2
      && typeof note[0] === "number" && Number.isFinite(note[0]) && note[0] >= 80 && note[0] <= 4000
      && typeof note[1] === "number" && Number.isFinite(note[1]) && note[1] >= 0 && note[1] <= 2)
    ? raw.map((note) => note.slice()) : [];
  const petSoundNotesFor = (phase) => cleanSoundNotes(
    MANIFEST.current?.sounds === null || MANIFEST.current?.sounds === undefined
      ? BUILTIN_SOUNDS[phase] : MANIFEST.current.sounds[phase]);
  const soundNotesFor = (phase) => Object.prototype.hasOwnProperty.call(PHASE_OVERRIDES.sounds, phase)
    ? PHASE_OVERRIDES.sounds[phase] : petSoundNotesFor(phase);
  const setPhaseSoundMuted = (phase, muted) => {
    if (muted) {
      PHASE_OVERRIDES.sounds[phase] = [];
      if (playingUploadedPhase === phase) stopUploadedSound();
    }
    else delete PHASE_OVERRIDES.sounds[phase];
    saveOverrides();
    notifySettings();
  };
  /**
   * 播一段上传音频。真实相位与设置页的「试听」共用它 —— 两条路必须发出同一种声音，
   * 分开写迟早会漂移（试听听到的和真响的不一样，比没有试听更糟）。
   */
  const playAudioUrl = (url, volume, phase = null) => {
    try {
      const audio = new window.Audio(url);
      audio.volume = volume;
      playingUploaded = audio;
      playingUploadedPhase = phase;
      void audio.play().catch(() => { /* 浏览器阻止自动播放时不影响相位动画 */ });
      return true;
    } catch { return false; /* 音频设备不可用时不影响相位动画 */ }
  };
  const playUploadedSound = (phase, entry, volume) => playAudioUrl(
    SOUND_URL + "/" + encodeURIComponent(MANIFEST.current.id) + "/" + phase + "?token=" + entry.token,
    volume,
    phase,
  );
  /** 把一个相位的音符排进 AudioContext。同样是与「试听」共用的那一份。 */
  const scheduleSoundNotes = (context, notes, volume) => {
    try {
      const now = context.currentTime;
      for (const [frequency, offset] of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(volume * 0.12, now + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.16);
      }
      return true;
    } catch { return false; /* 音频异常不能中断相位动画 */ }
  };
  /**
   * 这次相位提醒要不要出声（只影响声音，不影响动画）：
   *  - 当前会话免打扰：页面隐藏/最小化一定响；`unfocused` 在切走（窗口失焦）时也响；
   *    `always` 一律响；其余情况（你正看着这个页面）静默。
   *  - 提醒范围：子代理（helper）只有 `all` 才出声，其余范围视为"主会话的提醒"。
   */
  const reminderSoundAllowed = (phase) => {
    if (typeof document === "undefined") return true;
    const notify = PHASE_OVERRIDES.notify ?? {};
    if (phase === "helper" && (notify.scope ?? "wait") !== "all") return false;
    const mode = notify.currentMode ?? "hidden";
    if (document.visibilityState === "hidden") return true;
    if (mode === "always") return true;
    if (mode === "unfocused" && document.hasFocus() === false) return true;
    return false;
  };

  const playPhaseSound = (phase) => {
    if (!reminderSoundAllowed(phase)) return;
    stopUploadedSound();
    if (!FLAGS.soundEnabled || !(TUNING.soundVolume > 0)) return;
    if (Object.prototype.hasOwnProperty.call(PHASE_OVERRIDES.sounds, phase)
      && PHASE_OVERRIDES.sounds[phase].length === 0) return;
    const uploaded = uploadedSoundFor(phase);
    if (uploaded !== undefined) { playUploadedSound(phase, uploaded, TUNING.soundVolume); return; }
    const defaultAudio = defaultSoundFor(phase);
    if (defaultAudio !== undefined) { playAudioUrl(defaultAudio, TUNING.soundVolume, phase); return; }
    const notes = soundNotesFor(phase);
    if (notes.length === 0 || soundContext?.state !== "running") return;
    scheduleSoundNotes(soundContext, notes, TUNING.soundVolume);
  };

  /**
   * 试听：设置页里"我现在就要听一下这个相位"。（`PREVIEW_VOLUME` 是音量被拉到 0 时的兜底。）
   *
   * 与真实播放**只差两点，且都是故意的**：
   *   1. 不看总开关、不看单相位静音 —— 默认总开关就是关的（`soundEnabled: false`），
   *      跟着它走的话点试听必然没反应，等于没做；
   *   2. 取音源时跳过"静音覆盖"（`sounds[phase] = []`），仍按"上传音频 > 宠物音符"拿
   *      **有效来源**，这样静音着的相位也能先听再决定要不要开。
   * 返回是否真的发出了声音（设置页与驱动都靠它判断，不靠听）。
   */
  const PREVIEW_VOLUME = 0.35;
  const previewNotesFor = (phase) => {
    const override = PHASE_OVERRIDES.sounds[phase];
    return Array.isArray(override) && override.length > 0 ? override : petSoundNotesFor(phase);
  };
  const canPreviewPhaseSound = (phase) => uploadedSoundFor(phase) !== undefined
    || defaultSoundFor(phase) !== undefined
    || previewNotesFor(phase).length > 0;
  const previewPhaseSound = (phase) => {
    try {
      if (typeof MANIFEST.current?.id !== "string" || !PHASE_LINE_KEYS.includes(phase)) return false;
      stopUploadedSound();
      const volume = TUNING.soundVolume > 0 ? TUNING.soundVolume : PREVIEW_VOLUME;
      const uploaded = uploadedSoundFor(phase);
      if (uploaded !== undefined) return playUploadedSound(phase, uploaded, volume);
      const defaultAudio = defaultSoundFor(phase);
      if (defaultAudio !== undefined) return playAudioUrl(defaultAudio, volume, phase);
      const notes = previewNotesFor(phase);
      if (notes.length === 0) return false;
      const context = ensureSoundContext();
      if (context === null) return false;
      // 首次点击时 AudioContext 常常还是 suspended，而 resume() 是异步的：
      // 等它落地再排音符，否则会像真实相位那样被 state 检查挡掉、又变成"点了没反应"。
      if (context.state === "suspended") {
        void context.resume().then(() => { scheduleSoundNotes(context, notes, volume); }).catch(() => {});
        return true;
      }
      return scheduleSoundNotes(context, notes, volume);
    } catch { return false; }
  };

  /**
   * 拖音量滑杆时的即时试听：音量只有数字时，用户只能靠"下一次相位切换"猜它有多大。
   *
   * 与上面那个「试听」按钮**只差音量处理**：这里按**真实音量**播（音量 0 就是静音），
   * 因为"0 听起来是什么样"的答案本来就是"没声"；按钮那边用兜底音量，避免点了没反应。
   * 音源取这只宠物"最像提示音"的那段（优先 `done`，否则第一个有音的相位）。
   */
  const volumePreviewNotes = () => {
    const done = previewNotesFor("done");
    if (done.length > 0) return done;
    for (const phase of PHASE_LINE_KEYS) {
      const notes = previewNotesFor(phase);
      if (notes.length > 0) return notes;
    }
    return [];
  };
  const previewVolumeSound = () => {
    try {
      const volume = TUNING.soundVolume;
      if (!(volume > 0)) return false; // 0 = 静音，这里就该听不到，不许兜底
      const notes = volumePreviewNotes();
      if (notes.length === 0) return false; // 这只宠物没有任何音源：滑杆只给数字反馈
      const context = ensureSoundContext();
      if (context === null) return false;
      if (context.state === "suspended") {
        void context.resume().then(() => { scheduleSoundNotes(context, notes, volume); }).catch(() => {});
        return true;
      }
      return scheduleSoundNotes(context, notes, volume);
    } catch { return false; }
  };
  /** 拖滑杆会连着来几十次 onChange：防抖到停手再响，否则是电音。 */
  const VOLUME_PREVIEW_DEBOUNCE_MS = 160;
  let volumePreviewTimer = 0;
  const scheduleVolumePreview = () => {
    if (volumePreviewTimer !== 0) window.clearTimeout(volumePreviewTimer);
    volumePreviewTimer = window.setTimeout(() => {
      volumePreviewTimer = 0;
      previewVolumeSound();
    }, VOLUME_PREVIEW_DEBOUNCE_MS);
  };

  const saveOverrides = () => {
    // 走共享落点（宿主优先）：相位池子覆盖与开关两个窗口共用同一份。
    persistShared({ overrides: Object.assign({}, PHASE_OVERRIDES, { flags: FLAGS }) });
  };

  /** 开关类设置：存档 + 广播（装扮存档开关关掉时顺带清掉那份存档）。 */
  const applyFlag = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(FLAGS, key)) return;
    FLAGS[key] = value === true;
    if (key === "soundEnabled") {
      if (FLAGS[key]) unlockSound();
      else {
        if (soundContext !== null) void soundContext.suspend().catch(() => {});
        stopUploadedSound();
      }
    }
    if (key === "outfitArchive" && FLAGS[key] === false) {
      try {
        storage.removeItem(OUTFIT_KEY);
      } catch {
        /* 无痕模式：本来也没存下 */
      }
    }
    saveOverrides();
    notifySettings();
  };

  /**
   * 条目表校验：一条 = `{ label, weight }`，label 为 null 表示「默认 / 空着」。
   *
   * 返回 null 表示"这里根本不是一张表"（老版本的存档形状），空数组则是**合法的**——
   * 整张表被删空，就是一个不出手的池子。
   */
  const sanitizeEntries = (raw) => {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const label = typeof item.label === "string" && item.label !== "" ? item.label : null;
      const weight = typeof item.weight === "number" && Number.isFinite(item.weight)
        ? Math.min(99, Math.max(0, item.weight))
        : 1;
      out.push({ label, weight });
    }
    return out;
  };

  /** 读回存档；值只做类型校验，范围由调用方按权重语义处理。 */
  /**
   * 读回相位池子覆盖 + 开关。
   *
   * `given` 传进来时用它（宿主拉回来的那份），否则读 localStorage —— 两条路的清洗逻辑
   * 是同一份，别写第二遍（写第二遍的下场是两边清洗规则慢慢分叉）。
   */
  const restoreOverrides = (given) => {
    let saved = given === undefined ? null : given;
    if (saved === undefined || saved === null) {
      try {
        saved = JSON.parse(storage.getItem(OVERRIDE_KEY) ?? "null");
      } catch {
        saved = null;
      }
    }
    if (saved === null || typeof saved !== "object") return;
    // 提醒偏好（当前会话免打扰时机 / 提醒范围）：两端共享，所以也随 overrides 存。
    const notifySaved = saved.notify;
    if (notifySaved !== null && typeof notifySaved === "object") {
      if (["hidden", "unfocused", "always"].includes(notifySaved.currentMode)) PHASE_OVERRIDES.notify.currentMode = notifySaved.currentMode;
      if (["all", "main", "wait"].includes(notifySaved.scope)) PHASE_OVERRIDES.notify.scope = notifySaved.scope;
    }
    const phases = saved.phases;
    if (phases !== null && typeof phases === "object") {
      for (const [phase, entry] of Object.entries(phases)) {
        if (entry === null || typeof entry !== "object") continue;
        const next = {};
        // 相位 = 每个槽位一张条目表（老版本的 motion/expression 单选已经拆掉，
        // 读不出来的旧字段直接忽略，不会把宠物弄坏）。
        if (entry.pools !== null && typeof entry.pools === "object") {
          const pools = {};
          for (const [slotId, list] of Object.entries(entry.pools)) {
            const entries = sanitizeEntries(list);
            if (entries !== null) pools[slotId] = entries;
          }
          next.pools = pools;
        }
        if (Object.keys(next).length > 0) PHASE_OVERRIDES.phases[phase] = next;
      }
    }
    const fidget = saved.fidget;
    if (fidget !== null && typeof fidget === "object") {
      for (const [slotId, entry] of Object.entries(fidget)) {
        if (entry === null || typeof entry !== "object") continue;
        const next = {};
        // 条目表是摸鱼池的**本体**（增删条目就是改池子），而这里原来只读了老的
        // none/options —— 于是"删掉的条目下次刷新会自己长回来"，改动看着生效、
        // 其实一次都没存住。
        const entries = sanitizeEntries(entry.entries);
        if (entries !== null) next.entries = entries;
        if (typeof entry.none === "number" && Number.isFinite(entry.none)) {
          next.none = Math.min(99, Math.max(0, entry.none));
        }
        if (entry.options !== null && typeof entry.options === "object") {
          const options = {};
          for (const [label, weight] of Object.entries(entry.options)) {
            if (typeof weight === "number" && Number.isFinite(weight)) options[label] = Math.min(99, Math.max(0, weight));
          }
          if (Object.keys(options).length > 0) next.options = options;
        }
        if (Object.keys(next).length > 0) PHASE_OVERRIDES.fidget[slotId] = next;
      }
    }
    // 选项关系（同时 / 前提）的覆盖。
    const relations = saved.relations;
    if (relations !== null && typeof relations === "object") {
      for (const [key, entry] of Object.entries(relations)) {
        if (entry === null || typeof entry !== "object") continue;
        const next = {};
        if (entry.pairs !== null && typeof entry.pairs === "object") {
          const pairs = {};
          for (const [slotId, label] of Object.entries(entry.pairs)) {
            if (typeof label === "string" && label !== "") pairs[slotId] = label;
          }
          next.pairs = pairs;
        }
        if (Array.isArray(entry.requires)) {
          const requires = [];
          for (const row of entry.requires) {
            if (row === null || typeof row !== "object") continue;
            if (typeof row.label !== "string" || row.label === "") continue;
            requires.push({ slot: typeof row.slot === "string" ? row.slot : null, label: row.label });
          }
          next.requires = requires;
        }
        if (Object.keys(next).length > 0) PHASE_OVERRIDES.relations[key] = next;
      }
    }
    // 每次重建这一层：另一个窗口恢复默认后，不能把本窗口上次的静音覆盖留下。
    PHASE_OVERRIDES.sounds = {};
    if (saved.sounds !== null && typeof saved.sounds === "object" && !Array.isArray(saved.sounds)) {
      for (const phase of PHASE_LINE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(saved.sounds, phase) && Array.isArray(saved.sounds[phase])) {
          PHASE_OVERRIDES.sounds[phase] = cleanSoundNotes(saved.sounds[phase]);
        }
      }
    }
    const flags = saved.flags;
    if (flags !== null && typeof flags === "object") {
      for (const key of Object.keys(FLAGS)) {
        if (typeof flags[key] === "boolean") FLAGS[key] = flags[key];
      }
      if (!FLAGS.soundEnabled) stopUploadedSound();
    }
    // 互动反应候选：三组标签数组。
    const interactions = saved.interactions;
    if (interactions !== null && typeof interactions === "object") {
      const next = {};
      for (const [key, list] of Object.entries(interactions)) {
        if (!Array.isArray(list)) continue;
        const clean = list.filter((label) => typeof label === "string" && label !== "");
        if (clean.length > 0) next[key] = clean;
      }
      if (Object.keys(next).length > 0) PHASE_OVERRIDES.interactions = next;
    }
    // 台词覆盖：两层（每条一组 + 相位的单句）。数组要清掉空串，否则 `[""]` 会被
    // 当成"用户改过"，`linesNow()` 就永远拿不到宠物默认了。
    PHASE_OVERRIDES.lines = {};
    const lines = saved.lines;
    if (lines !== null && typeof lines === "object") {
      const next = {};
      for (const [key, value] of Object.entries(lines)) {
        if (key === "phase") {
          const phases = {};
          for (const [phase, text] of Object.entries(value ?? {})) {
            if (typeof text === "string") phases[phase] = text;
          }
          if (Object.keys(phases).length > 0) next.phase = phases;
        } else if (Array.isArray(value)) {
          const clean = value.filter((text) => typeof text === "string" && text !== "");
          if (clean.length > 0) next[key] = clean;
        }
      }
      if (Object.keys(next).length > 0) PHASE_OVERRIDES.lines = next;
    }
  };

  /** 改一处覆盖：写进 store、存档、广播（两个设置界面立刻同步）。 */
  const applyOverride = (patch) => {
    if (patch.phases !== undefined) {
      for (const [phase, entry] of Object.entries(patch.phases)) {
        PHASE_OVERRIDES.phases[phase] = Object.assign({}, PHASE_OVERRIDES.phases[phase], entry);
      }
    }
    if (patch.fidget !== undefined) {
      for (const [slotId, entry] of Object.entries(patch.fidget)) {
        const current = PHASE_OVERRIDES.fidget[slotId] ?? {};
        PHASE_OVERRIDES.fidget[slotId] = {
          none: entry.none === undefined ? current.none : entry.none,
          options: Object.assign({}, current.options, entry.options),
        };
      }
    }
    if (patch.interactions !== undefined) {
      for (const [key, list] of Object.entries(patch.interactions)) {
        PHASE_OVERRIDES.interactions[key] = Array.isArray(list) ? list.slice() : [];
      }
    }
    // 台词是**两层**（每条一组，相位再一层），所以逐层合并 —— 直接 Object.assign 的话
    // 改一句相位台词会把其它相位整片冲掉。
    if (patch.lines !== undefined) {
      const current = PHASE_OVERRIDES.lines ?? {};
      const next = Object.assign({}, current);
      for (const [key, value] of Object.entries(patch.lines)) {
        if (key === "phase") {
          next.phase = Object.assign({}, current.phase, value);
        } else if (Array.isArray(value)) {
          next[key] = value.slice();
        } else if (typeof value === "string") {
          next[key] = value;
        }
      }
      PHASE_OVERRIDES.lines = next;
    }
    if (patch.notify !== undefined && patch.notify !== null && typeof patch.notify === "object") {
      if (["hidden", "unfocused", "always"].includes(patch.notify.currentMode)) PHASE_OVERRIDES.notify.currentMode = patch.notify.currentMode;
      if (["all", "main", "wait"].includes(patch.notify.scope)) PHASE_OVERRIDES.notify.scope = patch.notify.scope;
    }
    saveOverrides();
    notifySettings();
  };

  /**
   * 一个相位的**池子**：`{ <槽位>: 条目表 }`，和摸鱼同一套条目表。
   *
   * 用户的原话是"相位跟摸鱼是一样的功能"：配多个条目、各有权重、到点了在池子里
   * 随机抽。默认值来自 pet.json 的 `looksByPhase`（那本来是"每个槽位一个选择"，
   * 现在读成"每个槽位一条、权重 1"的池子）—— 没定制过的宠物行为一字不变。
   */
  const phasePoolsFor = (phase) => {
    const override = PHASE_OVERRIDES.phases[phase];
    if (override !== undefined && override.pools !== undefined) return override.pools;
    const pools = {};
    for (const [slotId, label] of Object.entries(MANIFEST.current?.looksByPhase?.[phase] ?? {})) {
      pools[slotId] = [{ label, weight: 1 }];
    }
    return pools;
  };

  /** 写入某个相位某个槽位的条目表（增删都走这里）。 */
  const setPhasePool = (phase, slotId, entries) => {
    // 先把当前**全部**池子物化出来再改这一张：只存被改的那张的话，其余槽位会退回
    // pet.json 的默认，用户刚删掉的条目下次刷新就又长回来了。
    const pools = {};
    for (const [id, list] of Object.entries(phasePoolsFor(phase))) pools[id] = list.map((item) => Object.assign({}, item));
    pools[slotId] = entries;
    applyOverride({ phases: { [phase]: { pools } } });
  };

  /**
   * 摸鱼池的**条目表**：一条 = 一个候选（label=null 表示「默认」，即这次不动）。
   *
   * 这是用户可增删的那份数据 —— 界面上每条一行、带 × 可删、底下有 ＋ 可加。
   * 没被覆盖过的槽位用 pet.json 的默认（none + 各选项的 fidgetWeight）。
   */
  const fidgetEntriesFor = (slot) => {
    const override = PHASE_OVERRIDES.fidget[slot.id];
    if (override !== undefined && Array.isArray(override.entries)) return override.entries;
    const out = [{ label: null, weight: typeof slot.fidgetNone === "number" ? slot.fidgetNone : 1 }];
    for (const option of slot.options ?? []) {
      if (option.fidget === false) continue;
      out.push({
        label: option.label,
        weight: typeof option.fidgetWeight === "number" && option.fidgetWeight > 0 ? option.fidgetWeight : 1,
      });
    }
    return out;
  };

  /** 写入某个槽位的条目表（增删都走这里）。 */
  const setFidgetEntries = (slotId, entries) => {
    PHASE_OVERRIDES.fidget[slotId] = { entries };
    saveOverrides();
    notifySettings();
  };

  /**
   * 摸鱼要遍历的槽位：**宠物声明的默认槽位 + 用户自己加过的**。
   *
   * 默认集合来自 `pet.json` 的 `live2d.fidgetSlots`（手、情绪、脸红、嘴、眼睛、自拍），
   * `FIDGET_SLOTS` 只是**没声明时的兜底**。原来是写死的那六个 —— 用户问过"为什么摸鱼
   * 里面不能加槽位和候选"，当时把这两件事都写死在代码里了（界面上只列那六个、运行时也只
   * 认那六个），没有任何理由。声明挪进 pet.json 之后，"默认"也成了宠物自己给的建议。
   */
  const defaultFidgetSlots = (pet) => {
    const declared = pet?.fidgetSlots;
    return Array.isArray(declared) && declared.length > 0 ? declared : FIDGET_SLOTS;
  };
  const fidgetSlotsFor = (pet) => {
    const ids = defaultFidgetSlots(pet).slice();
    for (const id of Object.keys(PHASE_OVERRIDES.fidget)) {
      if (ids.indexOf(id) === -1) ids.push(id);
    }
    return ids
      .map((id) => (pet?.expressionSlots ?? []).find((slot) => slot.id === id))
      .filter((slot) => slot !== undefined && (slot.options ?? []).length > 0);
  };

  /** 把一个槽位加进摸鱼池：先给一张空表（放什么由用户挑）。 */
  const addFidgetSlot = (slotId) => setFidgetEntries(slotId, []);

  /** 把加进来的槽位整个拿掉（默认那六个不给删：它们是宠物自己的身子）。 */
  const removeFidgetSlot = (slotId) => {
    delete PHASE_OVERRIDES.fidget[slotId];
    saveOverrides();
    notifySettings();
  };

  /**
   * 对着当前清单剪一遍存档里的覆盖。
   *
   * 换了宠物、或者 pet.json 改了槽位结构之后（比如氛围从一个大槽拆成三个独立槽、
   * 自拍独立成槽），存档里会留着**已经不存在的槽位/选项**的覆盖。它们不会报错，
   * 只会静默失效 —— 或者更糟：让"关系指向一个不存在的槽位"，配对就再也点不亮了。
   * 每次加载对一遍，剪完写回。
   */
  const pruneOverrides = (pet) => {
    const slotById = new Map((pet?.expressionSlots ?? []).map((slot) => [slot.id, slot]));
    let touched = false;
    for (const slotId of Object.keys(PHASE_OVERRIDES.fidget)) {
      if (!slotById.has(slotId)) {
        delete PHASE_OVERRIDES.fidget[slotId];
        touched = true;
      }
    }
    for (const key of Object.keys(PHASE_OVERRIDES.relations)) {
      const at = key.indexOf(":");
      const slotId = at < 0 ? key : key.slice(0, at);
      const label = at < 0 ? "" : key.slice(at + 1);
      const known = (slotById.get(slotId)?.options ?? []).some((option) => option.label === label);
      if (!known) {
        delete PHASE_OVERRIDES.relations[key];
        touched = true;
      }
    }
    for (const entry of Object.values(PHASE_OVERRIDES.phases)) {
      const pools = entry?.pools;
      if (pools === undefined) continue;
      for (const slotId of Object.keys(pools)) {
        if (slotById.has(slotId)) continue;
        delete pools[slotId];
        touched = true;
      }
    }
    if (touched) saveOverrides();
  };

  /** 把一个槽位从某个相位的池子里拿掉。 */
  const removePhasePool = (phase, slotId) => {
    const pools = {};
    for (const [id, list] of Object.entries(phasePoolsFor(phase))) {
      if (id !== slotId) pools[id] = list.map((item) => Object.assign({}, item));
    }
    applyOverride({ phases: { [phase]: { pools } } });
  };

  /** 删掉某个相位的覆盖（＝那一行从列表里消失，回到内置行为）。 */
  const removePhaseRow = (phase) => {
    delete PHASE_OVERRIDES.phases[phase];
    saveOverrides();
    notifySettings();
  };

  /** 旧接口：界面上已改成条目表，这两个只在默认值推导里还用得到。 */
  const fidgetNoneFor = (slot) => {
    const override = PHASE_OVERRIDES.fidget[slot.id];
    if (override !== undefined && typeof override.none === "number") return override.none;
    return typeof slot.fidgetNone === "number" ? slot.fidgetNone : 1;
  };
  const fidgetWeightFor = (slot, option) => {
    const override = PHASE_OVERRIDES.fidget[slot.id];
    const fromUser = override?.options?.[option.label];
    if (typeof fromUser === "number") return fromUser;
    return typeof option.fidgetWeight === "number" && option.fidgetWeight > 0 ? option.fidgetWeight : 1;
  };

  const settingsListeners = new Set();
  const notifySettings = () => {
    for (const listener of Array.from(settingsListeners)) {
      try {
        listener();
      } catch {
        /* 某个界面挂了不该带走另一个 */
      }
    }
  };

  /** 订阅设置变化；返回当前版本号（用来驱动重渲染）。 */
  const useSettings = () => {
    const [rev, setRev] = useState(0);
    useEffect(() => {
      const listener = () => setRev((n) => n + 1);
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    }, []);
    return rev;
  };

  /**
   * 改一项可调参数：写进 TUNING（控制器下一帧就按新值走）、存档、广播。
   *
   * 直接改 TUNING 而不是走 React 状态是刻意的：控制器每帧读它，几百毫秒的
   * 状态传播延迟会让滑杆手感很黏。
   */
  const applyTuning = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const field = TUNING_FIELDS.find((entry) => entry.key === key);
      TUNING[key] = field === undefined ? value : clampSetting(field, value);
    }
    if (playingUploaded !== null) {
      if (!(TUNING.soundVolume > 0)) stopUploadedSound();
      else playingUploaded.volume = TUNING.soundVolume;
    }
    // 动的是音量就顺手试听一小段 —— 否则"这个音量到底多大声"只能等下一次相位切换才知道。
    if (Object.prototype.hasOwnProperty.call(patch, "soundVolume")) scheduleVolumePreview();
    // 走共享落点：有宿主就写宿主（DSH 与桌面端两个窗口都能看见），本地留一份兜底。
    persistShared({ tuning: Object.assign({}, TUNING) });
    notifySettings();
  };

  /**
   * 启动时把存档里的可调项读回来（每个值都按区间夹一遍）。
   *
   * 手改坏了存档最多回到合法范围，不会出现「死区 5」这种把宠物冻住的配置。
   */
  const restoreTuning = (given) => {
    let saved = given === undefined ? null : given;
    if (saved === undefined || saved === null) {
      try {
        saved = JSON.parse(storage.getItem(TUNING_KEY) ?? "null");
      } catch {
        saved = null;
      }
    }
    if (saved === null || typeof saved !== "object") return;
    let restored = false;
    for (const field of TUNING_FIELDS) {
      const value = saved[field.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      TUNING[field.key] = clampSetting(field, value);
      restored = true;
    }
    if (playingUploaded !== null) {
      if (!(TUNING.soundVolume > 0)) stopUploadedSound();
      else playingUploaded.volume = TUNING.soundVolume;
    }
    if (restored) notifySettings();
  };

  /**
   * 「手感」那一节：滑杆直接写 TUNING。
   *
   * 抽成独立组件是因为它要在**两个地方**渲染：DSH 设置页和宠物右键面板。
   */
  /** 滑杆「已经拖过去」的那一段有多长（0–100），喂给样式表里的 `--fill`。
   *  取整到一位小数：不然 DOM 里留着 `83.33333333333334%` 这种尾巴，
   *  断言和肉眼看到的数字都对不上。 */
  const fillOf = (value, min, max) => {
    const span = max - min;
    if (!(span > 0)) return 0;
    const pct = ((value - min) / span) * 100;
    return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
  };

  function TuningControls(props) {
    useSettings();
    const only = props?.group;
    // 也能按**具体键**挑几根滑杆（官方插件页那一节只放最常用的四项，
    // 不想把八根手感滑杆整套搬过去）。给了 keys 就按 keys 过滤，忽略 group。
    const keys = Array.isArray(props?.keys) ? props.keys : null;
    const fields = TUNING_FIELDS.filter((field) => keys === null
      ? (only === undefined || tuningGroupOf(field) === only)
      : keys.includes(field.key));
    return h("div", { "data-settings": "", "data-setting": only ?? (keys === null ? "all" : "subset") },
      fields.map((field) => h("label", {
        key: field.key,
        "data-field": field.key,
      },
      h("span", { "data-row-label": "" }, field.label),
      h("input", {
        type: "range",
        min: field.min,
        max: field.max,
        step: field.step,
        value: TUNING[field.key],
        "data-input": field.key,
        // 只带一个**值**（填充比例），外观全在样式表里 —— 这不违反"布局别写行内"。
        style: { "--fill": fillOf(TUNING[field.key], field.min, field.max) + "%" },
        onChange: (event) => applyTuning({ [field.key]: Number(event.target.value) }),
      }),
      h("code", { "data-value": field.key }, String(TUNING[field.key])),
      )),
      // 恢复默认单独一行：它是"这一组"的动作，混在滑杆行里会看着像又一个控件。
      // 只挑了四项时按钮说"全部" —— 它恢复的确实是整份 TUNING，不含糊。
      only === undefined || only === "feel"
        ? h("div", { "data-add-row": "" },
          h("button", {
            type: "button",
            "data-reset": "tuning",
            onClick: () => applyTuning(Object.assign({}, TUNING_DEFAULTS)),
          }, keys === null ? t("恢复默认") : t("全部恢复默认")))
        : null,
    );
  }

  /**
   * 拖动阈值：按下后移动超过这么多像素才算拖动，否则算点击。
   *
   * 注意它必须留在模块作用域 —— 曾经被一次组件替换顺手删掉，只剩下引用，
   * 于是每次 pointermove 都在 slop 判断那行抛 ReferenceError，
   * 表现是「按下去有反应（data-dragging 出现）但宠物纹丝不动」，
   * 而页面的 __errors 里一直躺着 "DRAG_SLOP_PX is not defined"。
   */
  const DRAG_SLOP_PX = 4;

  /**
   * 「装扮」那一节：现在只有一个开关（跨启动记住那六件）。
   *
   * 关掉时顺带把已存的清掉 —— 否则「关掉」只是不读，存档还留在那儿，
   * 下次开开关会突然穿回一套很旧的搭配。
   */
  function OutfitControls() {
    useSettings();
    return h("div", { "data-settings": "", "data-setting": "outfit" },
      h("label", { "data-flag-row": "outfitArchive" },
        h("input", {
          type: "checkbox",
          checked: FLAGS.outfitArchive === true,
          "data-flag": "outfitArchive",
          onChange: (event) => applyFlag("outfitArchive", event.target.checked),
        }),
        h("span", { "data-row-label": "" }, t("跨启动记住装扮")),
      ),
      h("div", { "data-note": "" },
        t("眼镜 / 发饰 / 魔爪 / 巴菲 / 桌布 / 手机换色 —— "),
        FLAGS.outfitArchive ? t("关掉会同时清掉已存的那套。") : t("已关闭，也不再记录。")),
    );
  }
  /** Quiet time before the first idle fidget, and the randomised gap after. */
  // 摸鱼节奏现在是可调的：默认值留在 TUNING（设置页能改），这两行只作说明。
  const IDLE_FIDGET_MIN_MS = 12000;
  const IDLE_FIDGET_MAX_MS = 26000;

  /**
   * Which slots the idle fidget may draw from (requirement #4).
   *
   * Hands, mood, blush and mouth — the pet's own body and face. Deliberately
   * NOT the outfit slots: a random 摸鱼 that swapped her glasses or put a whale
   * on her head would undo a choice the user made on purpose.
   */
  /**
   * Fraction of the half-width/height around the centre that is ignored.
   *
   * Without it the eyes twitch on every pixel of hand tremor; with it the gaze
   * only starts moving once the pointer has genuinely left the middle.
   */


  /** The model's mouth-opening parameter. */
  const MOUTH_OPEN_PARAM = "ParamMouthOpenY";

  /**
   * The mouth's SHAPE parameter (range -2..1 on this model).
   *
   * This is what decides whether an open mouth reads as a natural "ah" or as a
   * gasp. Read off the author's own 拍照 action: selfie.motion3.json takes
   * ParamMouthOpenY from 0 to 1 while taking ParamMouthForm UP to +0.7..+1.
   *
   * I first drove it NEGATIVE on the theory that it dropped the jaw. Zooming in
   * on the rendered mouth showed the opposite: -1 slants the opening into a
   * smirk, 0 gives a clean oval, +0.7..+1 gives the wide natural opening the
   * author uses. Matching the author beats my guess.
   */
  const MOUTH_FORM_PARAM = "ParamMouthForm";

  /** How far POSITIVE the form is driven at full mouth opening. */


  /**
   * Time constant for the mouth easing, in milliseconds.
   *
   * The gaze is already smooth because the engine lerps its focus controller,
   * but the mouth was written straight from the pointer event, so moving in or
   * out of range snapped it open and shut. ~170ms reads as a reaction rather
   * than a cut.
   */


  /**
   * Blinking, driven by US rather than by the engine.
   *
   * The engine's own eye blink is gated behind "no motion drove parameters this
   * frame":
   *
   *     const motionUpdated = this.updateMotions(coreModel, now)
   *     ... motionUpdated || this.eyeBlink?.updateParameters?.(coreModel, dt)
   *
   * Every motion in this model declares Loop:true, and the controller keeps the
   * idle loop running more or less continuously, so `motionUpdated` is true on
   * essentially every frame — which means the engine's blink NEVER ran and the
   * pet simply never blinked.
   *
   * So the engine's blink is switched off at load (options.eyeBlink = false) and
   * reproduced here, at the same per-frame seam as everything else, where no
   * engine gate can suppress it.
   */
  const EYE_L_PARAM = "ParamEyeLOpen";
  const EYE_R_PARAM = "ParamEyeROpen";
  /** Gap between blinks: a random interval in this range. */


  /** Closing, shut, and opening durations. */
  const BLINK_CLOSE_MS = 70;
  const BLINK_HOLD_MS = 45;
  const BLINK_OPEN_MS = 110;

  /**
   * How much of the model's mouth range a fully-deflected pointer uses.
   *
   * Deliberately not 1: the mouth should read as following the cursor, not as
   * being permanently wide open whenever the pointer leaves the middle.
   */


  const FIDGET_SLOTS = ["rhand", "lhand", "mood", "cheek", "mouth", "eyes"];


  /**
   * 三个互动**内置的**反应候选（用户覆盖 <- 宠物声明 <- 这里）。
   *
   * 这三组原来只在 pet.json 里声明，代码侧没有任何默认值（`HEAD_PAT_REACTIONS`
   * 是上一版实现留下的死常量，谁都没读它）—— 于是**没声明这三组的宠物，互动看着
   * 是好的、其实什么都不演**：摸头/摸尾巴只有台词，转圈连台词都不弹。而这恰恰是
   * 「做一只自己的宠物」最常见的状态（最小 pet.json 里根本没有这几个键）。
   *
   * 标签按同一个顺序解读：先当**动作组的中文名**找（catalog.json 里作者起的名），
   * 找不到就当**表达式**闪一下。所以这里写的是用户看得懂的名字，不是 group / file id。
   */
  const DEFAULT_REACTIONS = {
    /** 摸头：随机一个，并且**故意不脸红** —— 脸红是以前每次摸头都加的东西，让每一下都一样。 */
    patReactions: ["重锤出击", "问号", "星星眼"],
    /** 摸尾巴：吐魂是表情，问号是符号表情。 */
    tailReactions: ["吐魂", "问号"],
    /** 转圈转晕：演「晕晕」。 */
    spinReactions: ["晕晕"],
  };

  /**
   * 某些反应开演前要**先清掉**的槽位（标签 → 槽位 id → 该让位的选项名单；空数组 = 全清）。
   *
   * 用户报的：「重锤出击动作应该判断一下当前眼部是不是 晕晕/呆呆眼，情绪是不是
   * 开心兴奋/闭眼口水，如果是应该先把眼部或情绪还原为默认」。
   *
   * 理由：`Hammer` 只写手臂参数，脸它一概不管。于是眼部停在「晕晕」、情绪停在「闭眼口水」
   * 时挥锤，画面上是"一个晕乎乎、闭着眼流口水的人在奋力挥锤"——动作与表情自相矛盾。
   * 只清**列出来的**那几个选项：用户选的其它眼睛（星星眼之类）不该被这一锤抹掉。
   *
   * 用户可配（设置里那份覆盖）：`PHASE_OVERRIDES.interactions.clearSlots`。
   */
  const DEFAULT_REACTION_CLEARS = {
    重锤出击: { eyes: ["晕晕", "呆呆眼"], mood: ["开心兴奋", "闭眼口水"] },
  };

  /**
   * 反应留下的槽位改动**多久之后收回默认**（用户要求"过一段事件（时间）应该还原为默认"）。
   *
   * 12 秒与手动点的表情同一个上限（`EXPRESSION_HOLD_MS`）—— 都属"临时效果"，
   * 两套时长不一致会让用户觉得其中一个是坏的。
   */
  const REACTION_REVERT_MS = 12000;

  /** 一组反应候选的来历（诊断用，见 reactionSource）。 */
  const REACTION_KEYS = Object.keys(DEFAULT_REACTIONS);

  /** 洗一遍候选：只留非空字符串（那份清单可能来自 localStorage，不可信）。 */
  const cleanReactionList = (list) =>
    (Array.isArray(list) ? list : []).filter((name) => typeof name === "string" && name !== "");

  /**
   * 互动的反应候选：**用户覆盖 <- 宠物声明 <- 内置默认**。
   *
   * 条目是**标签**（「重锤出击」「星星眼」这种）：先当动作组找（宠物会给动作起中文名），
   * 找不到就当表达式名。这样设置界面里可以拿宠物自己的清单当候选，用户不用记 id。
   *
   * 这里的兜底顺序和台词（`linesNow`）、摸鱼池（`fidgetEntriesFor`）是同一套：
   * 用户没改过就用宠物声明的，宠物没声明就用内置的 —— **任何一层为空都不能变成
   * "这个互动没反应"**。
   */
  const interactionReactions = (key) => {
    const mine = cleanReactionList(PHASE_OVERRIDES.interactions?.[key]);
    if (mine.length > 0) return mine;
    const declared = cleanReactionList(MANIFEST.current?.[key]);
    if (declared.length > 0) return declared;
    return cleanReactionList(DEFAULT_REACTIONS[key]);
  };

  /**
   * 这一组候选是从哪一层来的（"没反应"这类问题要一眼看出是哪一层空了）。
   *
   * 诊断读口，不参与行为：`user` / `pet` / `builtin` / `none`。
   */
  const reactionSource = (key) => {
    if (cleanReactionList(PHASE_OVERRIDES.interactions?.[key]).length > 0) return "user";
    if (cleanReactionList(MANIFEST.current?.[key]).length > 0) return "pet";
    if (cleanReactionList(DEFAULT_REACTIONS[key]).length > 0) return "builtin";
    return "none";
  };

  /** 跑一条反应（由点击/转圈触发）。 */
  const runReactionRef = { current: () => false };

  /**
   * 转圈检测的读数（诊断用）。
   *
   * "绕着转圈没反应"这类问题必须能分辨**三种**可能：事件没来（moves 不动）、
   * 累计不够（total 不涨）、还是触发了但被别的东西盖住（fires 涨了却没效果）。
   * 只看最后那个"弹没弹台词"是分不出来的。
   */
  const spinStatsRef = { current: { moves: 0, total: 0, fires: 0 } };

  /**
   * How long a session phase keeps replaying its motion.
   *
   * "持续播放" — a phase is a STATE, not an event, so a one-shot animation that
   * drops back to the idle loop the moment it ends reads as "ignored". While a
   * phase is live the controller re-triggers its motion, so the pet visibly
   * stays busy for as long as the assistant is.
   */
  const PHASE_SUSTAIN_GAP_MS = 200;

  /**
   * Upper bound on how long any single action may hold the body.
   *
   * Requirement #3: everything must eventually fall back to the initial idle
   * state. Without this, a motion declared `hold: true` (掏出手机 keeps the
   * phone up) would park the pet in that pose forever, and a pinned expression
   * would stay on the face until manually cleared.
   */
  const ACTION_HOLD_MAX_MS = 9000;

  /** How long a manually pinned expression stays before auto-clearing. */
  const EXPRESSION_HOLD_MS = 12000;

  /**
   * 表情淡入/淡出时长（ms）。
   *
   * 引擎自己的表情管理器带 ~1s 的交叉淡入，但这里**没有用它** —— 它一次只持有
   * 一个表达式，多槽位叠加会只剩最后一个，所以参数是我们自己按帧写的，而自己写
   * 是**瞬时**的。用户反馈的"表情没有淡入"就是这个。
   *
   * 200ms 足够软，又不会让断言在太长时间里读到半途的值。
   */
  const EXPRESSION_FADE_MS = 200;

  /**
   * Motions that must never be picked as an idle "摸鱼" animation.
   *
   * These are the user's own interaction verbs: 重锤出击 is what a tap does and
   * 鲸鱼喷水 is what a failure does. Letting the random fidget pick them makes
   * the pet appear to react to a click or an error that never happened, which
   * is exactly the confusion reported as "摸鱼动画里也会重锤出击".
   *
   * A pet may extend this through motionOptions: { "<group>": { "fidget": false } }.
   */
  const FIDGET_DENY = ["Hammer", "SprayWater"];

  /**
   * Drawable-name hints that identify the FACE, used to locate the head.
   *
   * 重锤出击 is the "pat the head" reaction, so it must only fire when the click
   * actually lands on the head — tapping the desk or the body answered with a
   * hammer swing (requirement #1).
   *
   * The model declares no Cubism HitAreas, so the head is derived from its own
   * drawable geometry instead of a guessed percentage: any drawable whose id
   * looks like a facial feature is unioned, and the box is grown to cover the
   * hair and headband sitting above it. That keeps the region correct when the
   * pet is resized or dragged, because it is measured in MODEL space and mapped
   * through the live transform at click time.
   */
  const HEAD_DRAWABLE_HINTS = /(face|eye|mouth|nose|brow|cheek|head|kao)/i;

  /** How far the face box grows to become the whole head, as a fraction of it. */
  const HEAD_PAD_SIDE = 0.55;
  const HEAD_PAD_TOP = 0.85;
  const HEAD_PAD_BOTTOM = 0.10;

  /**
   * Session phase -> motion group (#4).
   *
   * A pet may override any slot through its manifest's `live2d.motions`, which
   * uses these same phase keys; anything unmapped simply stays on the idle
   * loop, so a model without a suitable group degrades quietly.
   */
  const PHASE_MOTION = {
    thinking: "Idle",
    waiting: "Idle",
    // NOT Ketchup: that motion drives 蛋包饭 and 挤压 as well as the squeeze, so
    // it painted omurice and ketchup during every tool call. The tool phase is
    // carried by the 写本本 sweep instead.
    tool: "Idle",
    done: "BubbleGum",
    failed: "SprayWater",
  };

  /**
   * Which session phases replay their motion for as long as they last.
   *
   * Only phases that map to a DISTINCTIVE motion are sustained — repeating the
   * idle loop every few seconds would just look twitchy. 'thinking' and
   * 'waiting' both rest on the idle loop, which already reads as "alive but
   * not doing anything", so they are left alone; 'tool' (busy hands), 'done'
   * (a small celebration) and 'failed' (the whale sprays) each have a real
   * animation to keep running.
   */
  const PHASE_SUSTAIN = ["tool", "done", "failed"];

  /**
   * Session phase -> expression, layered like a manual expression pin.
   *
   * Names are matched against the model's declared Expression `Name`, not its
   * file name: this pack's 哭.exp3.json is declared as "大哭", so the obvious
   * "哭" never resolves and the failed phase silently pinned nothing.
   */
  /**
   * Built-in phase -> single expression. Empty on purpose: a phase now drives a
   * whole LOOK (looksByPhase), and the old defaults fought it — 呆呆眼 for
   * thinking survived the merge and stayed on screen through every session.
   * Pets without looksByPhase simply get no phase expression.
   */
  const PHASE_EXPRESSION = {};

  /**
   * How many device pixels the canvas backing store gets per CSS pixel.
   *
   * This is the single biggest lever on how the pet looks when it is SHRUNK.
   * The stage is only 160-760 CSS px but the model's atlas is 2048², so at a
   * 300px pet every screen pixel is fed by ~7 texture texels — and whatever
   * the sampler does, the renderer only ever produces 300² samples. Thin line
   * art therefore lands between sample points and washes out ("线条很虚").
   *
   * Rendering at 2x and letting the browser filter the canvas down to its CSS
   * size is plain super-sampling: 4 render samples per displayed pixel instead
   * of 1. That is what actually brings the outlines back at small sizes, and
   * it costs nothing extra at the sizes this pet uses (2x of 300px is 600²,
   * about a third of a megapixel).
   *
   * A HiDPI screen already renders at 2x, so this only raises the floor; the
   * ceiling stops a 3x display from quadrupling the memory for no gain.
   */
  const RENDER_RESOLUTION_MIN = 2;
  const RENDER_RESOLUTION_MAX = 3;

  /**
   * Anisotropic filtering level for the model's textures.
   *
   * The engine keeps the LOD trim/filter knobs but never applies the sampler
   * anisotropy from `textureOptions`, so it is set on each texture's style
   * after load. 8x is ample for line art and costs nothing measurable at the
   * sizes this pet uses.
   */
  const TEXTURE_ANISOTROPY = 8;

  function renderResolution() {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    return Math.min(RENDER_RESOLUTION_MAX, Math.max(RENDER_RESOLUTION_MIN, dpr));
  }

  /** Resolution of the opacity grid derived from the rendered character. */
  const HIT_MASK_SIZE = 64;

  /** Alpha above which a sampled pixel counts as part of the character. */
  const HIT_MASK_ALPHA = 24;

  /**
   * 贴图上**真正属于尾巴**的那一块（归一化 UV）。
   *
   * 为什么这是一个常量而不是"名字里带尾/翅的部件"：这只宠物有 **16 块** drawable 命中
   * `尾|鳍|翅|翼`，但其中 **11 块是可换配件**（狐狸尾 / 猫尾 / 狼尾 / 天使翅膀 /
   * 恶魔翅膀…），几何**一直留在原地**、横跨从头顶到腰腹的整个角色。把它们全算成尾巴，
   * 结果是"算尾巴"的格子占角色 **22%**，其中 **86.6% 同时算头** —— 而路由是摸头优先，
   * 于是用户点在**可见的尾鳍**上拿到的是摸头反应（用户报的"摸尾巴很难点到"）。
   *
   * 依据是**贴图**（作者自己画的）：`texture_00.png` 2048² 上，鲸鱼尾鳍只占
   * `x 3..444, y 953..1397` 这一块，对应下面这个归一化区域。实测落在这里的正好是
   * `ArtMesh38 / 56 / 58 / 59 / 60` 五块，全部属于部件 `尾巴(蒙皮)`；其余 11 块各自
   * 落在贴图别处（`ArtMesh75` 落在 600,1592 → 1069,2045 那片大翅膀上）。
   *
   * UV 读不到时（别的引擎版本、没有 `vertexUvs` 表）**不做任何收窄** —— 退回旧行为，
   * 不能让"判定变得精确"变成"判定整个失效"。
   */
  const TAIL_FIN_UV = { minU: 0, minV: 0.45, maxU: 0.23, maxV: 0.72 };

  /** 一块 drawable 的 UV 包围盒整体落在这个区域里吗（留一点边距）。 */
  function uvInsideTailFin(uv) {
    if (uv === null) return null;
    const pad = 0.02;
    return uv.minU >= TAIL_FIN_UV.minU - pad && uv.maxU <= TAIL_FIN_UV.maxU + pad
      && uv.minV >= TAIL_FIN_UV.minV - pad && uv.maxV <= TAIL_FIN_UV.maxV + pad;
  }

  /**
   * 尾鳍实时包围盒的采样间隔（ms）。
   *
   * 100ms ≈ 6 帧一次：摆动一个来回大约 30 帧，所以盒子永远落后不超过摆动幅度的几分之一，
   * 而每帧读几十个顶点是白烧 CPU。采样点在 `saveParameters` 缝里（这一帧真正要画的姿势）。
   */
  const TAIL_BOX_SAMPLE_MS = 100;

  /**
   * Build a coarse opacity grid of the character as actually rendered.
   *
   * Cubism hit areas cannot be used here: this model declares none (and the
   * engine's hitTest leans on the physics hit-testing that only exists when a
   * model ships them), so a click anywhere in the canvas' transparent margin
   * would otherwise register. Extracting the model itself gives the true
   * silhouette for any model, with or without hit areas.
   *
   * Returns null when extraction is unavailable, in which case callers fall
   * back to accepting the whole box.
   */
  async function buildHitMask(app, model) {
    try {
      const source = app?.canvas;
      if (source === undefined || source === null || source.width === 0) return null;
      // The model is drawn inside the stage box; sample exactly its bounds so
      // the 64x64 grid maps onto the character, not onto empty margins.
      let bounds;
      try {
        bounds = model.getBounds();
      } catch {
        bounds = undefined;
      }
      const sourceW = source.width;
      const sourceH = source.height;
      const rect = bounds === undefined || bounds.width === 0 || bounds.height === 0
        ? { x: 0, y: 0, width: sourceW, height: sourceH }
        : bounds;
      // Model bounds are in logical stage px; the drawing buffer is scaled by
      // the renderer resolution, so convert before cropping.
      const ratio = sourceW / Math.max(1, app.renderer.width || sourceW);
      const sx = Math.max(0, Math.floor(rect.x * ratio));
      const sy = Math.max(0, Math.floor(rect.y * ratio));
      const sw = Math.min(sourceW - sx, Math.ceil(rect.width * ratio));
      const sh = Math.min(sourceH - sy, Math.ceil(rect.height * ratio));
      if (sw <= 0 || sh <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = HIT_MASK_SIZE;
      canvas.height = HIT_MASK_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) return null;
      // The grid spans exactly the model's bounding box, and hitsMask() maps a
      // stage-local point through the same box, so no aspect math is needed.
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, HIT_MASK_SIZE, HIT_MASK_SIZE);
      const pixels = ctx.getImageData(0, 0, HIT_MASK_SIZE, HIT_MASK_SIZE).data;
      const data = new Uint8Array(HIT_MASK_SIZE * HIT_MASK_SIZE);
      let opaque = 0;
      for (let i = 0; i < data.length; i += 1) {
        if (pixels[i * 4 + 3] > HIT_MASK_ALPHA) {
          data[i] = 1;
          opaque += 1;
        }
      }
      // A mask with almost nothing in it is useless (extraction produced a
      // blank frame); treat it as "no mask" rather than making the pet inert.
      if (opaque < data.length * 0.01) return null;
      // Convert the cropped device-pixel box back into stage-local units.
      const box = {
        x: sx / ratio,
        y: sy / ratio,
        width: sw / ratio,
        height: sh / ratio,
      };
      return { width: HIT_MASK_SIZE, height: HIT_MASK_SIZE, data, box };
    } catch {
      return null;
    }
  }

  /**
   * Build the hit mask once the model has actually painted.
   *
   * Reading the drawing buffer immediately after boot yields an empty frame —
   * the first draw has not been composited yet — so this waits a few animation
   * frames and retries until the silhouette has pixels, then gives up quietly
   * (leaving the whole box clickable, which is the safe fallback).
   */
  async function buildHitMaskWhenPainted(app, model, isDisposed) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (isDisposed()) return null;
      // eslint-disable-next-line no-await-in-loop -- retries are inherently serial
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      // eslint-disable-next-line no-await-in-loop -- retries are inherently serial
      const mask = await buildHitMask(app, model);
      if (mask !== null) return mask;
    }
    return null;
  }

  /**
   * Relax the gaze to the model's default resting position — the centre of the
   * stage. Published through a ref because it is needed from the gaze effect,
   * the layout pass and the drag handler, which live in different scopes.
   */
  const focusDefaultRef = { current: () => {} };
  function focusDefault() {
    focusDefaultRef.current();
  }

  /**
   * Observability: which target the gaze is currently tracking. Published on
   * the pet root as `data-gaze` ('center' while resting, 'pointer' while the
   * cursor steers it) so the resting behaviour is directly assertable.
   */
  const gazeSinkRef = { current: () => {} };
  function reportGaze(target) {
    gazeSinkRef.current(target);
  }

  /**
   * 宿主现在是浅色还是深色。
   *
   * 基准取**左侧边栏**的 `backgroundColor`（项目规则：主题色一律以它为准），
   * 取不到就往外套一层（[data-pane] → body → html），全透明也算取不到。
   * 用亮度判深浅：0.299R + 0.587G + 0.114B，中值 0.5 是分界。
   *
   * 都取不到时按**浅色**处理 —— DSH 默认是浅色，猜深色会让浅色主题下先闪一下深色面板。
   */
  const readHostTheme = () => {
    for (const selector of ['[data-pane="sidebar"]', "[data-pane]", "body", "html"]) {
      const el = document.querySelector(selector);
      if (el === null) continue;
      let bg = "";
      try {
        bg = getComputedStyle(el).backgroundColor;
      } catch {
        continue;
      }
      const parts = /rgba?\(([^)]+)\)/.exec(bg);
      if (parts === null) continue;
      const nums = parts[1].split(",").map((n) => Number(n.trim()));
      const [r, g, b] = nums;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      if (nums.length > 3 && nums[3] === 0) continue; // 全透明：换个元素再看
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? "dark" : "light";
    }
    return "light";
  };

  function Pet() {
    const stageRef = useRef(null);
    /** 模型未缩放宽高（加载后写入），用来算"可见内容"的透明内边距。 */
    const modelSourceRef = useRef(null);
    const appRef = useRef(null);
    const modelRef = useRef(null);
    const rootRef = useRef(null);
    const sizeRef = useRef(null);
    const posRef = useRef(null);
    const bubbleTimer = useRef(0);
    const greeted = useRef(false);
    // One controller per mounted pet: it owns the entire motion lifecycle, so
    // no component callback ever calls model.motion() directly.
    const motion = useRef(null);
    if (motion.current === null) motion.current = createMotionController();
    // Diagnostic seam: the controller is published on window so the clickable
    // region and internal state can be characterised from a test harness
    // without reaching through React internals.
    if (typeof window !== "undefined") window.__dshLive2dPet = motion.current;
    const pinnedRef = useRef({});
    /**
     * 「声明层」：这一轮**要求**点亮哪些表达式（用户 + 相位 + 配对补齐），互斥之前的那份。
     *
     * ⚠️ 必须在 `pinnedRef` 旁边声明（早期诊断读口在组件头部就挂上了，引用到下面
     * `const` 会撞加载期 TDZ）。
     *
     * 与 `pinnedRef` 的分工是这条修复的全部要点：
     *   * `declaredPinsRef` —— **输入**。面板点选/相位切换都在这份上增删，对手留在里面；
     *   * `pinnedRef` —— **输出**。互斥裁剪之后真正写进模型的那份。
     * 只留输出的话，被顶掉的那条就永久消失了（相位脸在用户手点、又收回默认之后再也
     * 不回来）。声明层在，冲突解除时它自己就恢复。
     */
    const declaredPinsRef = useRef({});

    // Two diagnostics have to be attached from HERE, not from inside the
    // controller: they read refs that live in this component's scope, and a
    // controller-scoped copy throws ReferenceError on every call, which shows
    // up as a silent `undefined` rather than as an error.
    useEffect(() => {
      const api = motion.current;
      api.slotSelections = () => slotSelectionsRef.current;
      api.fidgetNow = () => fidgetRef.current();
      // Same reason as the two above: fidgetTally lives in this component's
      // scope, and a controller-scoped copy throws ReferenceError on every call
      // — which surfaces as a silent `undefined`, not as an error.
      api.fidgetReady = () => fidgetLiveRef.current;
      // Drivers that assert "this state stays put" call setFidgetEnabled(false)
      // first; otherwise a 摸鱼 can rewrite the state mid-assertion.
      api.setFidgetEnabled = (on) => { fidgetEnabledRef.current = on !== false; };
      api.fidgetEnabled = () => fidgetEnabledRef.current;
      api.fidgetTally = () => fidgetTallyRef.current;
      api.resetFidgetTally = () => { fidgetTallyRef.current.picked = {}; fidgetTallyRef.current.drawn = {}; };
      // 相位池和摸鱼池是同一套抽签，所以诊断也照抄摸鱼的形状：`phaseNow` 立刻重抽
      // 一次（不用等真的相位切换），`phaseTally` 给出每个相位各抽中了什么。
      // 没有这两个的话，"池子里是随机的"就只能靠反复推 SSE 再数，慢且会抖。
      /**
       * 诊断：直接应用一个相位（测试用）。
       *
       * **连状态一起设**，跟真实 SSE 路径一致：只调 applyPhase 的话 `data-phase` 还是
       * 旧值、React 也不会重渲染 —— 面板跟着相位走这件事就测不出来（而且测出来的行为
       * 跟真实路径不一样）。
       */
      api.phaseNow = (phase) => {
        if (typeof phase !== "string") return;
        setPhaseState(phase);
        flushPhaseRef.current?.(phase);
      };
      api.phaseTally = () => phaseTallyRef.current;
      api.resetPhaseTally = () => { phaseTallyRef.current = {}; };
      // 诊断：**有效关系**（pet.json + 用户覆盖合并后的结果）与存档里的覆盖。
      // "配对点不亮"这类问题先看这两个 —— 如果覆盖里出现 `pairs: {}`（那条关系被
      // 删过），那就不是代码的问题，是存档；剪枝只会删掉**不存在**的槽位/选项。
      api.effectiveRelations = () => {
        const out = {};
        for (const slot of MANIFEST.current?.expressionSlots ?? []) {
          for (const option of slot.options ?? []) {
            const { pairs, requires } = relationsOf(slot.id, option.label);
            if (Object.keys(pairs).length > 0 || requires.length > 0) {
              out[slot.id + ":" + option.label] = { pairs, requires };
            }
          }
        }
        return out;
      };
      api.settingsOverrides = () => ({
        fidgetSlots: Object.keys(PHASE_OVERRIDES.fidget),
        relationKeys: Object.keys(PHASE_OVERRIDES.relations),
        phases: Object.keys(PHASE_OVERRIDES.phases),
        interactions: Object.keys(PHASE_OVERRIDES.interactions ?? {}),
        lines: Object.keys(PHASE_OVERRIDES.lines ?? {}),
        linePhases: Object.keys(PHASE_OVERRIDES.lines?.phase ?? {}),
        flags: Object.assign({}, FLAGS),
      });
      // 台词的**有效值**（宠物默认 + 用户覆盖）—— "改文本"这类断言要能直接读到结果，
      // 而不是去 DOM 里抠 input.value（那是"界面显示了什么"，不是"她真的会说什么"）。
      api.effectiveLines = () => linesNow();
      /** 诊断：宠物文案当前解析到的语言（"zh" / "en"）。 */
      api.locale = () => PET_LOCALE;
      /** 某个互动的**有效**反应候选（同样是与宠物默认合并后的结果）。 */
      api.effectiveReactions = (key) => interactionReactions(key);
      /**
       * 诊断：三组候选各自的**来历**（user / pet / builtin / none）与内置默认值。
       *
       * "点了她没反应"要先分清是哪一层空了：用户覆盖成了空数组、宠物没声明、
       * 还是连内置默认都没有。只看 `effectiveReactions()` 是分不出来的。
       */
      api.reactionDiagnostics = () => ({
        source: Object.fromEntries(REACTION_KEYS.map((key) => [key, reactionSource(key)])),
        builtin: Object.fromEntries(REACTION_KEYS.map((key) => [key, DEFAULT_REACTIONS[key].slice()])),
        effective: Object.fromEntries(REACTION_KEYS.map((key) => [key, interactionReactions(key)])),
      });
      /** 台词的字段清单（测试用它确认"每一个字段都有输入框"）。 */
      api.lineFields = () => ({
        plain: LINE_FIELDS.map((field) => field.key),
        phase: PHASE_LINE_FIELDS.map((field) => field.key),
      });
      /** 转圈检测的读数：moves（事件到没到）/ total（累计角）/ fires（触发了几次）。 */
      api.spinDebug = () => Object.assign({}, spinStatsRef.current, {
        enabled: FLAGS.spinEnabled,
        turns: TUNING.spinTurns,
        windowMs: TUNING.spinWindowMs,
        threshold: TUNING.spinTurns * Math.PI * 2,
      });
      /**
       * 诊断：**上一下按住的三个答案**（onModel / onHead / onTail，以及事件被哪一层接住）。
       *
       * "点了没反应"要先分清卡在哪一段：事件没进宠物（截不住 / 穿透到页面）、
       * 路由判成"身体"（只有台词）、还是判定本身说不在她身上。从"她说了什么"倒推
       * 这三件事是分不出来的 —— 尾巴那一串问题就是这么绕了好几轮的。
       */
      api.lastPress = () => lastPressRef.current;
    }, []);
    /**
     * The pins the USER owns (slot choices, flashes) and the pins the SESSION
     * phase imposes, kept apart so a phase can drive the look without destroying
     * the user's outfit, and give it back when the phase ends.
     */
    const userPinsRef = useRef({});
    const phasePinsRef = useRef({});
    /**
     * The motion the user's CURRENT slot selection owns, if any.
     *
     * Tracked explicitly rather than inferred from the pin set: a motion-only
     * option (掏出手机) has no expressions, so "all of its expressions are
     * pinned" is vacuously true for it and it would match every time — which
     * parked the phone forever after any fidget.
     */
    /** Fires one idle fidget immediately; used by the panel and by tests. */
    const fidgetRef = useRef(() => {});
    /** Set when the fidget effect has actually installed its trigger. */
    const fidgetLiveRef = useRef(false);
    /** Draw counts, for working out whether the weighting itself is wrong. */
    // A REF, not a plain object: a plain one is rebuilt on every render, so the
    // API attached in a [] effect and the fire() closure in a [ready, pet] effect
    // would end up mutating two different objects, and the tally would read 0
    // forever while the fidget worked perfectly.
    const fidgetTallyRef = useRef({ picked: {}, drawn: {} });
    /** Whether the SCHEDULED fidget may run. Forced calls ignore it. */
    const fidgetEnabledRef = useRef(true);
    const slotMotionRef = useRef(null);
    /**
     * 身体只有一个：多个槽位同时挂着动作（右手=掏出手机、嘴部=吹泡泡糖）时，
     * **最后点的那个槽位**说了算。
     *
     * 原来是"扫描全部槽位、取第一个带 motion 的选中项"，而右手在清单里排在嘴部
     * 之前 —— 于是右手拿着手机时点吹泡泡糖会被**静默忽略**：面板显示已选中，
     * 画面纹丝不动（用户报的"吹泡泡糖又不出来了"，probe-bubble-order 复现）。
     *
     * 这里只记"动作归谁"；那个槽位不再持有动作选项（被清掉/换成表情）时回退到扫描，
     * 所以相位换装、归位这些路径仍然按当前选择算。
     */
    const motionOwnerRef = useRef(null);
    /** slot id -> chosen option label, for the panel highlight and diagnostics. */
    const slotSelectionsRef = useRef({});
    /**
     * Procedural sweeps, layered like the pins: what the user's slots ask for,
     * and what a live session phase asks for (the phase wins while it lasts).
     */
    const userSweepRef = useRef(null);
    const phaseSweepRef = useRef(null);
    /** Slot ids the live phase owns; their user pins are dropped while it lasts. */
    const phaseSlotsRef = useRef([]);
    const slotByIdRef = useRef(new Map());
    /** motion group -> premise, from the manifest. */
    const guardsRef = useRef({});
    /** slot id -> option label the USER chose, and the phase's own picks. */
    const phaseChoicesRef = useRef({});
    const applySweep = useCallback(() => {
      motion.current.setSweep(phaseSweepRef.current ?? userSweepRef.current);
    }, []);
    /** Commit both layers; the phase wins while it lasts. */
    const commitPinsRef = useRef(() => {});
    /** Late-bound handle to applyExpressions, which is declared further down. */
    const applyExpressionsRef = useRef(() => {});
    // The pinned-expression set lives in the component, not the controller, so
    // expose it on the same diagnostic seam; otherwise a test can only see it
    // through the panel's chips, which do not exist while the panel is closed.
    if (typeof window !== "undefined") {
      // **生效层**：互斥裁剪之后、真正写进模型的那一份。断言"画面上是什么"读它。
      window.__dshLive2dPet.expressions = () => Object.keys(pinnedRef.current);
      // **声明层**：互斥之前的那一份（对手还在）。断言"被顶掉的那条有没有被记住"
      // 读它 —— 两条读口分开，正是为了不再把"输出"当成"输入"用（那一混淆让相位脸
      // 在手点 + 收回默认之后永久消失）。
      window.__dshLive2dPet.declaredExpressions = () => Object.keys(declaredPinsRef.current);
      // Programmatic pin set, for diagnostics and the regression suite. It goes
      // through the same funnel as the panel, so slot rules apply identically.
      window.__dshLive2dPet.setExpressions = (names) => {
        const next = {};
        for (const name of names || []) next[name] = true;
        applyExpressionsRef.current(next);
      };
      // 诊断读口：贴图最终走的是哪条路（'worker' / 'main-thread' / 'default'）。
      // 驱动据此断言"Worker 取不到时会退到主线程"，而不是只看"宠物画出来了" ——
      // 后者在 Worker 恰好能用时也成立，区分不出这次修复有没有接上线。
      window.__dshLive2dPet.textureTransport = () => textureTransportName;
    }
    const [motionGroup, setMotionGroup] = useState("");

    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState(null);
    const [coreMissing, setCoreMissing] = useState(false);
    const [ready, setReady] = useState(false);
    const [bubble, setBubble] = useState(null);
    const speechLayoutRef = useRef(null);
    const [panelOpen, setPanelOpen] = useState(false);
    /**
     * Viewport coordinates the panel was pinned at, captured once when it opens.
     *
     * Measured on open and never again: the whole point is that resizing the pet
     * must not move the panel the size slider lives in.
     */
    const [panelBox, setPanelBox] = useState(null);

    useEffect(() => {
      if (!panelOpen) {
        setPanelBox(null);
        return undefined;
      }
      // One frame after it appears, so the panel has been laid out.
      const id = window.requestAnimationFrame(() => {
        const root = rootRef.current;
        if (root === null) return;
        const el = root.querySelector("[data-panel]");
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const margin = 8;
        setPanelBox({
          left: Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin)),
          top: Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin)),
        });
      });
      return () => window.cancelAnimationFrame(id);
    }, [panelOpen]);
    const [tab, setTab] = useState("motions");
    /**
     * 显示层状态：**订阅模块级的 store**（不是本地 ref）。
     *
     * 轮询由模块级单例负责（`ensureLayerPolling`）—— 它**必须**不依赖这个组件：
     * 用户在设置里选了"桌面"之后，页面里这只就让位了，而这个组件一旦不渲染，
     * 由它驱动的轮询也就停了，设置页那一行便永远停在旧文本上（实测：要重开设置页才更新）。
     */
    const layer = useLayerState();
    /**
     * 这一份该不该让位给另一份实现。
     *
     * 根节点与气泡**必须共用同一个结论**：气泡是 `position:fixed` 的，根节点的
     * `visibility:hidden` 盖不住它自己的 `visible`（CSS 里改成 `inherit` 也是为此）。
     * 只藏根节点不藏气泡，让位的那一份会在页面上留下一个"鬼气泡"。
     */
    const yieldToOther = isDesktopShell ? layer.owner !== "desktop" : layer.owner !== "inline";
    useEffect(() => { ensureLayerPolling(); }, []);
    // 设置值在模块作用域的 store 里（DSH 设置页和这里的面板共用一份）。
    // 订阅它既为重渲染，也为下面那个「相位映射随设置重算」的 effect 提供依赖。
    const settingsRev = useSettings();

    const [pinned, setPinned] = useState({});
    const [dragging, setDragging] = useState(false);
    /**
     * 宠物最多能往视口下边沉多少。
     *
     * 下界原来是 0（脚一贴到屏幕底边就不许再往下）。可模型的画布有透明边距，
     * 角色看起来是"悬空"的，用户要把它再往下压一点、让脚真的压出屏幕底边。
     * 按尺寸取比例：大的宠物能压出去更多，小的不至于被推没。
     */
    const BOTTOM_OVERHANG_RATIO = 0.4;
    const BOTTOM_OVERHANG_MAX = 400;
    // 上界用「视口高 - 宠物高」，保证顶部不越出页面（旧值是 innerHeight-60，
    // 窗口从全屏缩小时会把宠物顶出屏幕上沿）。底部仍允许少量下沉。
    // 可见内容的透明内边距：模型按 0.94 缩放进方框，窄/高模型两侧还有空白。
    // 定位按「可见内容」夹而不是方框：角色能真正贴到页面边缘，同时任一边都不会被裁出页面。
    const visibleInsets = (width) => {
      const src = modelSourceRef.current;
      if (src === null || !(src.width > 0) || !(src.height > 0)) return { x: 0, y: 0 };
      const fit = Math.min(width / src.width, width / src.height) * 0.94;
      return {
        x: Math.max(0, (width - src.width * fit) / 2),
        y: Math.max(0, (width - src.height * fit) / 2),
      };
    };
    /** 水平：按可见宽夹在视口内（方框可因透明内边距探出视口，但可见部分始终在页内）。 */
    const clampRight = (value, width) => {
      const inset = visibleInsets(width).x;
      const lo = -inset;
      const hi = Math.max(lo, window.innerWidth - width + inset);
      return Math.max(lo, Math.min(hi, value));
    };
    /** 垂直：按可见高夹在视口内（顶部、底部都不许被裁出页面）。 */
    const clampBottom = (value, width) => {
      const inset = visibleInsets(width).y;
      const lo = -inset;
      const hi = Math.max(lo, window.innerHeight - width + inset);
      return Math.max(lo, Math.min(hi, value));
    };
    /**
     * 位置的"真身"是**相对 DSH 窗口哪条边、相距多少像素**：贴左就记 left 像素，贴右就记 right
     * 像素，垂直记 bottom 像素。窗口放大/缩小时按住同一条边、同样的像素距离，宠物就钉在 DSH 的
     * 同一处。（截图现象：之前按"中心占视口比例"，窗口一变宽，她相对左侧栏就往右飘；换成
     * 固定像素边距后，无论窗口化还是全屏都在同一条竖直/水平位置上。）
     * right/bottom 只是它当前的像素投影。
     */
    const anchorFromPos = (p, width) => {
      const left = window.innerWidth - p.right - width;
      const centre = left + width / 2;
      const side = centre <= window.innerWidth / 2 ? "left" : "right";
      const offset = side === "left" ? left : p.right;
      return { side, offset, bottom: p.bottom };
    };
    const posFromAnchor = (a, width) => ({
      right: a.side === "left" ? (window.innerWidth - a.offset - width) : a.offset,
      bottom: a.bottom,
    });

    const [petId, setPetId] = useState(() => loadStored().petId);
    const [size, setSize] = useState(() => {
      const stored = loadStored().size;
      return typeof stored === "number" && stored >= MIN_SIZE && stored <= MAX_SIZE ? stored : DEFAULT_SIZE;
    });
    const [pos, setPos] = useState(() => {
      const stored = loadStored();
      const width = size;
      // 新存档：按「锚边 + 像素偏移」还原。
      if ((stored.side === "left" || stored.side === "right") && typeof stored.offset === "number") {
        const p = posFromAnchor({ side: stored.side, offset: stored.offset, bottom: typeof stored.bottom === "number" ? stored.bottom : 0 }, width);
        return { right: clampRight(p.right, width), bottom: clampBottom(p.bottom, width) };
      }
      // 上一版存档是中心比例 fx/fy：换算成像素。
      if (typeof stored.fx === "number" && typeof stored.fy === "number") {
        const p = {
          right: window.innerWidth - stored.fx * window.innerWidth - width / 2,
          bottom: window.innerHeight - stored.fy * window.innerHeight - width / 2,
        };
        return { right: clampRight(p.right, width), bottom: clampBottom(p.bottom, width) };
      }
      // 更老的存档只有 right/bottom。
      const right = typeof stored.right === "number" ? Math.max(0, stored.right) : 24;
      const bottom = typeof stored.bottom === "number" ? Math.max(-BOTTOM_OVERHANG_MAX, stored.bottom) : 0;
      return { right: clampRight(right, width), bottom: clampBottom(bottom, width) };
    });
    /** 左右翻转朝向（镜像渲染）：默认不翻，右键面板底部可切换，存在本窗口的 localStorage。 */
    const [flip, setFlip] = useState(() => loadStored().flip === true);
    const flipRef = useRef(flip);

    sizeRef.current = size;
    posRef.current = pos;
    flipRef.current = flip;
    gazeMirror.flip = flip;
    /** 当前锚（贴哪条边 + 像素偏移 + bottom）。窗口 resize 按它重算；改尺寸时保持锚边/偏移不变。 */
    const anchorRef = useRef(null);
    if (anchorRef.current === null) anchorRef.current = anchorFromPos(pos, size);

    /** 把锚落成像素、夹进视口并写档；夹过之后以最终落点回算锚，避免下次继续越界。 */
    const commitAnchor = (a, width) => {
      const raw = posFromAnchor(a, width);
      const right = clampRight(raw.right, width);
      const bottom = clampBottom(raw.bottom, width);
      anchorRef.current = anchorFromPos({ right, bottom }, width);
      saveStored({ right: Math.round(right), bottom: Math.round(bottom), side: anchorRef.current.side, offset: Math.round(anchorRef.current.offset), fx: undefined, fy: undefined });
      return { right, bottom };
    };

    /**
     * 改尺寸时**保持锚边与边距不变**（贴左就左边距不变、bottom 不变）：宠物以锚角为原点变大变小，
     * 不会看着"跑位"。贴边时由 clamp 兜住。
     */
    const changeSize = useCallback((nextRaw) => {
      const next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(nextRaw)));
      const current = sizeRef.current;
      if (next === current) return;
      sizeRef.current = next;
      setSize(next);
      setPos(() => commitAnchor(anchorRef.current, next));
    }, []);

    const pet = catalog !== null && catalog.pets.length > 0
      ? (catalog.pets.find((entry) => entry.id === petId) ?? catalog.pets[0])
      : undefined;

    /**
     * 弹一句气泡。
     *
     * 三件可配的事都收在这里（用户要的"所有文本都可配 / 位置可配 / 可以开关"）：
     * 气泡总开关关掉时**直接不弹**（连问候也不弹）；位置偏移走 TUNING，渲染时当 CSS 变量；
     * 文本本身由调用方从 `linesNow()` 取（宠物默认 + 用户覆盖）。
     */
    const say = useCallback((text) => {
      if (!FLAGS.bubbleEnabled) return;
      if (typeof text !== "string" || text === "") return;
      setBubble(text);
      window.clearTimeout(bubbleTimer.current);
      bubbleTimer.current = window.setTimeout(() => setBubble(null), TUNING.bubbleHoldMs);
    }, []);

    useEffect(() => () => window.clearTimeout(bubbleTimer.current), []);

    // 一句话只采一次头部锚点，存成舞台比例；呼吸与摇头不会让对白追着几何抖。
    // 位置直接写 DOM，不把布局测量变成整只宠物的持续重渲染。
    useEffect(() => {
      if (bubble === null || yieldToOther) { speechLayoutRef.current = null; return undefined; }
      const place = () => {
        const root = rootRef.current;
        const el = root?.querySelector("[data-bubble]");
        if (!el) return;
        const rect = root.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return;
        const box = el.getBoundingClientRect();
        let anchor = speechLayoutRef.current;
        if (!anchor || anchor.text !== bubble) {
          const api = motion.current;
          const head = api.headBox?.();
          // 交互盒扩过边，不能拿顶边当头顶；取两侧上半部，气泡主体留在头发外。
          const point = fraction => head ? api.modelToStage?.(
            head.minX + (head.maxX - head.minX) * fraction,
            head.minY + (head.maxY - head.minY) * 0.60) : null;
          const left = point(0.12), right = point(0.88);
          anchor = { text: bubble,
            left: (left?.x ?? rect.width * 0.28) / rect.width,
            right: (right?.x ?? rect.width * 0.72) / rect.width,
            y: (left?.y ?? rect.height * 0.38) / rect.height,
            side: rect.left + rect.width / 2 >= window.innerWidth / 2 ? "left" : "right" };
          speechLayoutRef.current = anchor;
        }
        const scale = speechScale(size);
        const margin = 12, gap = 16 * scale;
        const leftSpace = rect.left + anchor.left * rect.width - margin;
        const rightSpace = window.innerWidth - margin - rect.left - anchor.right * rect.width;
        // 只有原侧装不下、另一侧确实能装下时才换边，避免拖动经过屏幕中心就跳来跳去。
        if (anchor.side === "left" && leftSpace < box.width + gap && rightSpace >= box.width + gap) anchor.side = "right";
        else if (anchor.side === "right" && rightSpace < box.width + gap && leftSpace >= box.width + gap) anchor.side = "left";
        const x = rect.left + (anchor.side === "left" ? anchor.left : anchor.right) * rect.width;
        const y = rect.top + anchor.y * rect.height;
        const desiredLeft = (anchor.side === "left" ? x - box.width - gap : x + gap) + TUNING.bubbleOffsetX;
        const left = Math.max(margin, Math.min(desiredLeft, window.innerWidth - box.width - margin));
        const top = Math.max(margin, Math.min(y - box.height - 12 * scale + TUNING.bubbleOffsetY,
          window.innerHeight - box.height - margin - 8 * scale));
        // fixed 坐标配合 CSS 缓动：拖动/缩放才跟随，不继承根节点每一下的位移。
        el.style.transition = el.hasAttribute("data-placed") ? "" : "none";
        el.style.left = Math.round(left) + "px";
        el.style.top = Math.round(top) + "px";
        el.dataset.side = anchor.side;
        el.dataset.placed = "";
      };
      place();
      const observer = new ResizeObserver(place);
      const el = rootRef.current?.querySelector("[data-bubble]");
      if (el) observer.observe(el);
      window.addEventListener("resize", place);
      return () => { observer.disconnect(); window.removeEventListener("resize", place); };
    }, [bubble, size, pos, ready, settingsRev, yieldToOther]);


    // The controller owns the motion lifecycle; the panel highlights whatever
    // group it is currently playing and clears the highlight on idle.
    useEffect(() => {
      const controller = motion.current;
      controller.setExpressionApplier(() => {
        const model = modelRef.current;
        if (model === null) return;
        const names = Object.keys(pinnedRef.current);
        if (names.length > 0) void model.expression(names[names.length - 1]);
      });
      controller.subscribe((group) => {
        setMotionGroup(group === null ? "" : group);
        // Back at rest: flush a phase that had to wait for the body.
        if (group === null && pendingPhaseRef.current !== null) {
          const next = pendingPhaseRef.current;
          pendingPhaseRef.current = null;
          flushPhaseRef.current(next);
        }
      });
      return () => {
        controller.subscribe(null);
        controller.setExpressionApplier(null);
      };
    }, []);

    // ---- catalog ------------------------------------------------------
    useEffect(() => {
      let alive = true;
      fetch(API + "/catalog").then(
        (response) => {
          if (!response.ok) throw new Error("catalog HTTP " + response.status);
          return response.json();
        },
      ).then((value) => {
        if (!alive) return;
        setCatalog(value);
        setPetId((current) => (
          value.pets.length === 0 || value.pets.some((entry) => entry.id === current)
            ? current
            : value.pets[0].id
        ));
      }, (reason) => {
        if (alive) setError(String((reason && reason.message) || reason));
      });
      return () => { alive = false; };
    }, []);

    /**
     * 相位映射随设置变化重算。
     *
     * 基线（内置 + pet.json）由 model boot 那段填；用户改的是**池子**
     * （phasePoolsFor 每次现取），动作组仍然是基线上的一份只读映射。
     */
    useEffect(() => {
      const base = phaseBaseRef.current;
      phaseMotionRef.current = Object.assign({}, base.motions);
      phaseExpressionRef.current = Object.assign({}, base.expressions);
      // 正在跑的那个相位，池子被改过就**当场重抽一次** —— 否则用户删掉的条目要等到
      // 下一次相位切换才消失，看起来像"设置没生效"。比对签名而不是直接重放：调滑杆
      // 也会触发 settingsRev，每次都重抽的话宠物会在会话中不断换姿势。
      const live = phaseRef.current;
      if (live === "idle") return;
      const signature = JSON.stringify(phasePoolsFor(live));
      if (signature === phasePoolsRev.current) return;
      phasePoolsRev.current = signature;
      flushPhaseRef.current?.(live);
    }, [settingsRev]);

    // ---- model boot ---------------------------------------------------
    useEffect(() => {
      if (catalog === null || pet === undefined) return undefined;
      const stage = stageRef.current;
      if (stage === null) return undefined;
      let disposed = false;
      let app;
      let model;

        // Per-pet phase overrides: the manifest's live2d.motions/expressions use
      // the same phase keys, so a model can retarget any slot. Unset slots keep
      // the built-in defaults.
      // 相位映射：内置默认 <- pet.json <- 用户在设置页的覆盖。
      phaseBaseRef.current = {
        motions: Object.assign({}, PHASE_MOTION, pet.motionsByPhase || {}),
        expressions: Object.assign({}, PHASE_EXPRESSION, pet.expressionsByPhase || {}),
      };
      phaseMotionRef.current = Object.assign({}, phaseBaseRef.current.motions);
      phaseExpressionRef.current = Object.assign({}, phaseBaseRef.current.expressions);
      // 设置界面（含 DSH 设置页那个独立组件）需要清单里有哪些动作/表情/槽位。
      MANIFEST.current = pet;
      UPLOADED_SOUNDS.petId = null;
      UPLOADED_SOUNDS.sounds = {};
      stopUploadedSound();
      void pullUploadedSounds();
      // 头部部件（宿主从 cdi3 的作者命名里挑的，21 个）交给控制器：摸头判定按这些
      // 部件的**真实三角面**测，而不是一个手调内边距的方框。
      motion.current.setHeadParts(pet.headParts ?? []);
      motion.current.setTailParts(pet.tailParts ?? []);
      // 清单换了（换宠物 / pet.json 改了槽位结构）就先剪一遍存档：
      // 旧槽位的覆盖会让"关系指向不存在的槽位"这类问题**静默**发生。
      pruneOverrides(pet);
      slotByIdRef.current = new Map((pet.expressionSlots ?? []).map((slot) => [slot.id, slot]));
      guardsRef.current = pet.motionGuards || {};
      phaseRef.current = "idle";

      fitRef.scale = typeof pet.scale === "number" && pet.scale > 0 ? pet.scale : 1;
      fitRef.x = typeof pet.translate?.x === "number" ? pet.translate.x : 0;
      fitRef.y = typeof pet.translate?.y === "number" ? pet.translate.y : 0;

      // The model's UNSCALED size, captured once at load while scale is still
      // 1. It is essential that the fit is derived from this and never from
      // model.width/height: Pixi's Container.width getter reports the size at
      // the CURRENT scale, so using it as the fit input makes every layout
      // multiply the previous scale by itself again — which is why merely
      // opening the panel (one relayout) blew the pet up dramatically.
      let source = null;

      const layout = () => {
        const currentApp = appRef.current;
        const currentModel = modelRef.current;
        if (currentApp === undefined || currentApp === null || currentModel === null || source === null) return;
        const rect = stage.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        // Logical size in CSS px; the renderer's resolution (set at init) keeps
        // the backing store at device-pixel density so scaling stays crisp.
        currentApp.renderer.resize(width, height);
        const fit = Math.min(width / source.width, height / source.height) * 0.94;
        currentModel.anchor.set(0.5, 0.5);
        // 翻转 = 把 x 轴缩放取负（绕模型中心镜像），y 不变。命中与气泡用的是模型自身
        // 变换，负缩放同样成立，镜像后点击区域仍然对得上。
        const fitScale = fit * fitRef.scale;
        currentModel.scale.set(flipRef.current ? -fitScale : fitScale, fitScale);
        currentModel.position.set(width / 2 + fitRef.x, height / 2 + fitRef.y);
        // Keep the gaze anchored to the model's own centre after a resizeso a
        // stale pointer position cannot leave it staring off-frame.
        focusDefault();
      };
      layoutRef.current = layout;

      const boot = async () => {
        // 贴图取法的探测与下面的 core/vendor/renderer 初始化并行跑（issue #10）。
        const probe = startTextureProbe(absolutize(pet.modelUrl));
        if (!await ensureCore(absolutize(catalog.coreUrl))) {
          if (!disposed) setCoreMissing(true);
          return;
        }
        if (disposed) return;
        setCoreMissing(false);
        const vendor = await ensureVendor(absolutize(catalog.vendorUrl));
        if (disposed) return;
        if (vendor === undefined) throw new Error("vendor bundle unavailable");
        configureVendor(vendor);
        // 贴图取法要先定下来：Pixi 在 `Live2DModel.from` 里就会去取贴图（issue #10）。
        await prepareTextureTransport(vendor, probe);
        if (disposed) return;

        const nextApp = new vendor.Application();
        const rect = stage.getBoundingClientRect();
        // resolution = max(2, DPR) with autoDensity off: the backing store is
        // sized in device pixels by Pixi, while the CSS size is still driven by
        // our own 100%/100% rule. That is what keeps a large or upscaled pet
        // sharp instead of a stretched 1x bitmap, and the 2x floor doubles the
        // samples available for a small pet (see RENDER_RESOLUTION_MIN).
        await nextApp.init({
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: false,
          resolution: renderResolution(),
          preference: "webgl",
          // The rendered frame must stay readable so the character's
          // silhouette can be sampled for click hit-testing (see
          // buildHitMask). Without this the drawing buffer is cleared after
          // compositing and every readback comes back empty.
          preserveDrawingBuffer: true,
        });
        if (disposed) {
          nextApp.destroy({ removeView: true }, { children: true });
          return;
        }
        app = nextApp;
        appRef.current = nextApp;
        app.canvas.style.width = "100%";
        app.canvas.style.height = "100%";
        stage.appendChild(app.canvas);

        const loaded = await vendor.Live2DModel.from(absolutize(pet.modelUrl), {
          autoUpdate: false,
          autoHitTest: true,
          autoFocus: false,
          // The engine's blink is gated behind "no motion drove parameters this
          // frame", and this model's idle loop runs continuously — so its gate
          // never opened and the pet never blinked. Blinking is driven by this
          // plugin instead; leaving the engine's on as well would double up on
          // whatever frames its gate did happen to open.
          eyeBlink: false,
          // Textures stay at full resolution and are minified by a real mip
          // chain instead of the engine's LOD copies.
          //
          // The model ships a 2048x2048 atlas that is drawn at ~160-760 CSS
          // px, so it is minified 3-12x. Two things were wrong before:
          //
          //  * 'single-auto' only kicks in below effectiveScale 0.5 and then
          //    swaps the texture for ONE 2^n-divided copy — at a 300px pet
          //    effectiveScale is ~0.59, so that branch never even fired and
          //    the 2048px atlas was point-sampled straight down to 300px,
          //    throwing away 6 of every 7 texels. That is the shimmer and the
          //    washed-out ("虚") thin linework.
          //  * 'lod: false' is not "keep the full texture": the engine only
          //    asks the asset loader for a mip chain when lod === "full", so
          //    lod:false gives a full-res texture with NO mipmaps — the worst
          //    of both worlds under minification.
          //
          // "full" is the setting that actually builds the mip chain (feeding
          // every level to GL), while still leaving the trim/filter LOD knobs
          // at their defaults. Anisotropy then keeps the diagonals of the line
          // art from smearing at grazing angles.
          textureOptions: { lod: "full" },
        });
        // Only `lod` is forwarded to the asset loader, so the sampler style has
        // to be applied to the live texture sources afterwards. Anisotropic
        // filtering is what keeps the diagonals of the line art (bangs, ribbon
        // edges) from smearing into a soft blur when the surface is at a
        // grazing angle to the screen.
        for (const texture of loaded.textures ?? []) {
          const style = texture?.source?.style;
          if (style === undefined || style === null) continue;
          style.maxAnisotropy = TEXTURE_ANISOTROPY;
        }
        if (disposed) {
          loaded.destroy({ children: true });
          return;
        }
        model = loaded;
        modelRef.current = loaded;
        app.stage.addChild(loaded);
        // Capture the intrinsic geometry now, before any scaling is applied.
        const intrinsic = loaded.internalModel;
        source = {
          width: Math.max(1, intrinsic?.originalWidth || loaded.width),
          height: Math.max(1, intrinsic?.originalHeight || loaded.height),
        };
        modelSourceRef.current = source;
        layout();
        loaded.automator.autoUpdate = true;
        motion.current.attach(vendor, loaded, pet.motions, pet.motionOptions);
        setReady(true);
        // Derive the clickable silhouette from the first rendered frame. This
        // runs after ready so the panel and pet are usable even if extraction
        // is slow, and a failure simply leaves the whole box clickable.
        const refreshMask = async () => {
          const mask = await buildHitMaskWhenPainted(app, loaded, () => disposed);
          if (disposed) return;
          if (mask === null) motion.current.setHitMask(null, null);
          else motion.current.setHitMask(mask, mask.box);
          // Publish the silhouette for the hit-through proxy. An empty string
          // means "no mask": the proxy stays hidden and behaves like before.
          setMaskPath(motion.current.maskPath() ?? "");
        };
        rebuildMaskRef.current = refreshMask;
        void refreshMask();
      };

      boot().catch((reason) => {
        if (!disposed) {
          setError(String((reason && reason.message) || reason));
          say(pick(linesNow().loadFailed));
        }
      });

      return () => {
        disposed = true;
        motion.current.detach();
        layoutRef.current = null;
        rebuildMaskRef.current = null;
        appRef.current = null;
        modelRef.current = null;
        setReady(false);
        const currentApp = app;
        const currentModel = model;
        app = undefined;
        model = undefined;
        if (currentApp !== undefined) {
          try { currentApp.destroy({ removeView: true }, { children: true }); } catch { /* partial boot */ }
        } else if (currentModel !== undefined) {
          // A model that finished loading before its app existed is still ours
          // to release; the app-owned path is handled by the app destroy above.
          try { currentModel.destroy({ children: true }); } catch { /* partial boot */ }
        }
      };
    }, [catalog, pet, say]);

    // ---- resize -------------------------------------------------------
    // A resized pet moves and rescales the model, so the silhouette captured
    // at boot no longer lines up with the clickable area. Re-derive it after
    // the layout settles (debounced: a drag-resize fires many times).
    useEffect(() => {
      const layout = layoutRef.current;
      if (layout !== null) layout();
      const timer = window.setTimeout(() => {
        const rebuild = rebuildMaskRef.current;
        if (rebuild !== null) void rebuild();
      }, 250);
      return () => window.clearTimeout(timer);
    }, [size, panelOpen]);

    useEffect(() => {
      const stage = stageRef.current;
      if (stage === null || typeof ResizeObserver === "undefined") return undefined;
      const observer = new ResizeObserver(() => {
        const layout = layoutRef.current;
        if (layout !== null) layout();
      });
      observer.observe(stage);
      return () => observer.disconnect();
    }, []);

    // 窗口尺寸变化：按「锚边 + 像素边距」重算坐标，让宠物钉在 DSH 的同一处（窗口化/全屏
    // 都停在同一竖直/水平位置）。锚本身不变，只把落点夹回视口。
    useEffect(() => {
      if (isDesktopShell) return undefined; // 桌面壳里位置归壳管，页面这一份不动它
      const onResize = () => {
        setPos(() => commitAnchor(anchorRef.current, sizeRef.current));
      };
      window.addEventListener("resize", onResize);
      const vv = typeof window.visualViewport !== "undefined" && window.visualViewport !== null;
      if (vv) window.visualViewport.addEventListener("resize", onResize);
      onResize();
      return () => {
        window.removeEventListener("resize", onResize);
        if (vv) window.visualViewport.removeEventListener("resize", onResize);
      };
    }, []);

    // 翻转切换后立刻重排（改的是模型的 x 缩放），并重建轮廓遮罩让点击区跟着镜像。
    useEffect(() => {
      const layout = layoutRef.current;
      if (layout !== null) layout();
      const timer = window.setTimeout(() => {
        const rebuild = rebuildMaskRef.current;
        if (rebuild !== null) void rebuild();
      }, 200);
      return () => window.clearTimeout(timer);
    }, [flip]);

    /**
     * 尾巴那一层可点区域的**动态更新**。
     *
     * 尾鳍一直摆，而 `[data-hit]` 的轮廓是开机快照 —— 摆出去就点不到（事件穿透到页面）。
     * 这里按固定间隔把尾巴此刻的包围盒（模型空间）换算成舞台上的百分比矩形：
     *
     *   模型空间 → 舞台：`model.getBounds()` 给的是舞台局部盒，
     *   尾巴各 drawable 的并集盒 → 按比例映射进那个盒子里（同一套映射，
     *   不猜 anchor / scale，换缩放、换宠物都成立）。
     *
     * 间隔 120ms 是刻意的：尾鳍一个摆动来回约 0.5 秒，取 1/4 个周期足够跟上，
     * 而每帧 setState 会让整个宠物重渲染 —— 那是白烧。**只在格子真的变了才 setState**，
     * 静止时一个渲染都不产生。
     */
    useEffect(() => {
      if (!ready) return undefined;
      let last = "";
      const tick = () => {
        const api = motion.current;
        const stage = stageRef.current;
        if (api === null || stage === null) return;
        // 诊断开关：`window.__petNoTailLayer = true` 之后这一层不再拼进 `clip-path`。
        // 用它一次就能量出"尾巴层到底贡献了多大一片可摸区"（对比量比反复改代码猜快得多）。
        const hull = window.__petNoTailLayer === true
          ? null
          : (typeof api.tailRectNow === "function" ? api.tailRectNow() : null);
        if (hull === null || typeof api.modelToStage !== "function") {
          if (last !== "") { last = ""; setTailPath(""); }
          return;
        }
        const rect = stage.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        // **逐块一个矩形**，拼成一条 path（`clip-path` 默认 nonzero，重叠部分照样算内部）。
        //
        // 这里不再做空间映射：`tailRectNow()` 已经给的是**舞台局部像素**（它内部把四个角
        // 都映射过了）。第一版在这里先并成一个大盒再映射，结果框进 43%×54% 的空白 ——
        // 用户看到的就是"右下角明明什么都没有却能摸"。
        let next = "";
        for (const box of hull) {
          const left = Math.max(0, Math.min(rect.width, box.x0));
          const top = Math.max(0, Math.min(rect.height, box.y0));
          const right = Math.max(0, Math.min(rect.width, box.x1));
          const bottom = Math.max(0, Math.min(rect.height, box.y1));
          const width = right - left;
          const height = bottom - top;
          if (!(width > 0) || !(height > 0)) continue;
          next += "M" + left.toFixed(1) + " " + top.toFixed(1)
            + "h" + width.toFixed(1) + "v" + height.toFixed(1) + "h-" + width.toFixed(1) + "Z";
        }
        if (next === last) return;
        last = next;
        setTailPath(next);
      };
      tick();
      const timer = window.setInterval(tick, 120);
      return () => window.clearInterval(timer);
    }, [ready]);

    // ---- greeting -----------------------------------------------------
    useEffect(() => {
      if (!ready || greeted.current) return;
      greeted.current = true;
      say(pick(linesNow().greet));
    }, [ready, say]);


    // ---- mouse tracking -----------------------------------------------
    // Gaze is driven only while the pointer is in or near the stage, and relaxes
    // to the model's DEFAULT resting position — its own centre, not wherever the
    // pointer happened to be last — the moment it leaves that neighbourhood.
    useEffect(() => {
      if (!ready) return undefined;
      const stage = stageRef.current;
      if (stage === null) return undefined;
      // The resting target is the stage centre, i.e. where the model sits.
      focusDefaultRef.current = () => {
        // The DEFAULT resting target is the model's own centre — not the last
        // pointer position — so the pet always settles back to a neutral gaze.
        // 偏移 0 = 正中，与"满偏半径"无关（视线回中不该受那个参数影响）。
        motion.current.updatePointer(0, 0, 320);
        reportGaze("center");
      };
      let resting = false;
      focusDefault();
      resting = true;
      // 转圈检测的状态：上一次的角度、累计转角、这轮累计的起始时刻、上次触发时刻。
      let spinLastAngle = null;
      let spinTotal = 0;
      let spinStartedAt = 0;
      let spinLastFire = 0;
      const spinTrack = (rect, x, y) => {
        if (!FLAGS.spinEnabled) return;
        spinStatsRef.current.moves += 1;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const dx = x - cx;
        const dy = y - cy;
        // 太靠近中心时角度会剧烈抖动（半径趋近 0）：跳过，不参与累计。
        if (Math.hypot(dx, dy) < rect.width * 0.12) return;
        const angle = Math.atan2(dy, dx);
        if (spinLastAngle === null) {
          spinLastAngle = angle;
          spinStartedAt = Date.now();
          return;
        }
        let delta = angle - spinLastAngle;
        // 归一化到 (-π, π]，否则跨越 ±π 时会出现一整个 2π 的假增量。
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        spinLastAngle = angle;
        const now = Date.now();
        // "要在多少 ms 内转够 N 圈"：窗口从**这轮累计开始**算起，超时就整轮作废、
        // 从这一下重新开始。原来写的是 `now - spinLastFire > 窗口` —— 那个值一开始
        // 恒大于窗口，于是每次移动都把累计清零，永远攒不到 π（诊断读口里 total 一直是 0.07）。
        if (now - spinStartedAt > TUNING.spinWindowMs) {
          spinTotal = 0;
          spinStartedAt = now;
        }
        spinTotal += delta;
        spinStatsRef.current.total = spinTotal;
        if (Math.abs(spinTotal) < TUNING.spinTurns * Math.PI * 2) return;
        if (now - spinLastFire < 1500) return;
        spinTotal = 0;
        spinStartedAt = now;
        spinLastFire = now;
        spinStatsRef.current.fires += 1;
        lastInteraction.current = now;
        const list = interactionReactions("spinReactions");
        if (list.length > 0) runReactionRef.current(pick(list));
        say(pick(linesNow().spin));
      };
      /**
       * 跟随一次指针位置（**视口坐标**）。
       *
       * 两个来源，同一条逻辑：
       *   * 网页端 / 指针在窗口内时 —— DOM 的 `pointermove`（浏览器只在落点位于本窗口时送来）；
       *   * **桌面端 + 指针在别的程序上** —— 由壳喂进来（`window.__petPointer`）。
       *     没有这条通道时，用户一离开宠物窗口她就不跟了（这正是"只有焦点在宠物上才有跟随"）。
       *
       * **坐标系是视口，不是她那个盒子。** 原来把坐标减去 `stage.getBoundingClientRect()`，
       * 于是盒子外的点全被当成"远得没边"（判据半径又只有 240px），整段跟随就断了。
       * 现在：以她的**中心**为原点、按像素距离归一化，`gazeRangePx` 是满偏半径。
       */
      const onMove = (clientX, clientY, source) => {
        const rect = stage.getBoundingClientRect();
        // 她在视口里的中心（`rect` 只用来定位她，不再用来归一化）。
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const dx = clientX - centreX;
        const dy = clientY - centreY;
        // 满偏半径：**按像素算，不按盒子算**。
        //
        // 旧契约是"偏移 ÷ 她盒子的一半"，缺点在桌面端很明显：盒子是 300px，于是**全屏**
        // 的移动都落在"盒子外的死区"里，一离开她那个方块就不跟了（用户报的"跟随范围有问题"）。
        // 像素契约修好了那一段，但**范围要给对**：见 `gazeRangePx` 的注释 —— 它是"从多远
        // 开始贴边"，调大了就成了"全屏都在跟且处处满偏"。
        // 满偏半径：**正圆，一个半径说了算**。
        //
        // 旧契约是"偏移 ÷ 她盒子的一半"，缺点在桌面端很明显：盒子是 300px，于是**全屏**
        // 的移动都落在"盒子外的死区"里，一离开她那个方块就不跟了（用户报的"跟随范围有问题"）。
        //
        // 上限取**视口半高/半宽**：半径超过视野就没有意义（远处一律贴边），而正圆又不能像
        // 椭圆那样"竖直方向借一点" —— 所以允许的半径就是这个框能容下的最大圆。
        const range = Math.max(
          Math.min(rect.width, rect.height) / 2,
          Math.min(TUNING.gazeRangePx, Math.min(window.innerWidth, window.innerHeight) / 2),
        );
        // ---- 太远就当她没在看（衰减，不是硬边界）-----------------------------
        //
        // 判据是**到她的圆形距离** `u = hypot(dx, dy) / range`：
        //   * `u ≤ 1`：在满偏圆内，强度 1；
        //   * `1 < u < ratio`：强度从 1 缓动衰减到 0 —— 她"渐渐不感兴趣"；
        //   * `u ≥ ratio`：当她没在看，视线回正。
        //
        // 为什么不要硬边界：早先写成"超过阈值立刻回正"，于是她要么满偏斜眼盯着、要么啪一下
        // 回正，中间没有过渡 —— 用户看到的就是"全屏都在追踪"（贴边）或"突然不看了"。
        // 衰减让远处"渐渐不感兴趣"，这也更像活物。
        const watching = range * TUNING.gazeWatchingRatio;
        const u = Math.hypot(dx, dy) / range;
        const strength = u <= 1 ? 1 : (u >= TUNING.gazeWatchingRatio ? 0 : (TUNING.gazeWatchingRatio - u) / (TUNING.gazeWatchingRatio - 1));
        if (strength <= 0) {
          // 她没在看：回中位，并把对外状态标回 `center`（驱动与用户都看得见这一点）。
          if (!resting) {
            resting = true;
            focusDefault();
          }
          gazeTrace.current = {
            dx: Math.round(dx), dy: Math.round(dy),
            at: { x: Math.round(clientX), y: Math.round(clientY) },
            centre: { x: Math.round(centreX), y: Math.round(centreY) },
            box: { w: Math.round(rect.width), h: Math.round(rect.height) },
            range: Math.round(range),
            watching: Math.round(watching),
            distanceRatio: Number(u.toFixed(3)), strength: 0,
            tuningPx: TUNING.gazeRangePx,
            source: source ?? "dom", skipped: "out-of-watching-range",
          };
          return;
        }
        // ---- 鼠标围着转圈 → 转晕 ------------------------------------------
        // 判定的是"围绕舞台中心的**累计转角**"：每次移动取与上一次的夹角增量
        // （归一化到 ±180°），在一段时间窗内累计；够 spinTurns 圈就触发一次。
        // 用累计角而不是"位置绕了几圈"，是因为前者对半径不敏感 —— 贴着角色转
        // 小圈和远远地转大圈都算，符合"逗她"的直觉。
        // ⚠️ `spinTrack` 要的是**盒子内的坐标**（它围绕舞台中心算累计转角），这里给的是
        // 视口坐标 —— 必须转回去。直接传视口坐标的后果是"围绕一个远处的点转小角"，
        // 累计转角小到永远够不着阈值（实测 103 次移动只累计 0.13 弧度，阈值 12.57）。
        spinTrack(rect, clientX - rect.left, clientY - rect.top);
        // 诊断读口：跟随范围这一块最容易"看着像没反应"，把中间量挂出来，
        // 驱动量到异常时一眼能看出是判据错了还是参数没生效（只读，不影响行为）。
        gazeTrace.current = {
          dx: Math.round(dx), dy: Math.round(dy),
          at: { x: Math.round(clientX), y: Math.round(clientY) },
          centre: { x: Math.round(centreX), y: Math.round(centreY) },
          box: { w: Math.round(rect.width), h: Math.round(rect.height) },
          range: Math.round(range),
          watching: Math.round(watching),
          distanceRatio: Number(u.toFixed(3)), strength: Number(strength.toFixed(3)),
          tuningPx: TUNING.gazeRangePx,
          source: source ?? "dom",
        };
        resting = false;
        // 强度乘在偏移上：满偏圆内是 1（与原行为一致），远处按**圆形距离比**平滑衰减到 0。
        motion.current.updatePointer(dx * strength, dy * strength, range);
        reportGaze("pointer");
      };
      /**
       * 指针「不在场」了：回正。
       *
       * 网页端：鼠标移出窗口后 `pointermove` 不再发来，宠物会僵在最后一个注视方向上，
       * 所以离开窗口 / 失焦 / 切标签页都当成"指针不在场"，视线与嘴缓动回中位。
       *
       * **桌面端不要走这条**：那边由壳持续喂全局光标位置（`window.__petPointer`），指针
       * "离开窗口"根本不代表它不存在 —— 恰恰相反，用户在别的程序里动鼠标时她**应该**跟着。
       * 所以桌面端把 `mouseleave`/`blur` 的回正效果压掉，只在壳明确说"指针不在场"时回正
       * （壳那边有 `outside` 判定）。
       */
      const onLeave = () => {
        if (isDesktopShell) return;
        if (resting) return;
        resting = true;
        focusDefault();
      };
      const root = document.documentElement;
      root.addEventListener("mouseleave", onLeave);
      window.addEventListener("blur", onLeave);
      document.addEventListener("visibilitychange", onLeave);
      // DOM 路径：指针落在本窗口内时走它（网页端全部走它；桌面端在窗口内也走它）。
      const onDomMove = (event) => onMove(event.clientX, event.clientY, "dom");
      window.addEventListener("pointermove", onDomMove, { passive: true });
      // 壳路径：**桌面端专有** —— 指针在别的程序上时 DOM 一个事件都不会有，只有壳知道它在哪。
      if (isDesktopShell) {
        externalPointer.handler = (x, y) => {
          onMove(x, y, "shell");
          // 壳喂进来的位置说明指针在场（它是在读全局光标），把"回正"的状态解除掉。
          resting = false;
        };
      }      return () => {
        window.removeEventListener("pointermove", onDomMove);
        root.removeEventListener("mouseleave", onLeave);
        window.removeEventListener("blur", onLeave);
        document.removeEventListener("visibilitychange", onLeave);
        if (isDesktopShell) externalPointer.handler = null;
        focusDefaultRef.current = () => {};
      };
    }, [ready]);

    // ---- imperative actions -------------------------------------------
    // Every manual play is a one-shot through the controller: it stops the
    // previous motion, forces the new one past the priority gate, and returns
    // to idle afterwards even when the motion is flagged Loop.
    /**
     * 面板「动作」播放前，清掉"非装扮"的临时状态（用户 pin / 相位 pin / 动作归属），
     * 只保留穿在身上的装扮槽（OUTFIT_SLOTS）——这样上一个动作残留的姿势/表情
     * （例如挤番茄酱留下的蛋包饭、挤番茄酱本身）不会让"待机"看起来还是那个动作。
     */
    function clearTransientPinsForAction() {
      userPinsRef.current = {};
      phasePinsRef.current = {};
      const keepOutfit = {};
      for (const id of OUTFIT_SLOTS) {
        const label = slotSelectionsRef.current[id];
        if (label !== undefined) keepOutfit[id] = label;
      }
      slotSelectionsRef.current = keepOutfit;
      if (motionOwnerRef.current !== null && keepOutfit[motionOwnerRef.current] === undefined) {
        motionOwnerRef.current = null;
      }
      commitPinsRef.current();
    }

    const playMotion = useCallback((group, index) => {
      // ① 点「待机」= 回到干净默认：先把上一个动作残留的临时 pin 清掉。
      if (group === "Idle") {
        try { clearTransientPinsForAction(); } catch { /* 清不干净也别挡 */ }
      }
      // ② 有前提的动作，先把前提槽位补齐（挤番茄酱→左手蛋包饭、自拍→右手手机、
      //    鲸鱼喷水→鲸鱼头顶鲸/放桌上），否则会被守卫拦截。
      try {
        const needs = [];
        const guard = guardsRef.current?.[group];
        if (guard !== undefined && guard !== null) {
          for (const [slotId, labels] of Object.entries(guard)) {
            if (Array.isArray(labels) && labels.length > 0) needs.push({ slot: slotId, label: labels[0] });
          }
        }
        for (const need of motionRequiresFor(group)) {
          if (need !== null && typeof need.slot === "string" && typeof need.label === "string") needs.push(need);
        }
        for (const need of needs) {
          if (slotSelectionsRef.current[need.slot] === need.label) continue;
          const slot = (petRef.current?.expressionSlots ?? []).find((candidate) => candidate.id === need.slot);
          const option = slot?.options?.find((candidate) => candidate.label === need.label);
          if (slot !== undefined && option !== undefined) chooseSlotOptionRef.current(slot, option, true);
        }
      } catch { /* 补前提失败也别挡住播放本身 */ }
      // ③ 面板是用户明确点播：带 force 播放，前提已尽量补齐，别再被守卫静默拦掉
      //    （鲸鱼喷水这类既有 motionGuard、又会写独立参数的动作用得上）。
      motion.current.playOnce(group, index, { kind: "panel", force: true });
    }, []);

    /**
     * 一个槽位**此刻**显示的是什么 —— 面板高亮、配对、动作守卫三处都读它。
     *
     * 三段：
     *   1. **装扮槽**永远归用户：眼镜/发饰/魔爪/巴菲/桌布/手机换色是"穿在身上的"，
     *      会话相位不碰它们（用户明确要求），哪怕相位的池子里点了名；
     *   2. 相位**点名**了这个槽位 → 用相位的选择（可能是 null = 相位说这里空着）；
     *   3. 会话进行中、而相位没点名 → **空**：相位是"接管"，没点名的槽位也要让位。
     *      以前这里退回用户的选择，于是"爱心眼 + 冒爱心 + 掏出手机"在整场会话里一直
     *      挂着（用户报的"会话时没有把插槽重置"）；
     *   4. 其余 → 用户自己的选择。
     */
    const effectiveSlotChoice = (slotId) => {
      if (OUTFIT_SLOTS.indexOf(slotId) !== -1) return slotSelectionsRef.current[slotId];
      if (Object.prototype.hasOwnProperty.call(phaseChoicesRef.current, slotId)) {
        return phaseChoicesRef.current[slotId];
      }
      if (phaseRef.current !== "idle") return undefined;
      return slotSelectionsRef.current[slotId];
    };

    /** 某个槽位此刻挂着哪个动作组（读**有效选择**）。 */
    const motionGroupOfSlot = (slotId) => {
      const label = effectiveSlotChoice(slotId);
      if (label === undefined || label === null) return null;
      const picked = (petRef.current?.expressionSlots ?? [])
        .find((slot) => slot.id === slotId)?.options.find((o) => o.label === label);
      return typeof picked?.motion === "string" ? picked.motion : null;
    };

    /**
     * 身体此刻该播哪个动作 —— 按**有效选择**扫一遍槽位。
     *
     * "最后点的那个槽位"优先（`motionOwnerRef`），它不再是动作选项时回退到"扫描全部槽位
     * 取第一个带 motion 的"。只用扫描会在"右手拿着手机时点吹泡泡糖"时把后者静默忽略
     * （右手在清单里排在嘴部之前），只用记忆会在槽位被换掉后留下陈旧值。
     */
    const desiredSlotMotion = () => {
      const owner = motionOwnerRef.current;
      if (owner !== null) {
        const owned = motionGroupOfSlot(owner);
        if (owned !== null) return owned;
      }
      for (const other of petRef.current?.expressionSlots ?? []) {
        const found = motionGroupOfSlot(other.id);
        if (found !== null) return found;
      }
      return null;
    };

    /**
     * 重算"替哪些*别的*槽位保姿势"。
     *
     * 身体只有一个动作，但姿势可以同时存在（掏出手机 + 吹泡泡糖，两组参数不相交），
     * 所以除了当前演的那个，其余还挂着动作的槽位要把最后一帧写回去。
     *
     * **相位接管后也要重算**：那时候用户的槽位动作已经让位，姿势就不该再保着 —— 不然
     * 会一直举着手机（用户报的"进入会话状态右手会停在手机状态"，根因就是这份名单只在
     * `chooseSlotOption` 里更新，相位走不到）。
     */
    const syncKeptPoses = (playing) => {
      const keepGroups = [];
      for (const other of petRef.current?.expressionSlots ?? []) {
        const found = motionGroupOfSlot(other.id);
        if (found !== null && found !== playing && keepGroups.indexOf(found) === -1) keepGroups.push(found);
      }
      motion.current.setKeptPoses(keepGroups);
    };

    /**
     * 把身体切到"有效选择要求的那一个动作"。
     *
     * **槽位点选和相位接管共用这一个**：相位接管时用户的槽位让位，挂在槽位上的
     * `hold + persist` 动作（掏出手机/吹泡泡糖/自拍）必须跟着交还身体 —— 不然手会一直
     * 举着手机（用户报的"进入会话状态右手会停在手机状态"）。相位接管以前不走这条，
     * 于是那只手谁也放不下来。
     */
    const syncSlotMotion = () => {
      const desired = desiredSlotMotion();
      const previous = slotMotionRef.current;
      slotMotionRef.current = desired;
      // 只在"该播的动作真的换了"时才播 —— 原来还有个 `|| option !== null`，
      // 意思是点任何表情都顺手把当前动作重播一遍。它会**重新快照**，而这时
      // 动作早就在最后一帧停着了：掏出手机之后点爱心眼，快照里的 phone 记的就是
      // 1（手机已在手里），于是"还原"忠实地把手机举着不放。
      // 用户报的"掏出手机切不到其他状态"就是这个。
      if (desired !== null && desired !== previous) {
        motion.current.playOnce(desired, 0, { kind: "slot", hold: true, persist: true });
      } else if (desired === null && previous !== null) {
        // The slot gave up its motion: hand the body back. Other slots' pins
        // are untouched, so their look survives.
        motion.current.playIdle();
      }
    };

    /**
     * 会话进行中，手点（或配对带出）某个槽位时，**同时**改掉相位的这一格。
     *
     * 相位接管着这个槽位，只改用户的选择是看不见的 —— 用户会以为"点了没反应"。
     * 覆盖只在这一场会话里有效：下一条相位消息来了就重新抽（`applyPhase` 从空开始）。
     * 装扮槽不参与（它永远归用户，相位本来也压不过它）。
     */
    const markPhaseOverride = (slotId, label) => {
      if (phaseRef.current === "idle") return;
      if (OUTFIT_SLOTS.indexOf(slotId) !== -1) return;
      phaseChoicesRef.current[slotId] = label === undefined ? null : label;
    };

    /**
     * 「同时」(pairs) 的**不变量**：把当前选择里所有配对的目标表达式补进来。
     *
     * 配对以前只是"选中那一刻"点亮一次，之后任何把它清掉的东西（摸鱼重掷、手动改目标
     * 槽位、归零）都会让配对**永久**失效 —— 用户报的"冒爱心一直出不来"就是这个：
     * 爱心眼还选中着，冒爱心却再也没人点亮它。
     *
     * 放在这里而不是 commitPins：**这是所有路径都经过的那个漏斗**（面板点选、摸鱼抽中、
     * 相位切换、归位、换宠物），只有一处的规则才不会走岔。
     *
     * 源头取**有效选择**（`effectiveSlotChoice`）：相位接管中以相位为准。
     */
    const pairPinsNow = () => {
      const pins = {};
      for (const slotId of slotByIdRef.current.keys()) {
        const label = effectiveSlotChoice(slotId);
        if (label === null || label === undefined) continue;
        for (const [targetSlot, targetLabel] of Object.entries(relationsOf(slotId, label).pairs)) {
          const target = slotByIdRef.current.get(targetSlot)?.options.find((o) => o.label === targetLabel);
          for (const name of target?.expressions ?? []) pins[name] = true;
          for (const name of target?.requires ?? []) pins[name] = true;
        }
      }
      return pins;
    };

    /**
     * 「互斥」(conflicts) 的展开表：表达式名 -> 它不能同时出现的表达式名。
     *
     * 选项之间的互斥本来只在 `chooseSlotOption` 里执行（面板点选 / 摸鱼抽中）。
     * 但 pin 还有别的来源 —— 会话相位、转圈/摸头的反应、配对补齐 —— 它们直接调用
     * `applyExpressions`，绕过那一层。实测「相位 = 完成（情绪 = 开心兴奋）」时转一圈：
     * 「晕晕」叠上去，`ParamCheek77` 与 `ParamCheek76` 同时为 1，两套眼睛一起画在脸上。
     *
     * 所以和「同时」(pairs) 一样，互斥也要放在**所有路径都经过的那个漏斗**里执行。
     * 声明本身是双向的，这里再补成对称表 —— 只写一边也不该失效。
     */
    const conflictPairs = () => {
      const map = new Map();
      const options = [];
      for (const slot of MANIFEST.current?.expressionSlots ?? []) {
        for (const option of slot.options ?? []) options.push(option);
      }
      const link = (a, b) => {
        if (a === b) return;
        if (!map.has(a)) map.set(a, new Set());
        map.get(a).add(b);
      };
      for (const option of options) {
        for (const label of option.conflicts ?? []) {
          for (const rival of options) {
            if (rival.label !== label) continue;
            for (const a of option.expressions ?? []) {
              for (const b of rival.expressions ?? []) {
                link(a, b);
                link(b, a);
              }
            }
          }
        }
      }
      return map;
    };

    /**
     * 在 pin 集合里执行互斥：**后写进集合的那个赢**（对象的键顺序就是写入顺序）。
     *
     * ⚠️ 这个函数的输出**只拿去画**，不许回写声明层（`declaredPinsRef`）。踩过的坑：
     * 一开始把互斥的结果当成下一轮的底（`pinnedRef` 既当输出又当输入），于是被顶掉的
     * 那条**从集合里消失了**，之后谁也不会把它加回来 —— 实测「相位 = 完成（开心兴奋）」
     * 时点一下「晕晕」、反应 12 秒后收回默认，相位那张脸就再也不出现，直到下一条相位
     * 消息。现在声明层留着对手，冲突解除（手点的那条被收走）时它自己就回来了。
     *
     * 同一组里谁赢：谁后写进来谁赢。合并顺序是「用户 <- 相位覆盖 <- 装扮」，而面板手点
     * 的那条是**追加在末尾**的，所以手点会临时压过相位 —— 这正是 `markPhaseOverride`
     * 要的语义（会话中手点也得看得见），且相位那一层没被销毁。
     */
    const resolveConflicts = (pins) => {
      const pairs = conflictPairs();
      if (pairs.size === 0) return pins;
      const out = {};
      for (const name of Object.keys(pins)) {
        if (pins[name] !== true) continue;
        const rivals = pairs.get(name);
        if (rivals !== undefined) for (const rival of rivals) delete out[rival];
        out[name] = true;
      }
      return out;
    };

    // The pinned expression is re-layered after every motion start: a motion
    // resets expression parameters as it takes over, so a pinned face would
    // otherwise be wiped the moment the pet plays a reaction.
    const applyExpressions = useCallback((next) => {
      // 声明层：谁要求亮了什么。**它是这一轮的输入，下一轮还要用** —— 互斥只裁剪
      // 拿去做参数写入的那份（`pinnedRef`），不能反过来把对手从这一层删掉。
      // 先补「同时」的目标、再交给互斥：两条不变量都只写在这一个漏斗里。
      const declared = Object.assign({}, next, pairPinsNow());
      declaredPinsRef.current = declared;
      const withPairs = resolveConflicts(declared);
      setPinned(withPairs);
      pinnedRef.current = withPairs;
      const model = modelRef.current;
      if (model === null) return;
      // The engine's own expression pass is deliberately NOT used, in either
      // the single or the multi case.
      //
      // Its manager holds exactly ONE expression, so pinning several would
      // render only the last. Worse, an earlier attempt to hand it a synthetic
      // merged definition made the fade start and then collapse, rendering
      // nothing at all. Writing the parameters ourselves has neither problem,
      // and it is the same arithmetic: every expression in this model blends
      // with "Add" on top of the motion output.
      //
      // Clear the engine's expression anyway, so a pin applied before this
      // change (or by another code path) cannot keep writing its own values.
      model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
    }, []);
    applyExpressionsRef.current = applyExpressions;

    /**
     * Push both pin layers to the model: the user's own choices, with the live
     * session phase layered on top.
     *
     * The phase wins while it lasts because the session is what the pet is meant
     * to be mirroring; when the phase ends its layer is emptied and the user's
     * outfit comes straight back, without having been destroyed in between.
     */
    /**
     * 装扮槽：用户"穿在身上"的东西，不是这一轮的临时效果。
     *
     * 三条规矩，都是用户定的：会话相位不动它们、归位不清它们、跨启动记住它们。
     */
    const OUTFIT_SLOTS = ["glasses", "hair", "claw", "desk", "cloth", "other"];
    /** 把当前装扮翻译成表达式 pin（相位覆盖不了它们，因为最后才合并）。 */
    const outfitPins = () => {
      const pins = {};
      for (const id of OUTFIT_SLOTS) {
        const label = slotSelectionsRef.current[id];
        if (label === undefined) continue;
        const option = effectiveOption(id, slotByIdRef.current.get(id)?.options.find((o) => o.label === label));
        for (const name of option?.expressions ?? []) pins[name] = true;
        for (const name of option?.requires ?? []) pins[name] = true;
      }
      return pins;
    };
    const saveOutfit = () => {
      // 开关关掉就既不存也不读（见设置页「装扮」那一节）。
      if (!FLAGS.outfitArchive) return;
      const out = {};
      for (const id of OUTFIT_SLOTS) {
        const label = slotSelectionsRef.current[id];
        if (label !== undefined) out[id] = label;
      }
      // 走共享落点：宿主在就写宿主（另一个窗口也能看见），顺带留一份本地兜底。
      persistShared({ outfit: out });
    };
    const readOutfit = () => {
      if (!FLAGS.outfitArchive) return null;
      try {
        const parsed = JSON.parse(storage.getItem(OUTFIT_KEY) ?? "null");
        return parsed !== null && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    };

    commitPinsRef.current = () => {
      const merged = Object.assign({}, userPinsRef.current);
      // A phase owns the slots it names. Overriding key-by-key is not enough:
      // 蛋包饭 and 画笔 are DIFFERENT expressions, so a user-chosen 蛋包饭 would
      // stay pinned through the whole session and put omurice on screen.
      for (const slotId of phaseSlotsRef.current) {
        // 装扮槽归用户：会话相位不碰眼镜/发饰/魔爪/巴菲/桌布/手机换色。
        if (OUTFIT_SLOTS.indexOf(slotId) !== -1) continue;
        const slot = slotByIdRef.current.get(slotId);
        for (const option of slot?.options ?? []) {
          for (const name of option.expressions) delete merged[name];
        }
      }
      // 「同时」(pairs) 的不变量在 applyExpressions 里统一补（那是所有路径的漏斗），
      // 这里不用再算一遍 —— 同一个规则写两处，就一定会走岔。
      // 装扮最后合并：相位即使点名了这些槽位，也压不过用户自己的选择。
      applyExpressions(Object.assign(merged, phasePinsRef.current, outfitPins()));
    };

    /**
     * Arm the auto-clear for a MANUALLY chosen expression.
     *
     * Requirement #3: a face or prop the user picked must not stay on forever.
     * Phase-driven expressions deliberately do not use this — the session
     * stream owns them and clears them when the phase changes.
     */
    const armExpressionClear = useCallback(() => {
      window.clearTimeout(expressionTimer.current);
      expressionTimer.current = window.setTimeout(() => {
        expressionTimer.current = 0;
        // Only clear if the face still is what we pinned; a later phase may
        // have replaced it already.
        // Only the user's own layer expires; a live phase owns its own face.
        if (Object.keys(userPinsRef.current).length > 0) {
          userPinsRef.current = {};
          commitPinsRef.current();
        }
      }, EXPRESSION_HOLD_MS);
    }, [applyExpressions]);

    /**
     * Show an expression for a moment without toggling it.
     *
     * Used by reactions (a head pat blushes). The panel does not toggle
     * expressions any more — every effect is a slot choice that persists — so
     * this is the only path that shows a face and hands it back on a timer.
     */
    const flashExpression = useCallback((expressionName) => {
      const next = Object.assign({}, userPinsRef.current, { [expressionName]: true });
      userPinsRef.current = next;
      commitPinsRef.current();
      armExpressionClear();
    }, [armExpressionClear]);

    /**
     * 跑一条互动反应（摸头 / 摸尾巴 / 转圈转晕）。
     *
     * **反应不该还原当前动作**：开演之前先记下她在演什么（`resumeAfter`），演完由
     * `finishAction` 接回去 —— 于是摸一下头，举着的手还举着、泡泡还在。
     *
     * 反应本身优先走"**随机换一个槽位里的选项**"（`chooseSlotOption` 那条路）：抽中的标签
     * 是某个装扮槽位的选项时，换的就是**那一格**，别的槽位与当前动作都不受影响 ——
     * 这正是用户要的"随机到哪一个插槽里的就放哪一个插槽里的"。
     *
     * 兜底两级，都不能变成"这个互动没反应"：
     *   ① 是某个槽位的选项 → 换那一格；
     *   ② 不是选项 → 当**动作组**播一次（播完接回原动作）；
     *   ③ 再不是 → 当**表达式**闪一下（闪完自动收，不占槽位）。
     */
    /**
     * 这次反应改过哪些槽位（收回默认时只动它们）。
     *
     * **必须是 ref**：`runReaction` 是 `useCallback`、计时器回调又是另一个闭包，普通 `const`
     * 每次 render 都重建、两边各持一份 —— 收回时读到的永远是空的（client-state skill 里
     * 那三次"功能正常但读数是 0"就是这个毛病）。
     */
    const reactionTouchedRef = useRef(new Set());
    /** 收回默认的计时器（同样必须是 ref：跨 render 存活）。0 = 没在计时。 */
    const reactionRevertRef = useRef(0);

    function noteReactionTouched(slotId) {
      reactionTouchedRef.current.add(slotId);
    }

    /**
     * 反应留下的槽位改动**过一会儿收回默认**（②④：摸头 / 摸尾巴 / 转晕都算）。
     *
     * 收回的是"这次反应碰过的槽位"，用 `chooseSlotOption(slot, null)` 回**默认**选项
     * （不是回上一个选择 —— 用户要的是"还原为默认"）。
     * 重复触发时重新计时：摸三下头，最后一下之后才开始数。
     */
    function armReactionRevert() {
      window.clearTimeout(reactionRevertRef.current);
      reactionRevertRef.current = window.setTimeout(() => {
        reactionRevertRef.current = 0;
        const touched = Array.from(reactionTouchedRef.current);
        reactionTouchedRef.current = new Set();
        for (const slotId of touched) {
          const slot = (petRef.current?.expressionSlots ?? []).find((candidate) => candidate.id === slotId);
          if (slot === undefined) continue;
          if (slotSelectionsRef.current[slotId] === undefined) continue;
          chooseSlotOption(slot, null, false);
        }
      }, REACTION_REVERT_MS);
    }

    /**
     * 这条反应开演前要先清掉哪些槽位（标签 → 槽位 id → 该让位的选项名单；空数组 = 全清）。
     *
     * 用户可配：`PHASE_OVERRIDES.interactions.clearSlots`。默认那一条见
     * `DEFAULT_REACTION_CLEARS`（重锤出击 vs 晕晕/呆呆眼 + 开心兴奋/闭眼口水）。
     */
    function reactionClears(label) {
      const user = PHASE_OVERRIDES.interactions?.clearSlots?.[label];
      if (user !== undefined && user !== null && typeof user === "object") return user;
      const declared = MANIFEST.current?.reactionClears?.[label];
      if (declared !== undefined && declared !== null && typeof declared === "object") return declared;
      return DEFAULT_REACTION_CLEARS[label] ?? {};
    }

    /**
     * 跑一条互动反应（摸头 / 摸尾巴 / 转圈转晕）。
     *
     * **反应不该还原当前动作**：开演之前先记下她在演什么（`resumeAfter`），演完由
     * `finishAction` 接回去 —— 于是摸一下头，举着的手还举着、泡泡还在。
     *
     * 反应本身优先走"**随机换一个槽位里的选项**"（`chooseSlotOption` 那条路）：抽中的标签
     * 是某个装扮槽位的选项时，换的就是**那一格**，别的槽位与当前动作都不受影响 ——
     * 这正是用户要的"随机到哪一个插槽里的就放哪一个插槽里的"。
     *
     * 兜底两级，都不能变成"这个互动没反应"：
     *   ① 是某个槽位的选项 → 换那一格；
     *   ② 不是选项 → 当**动作组**播一次（播完接回原动作）；
     *   ③ 再不是 → 当**表达式**闪一下（闪完自动收，不占槽位）。
     */
    const runReaction = useCallback((label) => {
      if (typeof label !== "string" || label === "") return false;
      // ①' 声明式的"先清掉"：动作只写手臂参数时，留着眼部/情绪会画出"晕乎乎的人在挥锤"。
      const clears = reactionClears(label);
      for (const slotId of Object.keys(clears)) {
        const slot = (petRef.current?.expressionSlots ?? []).find((candidate) => candidate.id === slotId);
        if (slot === undefined) continue;
        const current = slotSelectionsRef.current[slotId];
        if (current === undefined) continue;
        const labels = clears[slotId];
        // 空数组 = 清掉这一格；非空 = 只清列出来的那几个选项（当前选择不在名单里就不动）。
        if (Array.isArray(labels) && labels.length > 0 && !labels.includes(current)) continue;
        chooseSlotOption(slot, null, false);
        noteReactionTouched(slotId);
      }
      // ① 抽中的标签落在某个装扮槽位里：换掉那一格。
      for (const slot of petRef.current?.expressionSlots ?? []) {
        const option = (slot.options ?? []).find((candidate) => candidate.label === label);
        if (option !== undefined) {
          // `satisfy = true`：手动互动等同于用户自己点它（前提由插件补齐，比如点自拍会
          // 先把手机掏出来）。自动路径（摸鱼/相位）才不能补。
          chooseSlotOption(slot, option, true);
          noteReactionTouched(slot.id);
          armReactionRevert();
          return true;
        }
      }
      // ② 不是槽位选项：当**动作组**播一次。这一段是临时表演，记下当前动作、演完接回去。
      motion.current.resumeAfter(previousMotionPlan());
      const groups = motion.current.groups();
      const entry = (petRef.current?.motions ?? []).find((item) => item.label === label);
      const group = entry !== undefined && Array.isArray(groups[entry.group]) ? entry.group : undefined;
      if (group !== undefined) {
        motion.current.playOnce(group, 0, { kind: "tap" });
        armReactionRevert();
        return true;
      }
      if (Array.isArray(groups[label])) {
        motion.current.playOnce(label, 0, { kind: "tap" });
        armReactionRevert();
        return true;
      }
      // ③ 当成表达式闪一下。表达式不碰身体，所以刚才那份"接回"要撤掉（否则会空接一次）。
      motion.current.resumeAfter(null);
      flashExpression(label);
      armReactionRevert();
      return true;
    }, [chooseSlotOption, flashExpression]);

    /**
     * 她现在演的是什么（用于"反应演完接回来"）。
     *
     * 只认**槽位动作**：`currentGroup` 是引擎当前的动作组，而它的选项在 `expressionSlots`
     * 里按标签反查 —— 拿到**同一个选项**才能把 `persist` / `hold` 原样带回去（举着的手
     * 靠 `persist` 才不会被看门狗放下）。查不到就返回 null（回待机，和以前一样）。
     *
     * ⚠️ 刻意用**函数声明**：`runReaction` 在上面就要用它，`const` 会 TDZ（和
     * `chooseSlotOption` 同一个理由）。
     */
    function previousMotionPlan() {
      const group = motion.current.currentGroup();
      if (typeof group !== "string" || group === "" || group === "Idle") return null;
      for (const slot of petRef.current?.expressionSlots ?? []) {
        for (const option of slot.options ?? []) {
          if (option.motion !== group) continue;
          return {
            group,
            index: 0,
            options: { kind: "slot", hold: true, persist: true },
          };
        }
      }
      return null;
    }
    runReactionRef.current = runReaction;

    /**
     * Choose an option within one dress-up slot.
     *
     * Every other slot keeps its choice — that is the whole point of the slots,
     * and it works because the controller layers the parameter writes instead
     * of asking the engine (which holds a single expression) to switch.
     * The 'none' option clears just this slot.
     */
    /** Latest pet, for callbacks that must not re-subscribe on every catalog change. */
    const petRef = useRef(undefined);
    petRef.current = pet;
    const chooseSlotOptionRef = useRef(() => {});
    /**
     * @param {boolean} satisfy 手动点选时传 true：前提由插件补齐（点自拍会先把手机
     *   掏出来）。摸鱼/相位这些自动路径**不能**传 —— 那会绕过用户配的权重，
     *   变成"她自己去掏手机再拍照"。
     *
     * ⚠️ 这里刻意用**函数声明**（不是 `const … = useCallback`）：`runReaction` 在上面、
     * 又要调它（互动反应 = 换一个槽位的选项）。`const` 有 TDZ，首次渲染就会
     * "Cannot access before initialization"；函数声明会提升，所以顺序随便放。
     */
    function chooseSlotOption(slot, option, satisfy) {
      // 关系（同时 / 前提）是按**选项**生效的：用户在这里改过的内容必须对面板点选、
      // 摸鱼抽中、相位抽中同时成立，所以统一在这一个入口合成。
      option = effectiveOption(slot.id, option);
      // 手动选中一个**带动作**的选项时，前提由插件替用户补上 —— 跟表达式那套 requires
      // 一致（点「挤番茄酱」会把蛋包饭端上来）。否则点「自拍」而手机没在手，动作会被
      // 守卫拦掉，面板显示已选中、画面纹丝不动（静默无效，正是之前那串 bug 的同一类）。
      //
      // 补的时候直接走这个入口（于是它会先把「掏出手机」选上、播出来），再回到下面的
      // 正文 —— 正文里的动作归属会把"最后点的这个"记为当前动作，所以自拍照样会播，
      // 而手机靠"保住别的槽位的姿势"留在手里。
      if (satisfy === true && option !== null && typeof option.motion === "string") {
        for (const need of motionRequiresFor(option.motion)) {
          if (slotSelectionsRef.current[need.slot] === need.label) continue;
          const target = (petRef.current?.expressionSlots ?? []).find((candidate) => candidate.id === need.slot);
          const picked = target?.options.find((candidate) => candidate.label === need.label);
          if (target !== undefined && picked !== undefined) chooseSlotOptionRef.current(target, picked, true);
        }
      }
      // 从**声明层**起算，不是从互斥之后的输出起算：后者已经少了被顶掉的对手，
      // 于是"再点一次原来那条"永远回不来（相位脸就是这么丢的）。
      const next = Object.assign({}, declaredPinsRef.current);
      for (const candidate of slot.options) {
        for (const name of candidate.expressions) delete next[name];
      }
      if (option !== null) {
        for (const name of option.expressions) next[name] = true;
        // 'requires' are forced on even when another slot owns them: 挤番茄酱 is a
        // right-hand action whose 蛋包饭 base lives in the left-hand slot. The
        // panel then shows that slot as 蛋包饭 because the pin is there, not
        // because this code touched the slot.
        for (const name of option.requires ?? []) next[name] = true;
      }
      // 'pairs' and 'breaks' reach across slots, so they are resolved here rather
      // than in the fidget: choosing 喵喵手 from the PANEL must pull the cat
      // sticker in just the same, and choosing any other hand pose must take it
      // off. Both loop until stable, so a pair that triggers another settles.
      if (option !== null || option === null) {
        const slots = petRef.current?.expressionSlots ?? [];
        const applyLabel = (slotId, label, wanted) => {
          const target = slots.find((s) => s.id === slotId);
          if (target === undefined) return;
          for (const candidate of target.options) {
            // Only the NAMED option is turned on. This used to set every option's
            // expressions when wanted was true, so pairing 爱心眼 -> 冒爱心 also
            // switched on 心跳 and 情绪花花: three ambient effects at once.
            const isNamed = wanted && candidate.label === label;
            for (const name of candidate.expressions) {
              if (isNamed) next[name] = true;
              else delete next[name];
            }
            if (!isNamed) for (const name of candidate.requires ?? []) delete next[name];
          }
          const chosen = Object.assign({}, slotSelectionsRef.current);
          if (wanted) chosen[slotId] = label;
          else delete chosen[slotId];
          slotSelectionsRef.current = chosen;
          markPhaseOverride(slotId, wanted ? label : null);
      saveOutfit();
          if (!wanted && typeof target.options.find((o) => o.label === label)?.motion === "string") {
            slotMotionRef.current = null;
            // 配对撤销掉的如果正是"动作归属者"，归属也要交出去。
            if (motionOwnerRef.current === slotId) motionOwnerRef.current = null;
          }
        };
        // Choosing "none" applies the slot's UNION of breaks: leaving the hand
        // empty must take the cat sticker off just as any other hand pose does,
        // otherwise the sticker stays on with no cat paws to justify it.
        // Undo whatever this slot's PREVIOUS option paired in. Choosing 爱心眼
        // pulls 冒爱心 in; going back to 默认 eyes has to let it go again.
        const previousLabel = slotSelectionsRef.current[slot.id];
        if (previousLabel !== undefined) {
          const previous = slot.options.find((o) => o.label === previousLabel);
          for (const pairedId of Object.keys(previous?.pairs ?? {})) applyLabel(pairedId, "", false);
        }
        const sources = option === null
          ? slot.options
          : [option];
        for (const source of sources) {
          for (const [slotId, label] of Object.entries(source.pairs ?? {})) {
            if (option !== null) applyLabel(slotId, label, true);
          }
          for (const label of source.breaks ?? []) {
            for (const other of slots) {
              if (other.options.some((o) => o.label === label)) applyLabel(other.id, label, false);
            }
          }
        }
      }
      // An option may name labels it cannot coexist with. Nothing in the engine
      // enforces this: 吐魂 and 吹泡泡糖 write disjoint parameters, so both would
      // simply render — one mouth doing two things. Declared symmetrically on
      // both sides, so picking either drops the other, including its motion.
      if (option !== null) {
        for (const label of option.conflicts ?? []) {
          for (const other of petRef.current?.expressionSlots ?? []) {
            const rival = other.options.find((o) => o.label === label);
            if (rival === undefined) continue;
            if (slotSelectionsRef.current[other.id] !== label) continue;
            for (const candidate of other.options) {
              for (const name of candidate.expressions) delete next[name];
              for (const name of candidate.requires ?? []) delete next[name];
            }
            // Deleted IN PLACE: the code below re-reads this ref to record the
            // new choice, so replacing it with a copy here would simply be
            // overwritten and the rival would come straight back.
            delete slotSelectionsRef.current[other.id];
            if (typeof rival.motion === "string" && slotMotionRef.current === rival.motion) {
              slotMotionRef.current = null;
            }
          }
        }
      }
      // A 'clears' option needs other slots emptied first (写本本 wants the left
      // hand free), so drop their expressions before applying this one.
      if (option !== null) {
        for (const slotId of option.clears ?? []) {
          const target = (petRef.current?.expressionSlots ?? []).find((s) => s.id === slotId);
          for (const candidate of target?.options ?? []) {
            for (const name of candidate.expressions) delete next[name];
            for (const name of candidate.requires ?? []) delete next[name];
          }
        }
      }
      // **先更新选择，再推 pin**。反过来的话，applyExpressions 里的配对不同步会读到
      // 旧状态：把眼部切回「默认」时，源头看起来还是爱心眼，于是配对又把冒爱心补回来
      // —— 表现是"切回普通眼，氛围却回不去"（cdp-exp 抓到过这条）。
      const chosen = Object.assign({}, slotSelectionsRef.current);
      if (option === null) delete chosen[slot.id];
      else chosen[slot.id] = option.label;
      slotSelectionsRef.current = chosen;
      // 会话进行中点的：相位正接管着这个槽位，只改用户选择是**看不见的** —— 同时把
      // 相位的这一格也改掉（只在这一场会话里有效，下一条相位消息来了就重抽）。
      markPhaseOverride(slot.id, option === null ? null : option.label);
      applyExpressions(next);
      // A motion attached to a slot plays and PARKS on its last frame, so the
      // chosen look stays put instead of dropping back to the idle loop.
      saveOutfit();
      // The body follows whichever slot currently holds a motion option, worked
      // out from the selections rather than remembered. Remembering only the
      // LAST motion meant 掏出手机 -> 喵喵手 (a motion option to a plain
      // expression) left the phone parked forever: the new option starts no
      // motion, and nothing stopped the old one either — so the right hand was
      // stuck on the phone and no later draw could change it.
      if (option === null || option.sweep === undefined) userSweepRef.current = null;
      else userSweepRef.current = option.sweep;
      applySweep();
      // 身体只有一个动作。**最后点的那个槽位**优先（见 motionOwnerRef），它不再是动作
      // 选项时回退到扫描 —— 规则收在 `desiredSlotMotion()` 里，相位接管走的是同一个。
      //
      // 先把归属改掉，再算 desired：否则"刚点的这个"要等下一次点击才生效。
      if (option !== null && typeof option.motion === "string") motionOwnerRef.current = slot.id;
      else if (motionOwnerRef.current === slot.id) motionOwnerRef.current = null;
      const desired = desiredSlotMotion();
      // 身体只有一个动作，但**姿势可以同时存在**：别的槽位还选着动作时，替它们把最后
      // 一帧的姿势写回去（掏出手机 + 吹泡泡糖，两组参数不相交）。清掉那个槽位就等于把
      // 它从名单里去掉，它写过的手会交还出去。
      syncKeptPoses(desired);
      syncSlotMotion();
      // A dress-up choice PERSISTS. The auto-clear exists so a reaction or a
      // session phase cannot leave the pet stuck, but an outfit is an explicit
      // choice the user reverses from this panel (or with 归位), and expiring it
      // after a few seconds would make the panel feel broken.
      window.clearTimeout(expressionTimer.current);
    }

    // The fidget effect below subscribes on a different dependency list, so it
    // reaches the chooser through a ref. Without this assignment the ref keeps
    // its no-op default and every fidget silently does nothing at all.
    chooseSlotOptionRef.current = chooseSlotOption;

    const resetAll = useCallback(() => {
      window.clearTimeout(expressionTimer.current);
      userPinsRef.current = {};
      phasePinsRef.current = {};
      // 归位不动装扮：那六件是用户穿在身上的，不是这一轮的临时效果。
      // 表达式 pin 会被 outfitPins() 在 commit 时重新合并回去。
      const keepOutfit = {};
      for (const id of OUTFIT_SLOTS) {
        const label = slotSelectionsRef.current[id];
        if (label !== undefined) keepOutfit[id] = label;
      }
      slotSelectionsRef.current = keepOutfit;
      // 归位清掉了所有非装扮槽位 → 动作归属也可能一起没了，交回给扫描。
      if (motionOwnerRef.current !== null && keepOutfit[motionOwnerRef.current] === undefined) {
        motionOwnerRef.current = null;
      }
      commitPinsRef.current();
      motion.current.resetToRest();
      say(pick(linesNow().reset));
    }, [applyExpressions, say]);

    /**
     * 启动时把上次的装扮穿回来。
     *
     * 放在 ready 之后：那时 catalog 已经填好 slotByIdRef，能校验存档里的
     * label 在当前 pet.json 里还存在（换模型/改配置之后存档可能对不上，
     * 对不上就当没存过，不要凭空造一个选项出来）。
     */
    const outfitRestoredRef = useRef(false);
    /**
     * 把一份装扮存档应用到槽位上（**同一份清洗逻辑**，两个入口共用）。
     *
     * 两个入口：① 启动时读本地存档；② 模块级的轮询从宿主拉回"另一个窗口改的那份"。
     * 校验必须一致 —— 写两份的话，一边校验一边不校验，就会出现"某个窗口能存进去、
     * 另一个窗口把它丢掉"的怪现象。
     */
    const applyOutfit = (saved) => {
      if (saved === null || typeof saved !== "object") return false;
      if (slotByIdRef.current.size === 0) return false;
      const chosen = Object.assign({}, slotSelectionsRef.current);
      let restored = false;
      for (const id of OUTFIT_SLOTS) {
        const label = saved[id];
        if (typeof label !== "string") continue;
        if (slotByIdRef.current.get(id)?.options.some((o) => o.label === label) !== true) continue;
        chosen[id] = label;
        restored = true;
      }
      if (!restored) return false;
      slotSelectionsRef.current = chosen;
      commitPinsRef.current();
      return true;
    };
    // 挂上模块级的桥：宿主的改动由轮询拉回来后走这里（见 applyOutfitRef 的注释）。
    applyOutfitRef.current = applyOutfit;

    useEffect(() => {
      if (outfitRestoredRef.current || !ready) return;
      if (slotByIdRef.current.size === 0) return;
      outfitRestoredRef.current = true;
      applyOutfit(readOutfit());
    }, [ready]);

    // ---- session activity (#4) -----------------------------------------
    // The host pushes the agent's coarse phase over same-origin SSE; each
    // transition drives a motion + expression so the pet visibly follows what
    // the assistant is doing. EventSource reconnects on its own.
    useEffect(() => {
      if (!ready || typeof window.EventSource === "undefined") return undefined;
      let source;
      try {
        source = new window.EventSource(API + "/events");
      } catch {
        return undefined;
      }
      /**
       * 一个相位的**抽签**：每个槽位在自己的池子里各掷一次，和摸鱼同一套。
       *
       * 用户的原话是"相位跟摸鱼是一样的功能"，所以数据结构和抽法都照搬摸鱼：
       *   - 每个槽位一张条目表，条目有权重；权重 0 / 被删掉的条目不参与；
       *   - 抽中的条目把它自己的表情点亮，并且**先把 `pairs` 一起点亮**；
       *   - `requires` 是"播放的前提"：前提不成立的条目不参与这一轮抽（跳过）。
       *
       * 前提可能要靠**别的槽位这一轮的选择**才成立（挤番茄酱 要 蛋包饭），所以抽到
       * 稳定为止：第一轮把没有前提、或前提已经成立的槽位抽出来，第二轮再看剩下的，
       * 三轮不动就收手。
       */
      const applyPhase = (phase) => {
        // 相位名记在这里（而不是只记在 SSE 回调里）：`effectiveSlotChoice` 靠它判断
        // "会话进行中"，而诊断读口 `phaseNow()` 是直接调这个函数的 —— 分开写的话，
        // 诊断走的相位不会让槽位让位，测出来的行为跟真实路径不一样。
        phaseRef.current = phase;
        const slotById = new Map((pet?.expressionSlots ?? []).map((slot) => [slot.id, slot]));
        const pools = phasePoolsFor(phase);
        // 从**空**开始，而不是继承上一个相位的答案：相位是接管，不是叠加。
        // 每个槽位在抽中之前都还不归相位管，问"现在是什么"就退回用户自己的选择。
        phaseChoicesRef.current = {};
        const chosen = {};
        const optionAt = (slotId, label) =>
          effectiveOption(slotId, slotById.get(slotId)?.options.find((o) => o.label === label));
        // 一个槽位此刻"是什么"：这一轮已经抽中的优先，其次用户自己的选择。
        // 抽空的槽位记成 null —— 那时候不能退回用户的选择（相位说了这里空着）。
        const owns = (slotId) => Object.prototype.hasOwnProperty.call(chosen, slotId);
        const current = (slotId) => (owns(slotId) ? chosen[slotId] : slotSelectionsRef.current[slotId]);
        const premiseOk = (row) => {
          const want = row.label;
          if (row.slot === null || row.slot === undefined) {
            // 没指明槽位的前提：任意一个槽位此刻是它就算成立。
            return (MANIFEST.current?.expressionSlots ?? []).some((slot) => current(slot.id) === want);
          }
          return current(row.slot) === want;
        };
        const take = (slotId, option) => {
          chosen[slotId] = option === null ? null : option.label;
          if (option === null) return;
          // 「同时」：抽中它就把配对的槽位一起点亮。配对只是**填空**：那个槽位自己
          // 的池子随后抽中的结果优先，用户手选的那些也在下一轮被相位接管。
          for (const [targetSlot, label] of Object.entries(option.pairs ?? {})) {
            if (owns(targetSlot)) continue;
            const target = slotById.get(targetSlot);
            if (target === undefined) continue;
            if (!(target.options ?? []).some((item) => item.label === label)) continue;
            chosen[targetSlot] = label;
          }
          // 抽一步就把这一轮的答案同步给守卫（canPlay 读的是这里），否则下一轮
          // 判断"自拍能不能播"看的还是上一个相位的选择。
          phaseChoicesRef.current = Object.assign({}, chosen);
        };
        const pending = Object.keys(pools);
        for (let round = 0; round < 3 && pending.length > 0; round += 1) {
          let progressed = false;
          for (const slotId of pending.slice()) {
            const slot = slotById.get(slotId);
            if (slot === undefined) {
              pending.splice(pending.indexOf(slotId), 1);
              continue;
            }
            const rows = [];
            for (const entry of pools[slotId] ?? []) {
              if (!(entry.weight > 0)) continue;
              if (entry.label === null || entry.label === undefined) {
                // 「空着」：这个相位明确要求这个槽位不放东西。
                rows.push({ entry, option: null });
                continue;
              }
              const option = optionAt(slotId, entry.label);
              if (option === undefined) continue;
              // 动作的前提（自拍要手机、喷水要鲸鱼）走引擎那套守卫；表达式的前提
              // 走条目关系。两者都不是"先放上去再说"，放不出来的就不进池子。
              if (typeof option.motion === "string" && !motion.current.canPlay(option.motion)) continue;
              if (!relationsOf(slotId, option.label).requires.every(premiseOk)) continue;
              rows.push({ entry, option });
            }
            // 这一轮没有能抽的：留到下一轮（可能被别的槽位的前提解开）。
            if (rows.length === 0) continue;
            let total = 0;
            for (const row of rows) total += row.entry.weight;
            let roll = Math.random() * total;
            let picked = rows[rows.length - 1];
            for (const row of rows) {
              roll -= row.entry.weight;
              if (roll <= 0) { picked = row; break; }
            }
            take(slotId, picked.option);
            pending.splice(pending.indexOf(slotId), 1);
            progressed = true;
          }
          if (!progressed) break;
        }
        const pins = {};
        let sweep = null;
        for (const [slotId, label] of Object.entries(chosen)) {
          if (label === null || label === undefined) continue;
          const option = optionAt(slotId, label);
          if (option === undefined) continue;
          for (const name of option.expressions ?? []) pins[name] = true;
          for (const name of option.requires ?? []) pins[name] = true;
          if (option.sweep !== undefined) sweep = option.sweep;
        }
        // 抽屉数：和摸鱼的 tally 一样，用来判断"池子真的在随机"而不是每次都同一套。
        const tally = phaseTallyRef.current[phase] ?? (phaseTallyRef.current[phase] = {});
        for (const [slotId, label] of Object.entries(chosen)) {
          const key = slotId + ":" + (label === null || label === undefined ? "无" : label);
          tally[key] = (tally[key] ?? 0) + 1;
        }
        phasePinsRef.current = pins;
        // 只有**真的抽到了东西**的槽位才归相位管：池子里一条都放不出来时不接管，
        // 用户自己的选择留着（和摸鱼里"池子空了的槽位不参与"是同一条规矩）。
        phaseSlotsRef.current = Object.keys(chosen);
        phaseChoicesRef.current = Object.assign({}, chosen);
        phaseSweepRef.current = sweep;
        applySweep();
        commitPinsRef.current();
        // 池子里抽到动作就用它；没抽到就退回这个相位在 pet.json 里的动作
        // （done 吹泡泡糖、failed 鲸鱼喷水都是这么来的）。
        let group = phaseMotionRef.current[phase];
        for (const [slotId, label] of Object.entries(chosen)) {
          if (label === null || label === undefined) continue;
          const option = optionAt(slotId, label);
          if (typeof option?.motion === "string") group = option.motion;
        }
        phaseGroupRef.current[phase] = group;
        phasePoolsRev.current = JSON.stringify(pools);
        // 相位接管后重算"替谁保姿势"：用户那套槽位动作已经让位，姿势就不该再保着，
        // 否则手会一直举着手机。名单过去只在 chooseSlotOption 里更新，相位走不到。
        syncKeptPoses(group);
        const sustained = PHASE_SUSTAIN.indexOf(phase) !== -1;
        if (phase === "idle" || group === undefined) {
          // No motion for this phase: stop sustaining and return to rest.
          motion.current.setSustain(null);
          motion.current.playIdle();
        } else {
          const groups = motion.current.groups();
          if (Array.isArray(groups[group])) {
            motion.current.setSustain(sustained ? phase : null);
            motion.current.playOnce(group, 0, { kind: "phase" });
          } else {
            motion.current.setSustain(null);
          }
        }
        const expression = phaseExpressionRef.current[phase];
        if (expression !== undefined) {
          phasePinsRef.current[expression] = true;
          commitPinsRef.current();
        }
        // 相位台词（pet.json 的 `lines.phase.<相位>`，用户可在设置里改）。
        // 空字符串 = 这个相位不弹（idle 就没有），所以这里只是"有才弹"。
        const line = linesNow().phase[phase] ?? "";
        if (line !== "") say(line);
      };
      // The sustain loop lives in the controller, but the phase -> group map
      // comes from the pet manifest, so hand the resolver over. 池子里抽到过动作的
      // 相位优先用它自己那一轮的结果，否则重播的会是另一套动作。
      motion.current.setPhaseResolver((phase) => phaseGroupRef.current[phase] ?? phaseMotionRef.current[phase]);
      // Premise check for a motion group. Evaluated against the CURRENT slot
      // selections, so it stays true while the look keeps the phone out and goes
      // false the moment the slot changes.
      motion.current.setGuardResolver((group) => {
        const holds = (slotId, labels) => {
          const chosen = effectiveSlotChoice(slotId);
          return chosen !== undefined && chosen !== null && labels.includes(chosen);
        };
        const guard = guardsRef.current[group];
        if (guard !== undefined && !Object.entries(guard).every(([slotId, labels]) => holds(slotId, labels))) {
          return false;
        }
        // 选项上的「前提」也算数。以前只有 pet.json 的 motionGuards 进得来，UI 里加的
        // 前提对动作**根本没生效** —— 用户给「自拍」加了「前提：右手=掏出手机」，
        // 摸鱼照样先比耶再拍照。
        for (const need of motionRequiresFor(group)) {
          if (!holds(need.slot, [need.label])) return false;
        }
        return true;
      });
      // The motion subscription (declared above) flushes a deferred phase here.
      flushPhaseRef.current = applyPhase;
      let receivedInitialPhase = false;
      const onMessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        const phase = payload?.phase;
        if (typeof phase !== "string") return;
        const initial = !receivedInitialPhase;
        receivedInitialPhase = true;
        setPhaseState(phase);
        if (phase === phaseRef.current) return;
        phaseRef.current = phase;
        // 只提示真正的新相位；首次 SSE 快照和相同相位重发都不响。
        //
        // 还要看"是不是我在显示"：页面与桌面窗口各收一份 SSE，两边都响就是每次响两遍
        // （issue #7）。这里读模块级 `layerStore`，**不能**读本 effect 闭包里的 `layer`
        // —— 依赖只有 [ready, applyExpressions]，闭包里那个 `layer` 是挂载时的旧值，
        // 会让让位永远慢一拍。
        if (!initial && isPhaseSoundOwner(layerStore.value.owner)) playPhaseSound(phase);
        // A phase animation may replace another phase animation, but must never
        // cut off something the user just triggered (tap / fidget / panel).
        const owner = motion.current.kind();
        if (motion.current.isPlaying() && owner !== "phase") {
          // Defer rather than drop: onDeferRedPhase re-applies it once the
          // current animation finishes, so the mirror never goes stale.
          pendingPhase.current = phase;
          return;
        }
        applyPhase(phase);
      };
      // A phase that persists would otherwise be re-applied after every
      // reaction; the ref remembers where we are so refires are no-ops.
      source.addEventListener("message", onMessage);
      return () => {
        source.close();
        stopUploadedSound();
        phaseRef.current = "idle";
        phasePinsRef.current = {};
        phaseSlotsRef.current = [];
        phaseChoicesRef.current = {};
        phaseSweepRef.current = null;
        applySweep();
        commitPinsRef.current();
        // A dropped stream must not leave the pet sustaining a phase forever.
        motion.current.setSustain(null);
        motion.current.setPhaseResolver(null);
      };
    }, [ready, applyExpressions]);

    // ---- idle fidget (#6) ----------------------------------------------
    // After the pet has been left alone for a while it picks one or two SLOT
    // options at random — a hand pose, a mood, a blush, a mouth — and KEEPS
    // them. A 摸鱼 is the pet changing what it is doing, not a brief animation
    // that snaps back: the next fidget switches again from wherever this one
    // left off, and the look drifts while nobody is watching.
    //
    // It goes through the ordinary slot path, so a fidget choice is
    // indistinguishable from one the user made — same pins, same parked motion,
    // same sweep — and the panel highlights it.
    //
    // It never fires while a session phase is live: the pet is following the
    // assistant then, and the phase's look is fixed. A random fidget would read
    // as the pet losing track of the conversation.
    useEffect(() => {
      if (!ready) return undefined;
      let timer = 0;
      const schedule = () => {
        window.clearTimeout(timer);
        // 间隔取自 TUNING（设置页「摸鱼节奏」那一组）。
        const wait = TUNING.fidgetQuietMs + Math.random() * Math.max(0, TUNING.fidgetGapMs - TUNING.fidgetQuietMs);
        timer = window.setTimeout(fire, wait);
      };
      const fire = (force = false) => {
        // A forced call always runs; the SCHEDULED one honours the switch. Tests
        // turn it off for long drivers: a 摸鱼 every 12-26s rewrites the very slot
        // selections a slow assertion is watching, which made four drivers look
        // broken under parallel load and pass when run alone.
        if (!force && !fidgetEnabledRef.current) { schedule(); return; }
        fidgetTallyRef.current.fired = (fidgetTallyRef.current.fired ?? 0) + 1;
        const quietFor = Date.now() - lastInteraction.current;
        const busy = motion.current.isPlaying() || dragState.current !== null;
        // 'fixed' means a session owns the look; leave it alone. A forced call
        // (the diagnostic, and the tests) skips the idle gate — otherwise the
        // trigger is unreachable for the first 12 seconds and looks broken.
        if (!force && (busy || quietFor < TUNING.fidgetQuietMs || phaseRef.current !== "idle")) {
          schedule();
          return;
        }
        const slots = fidgetSlotsFor(pet);
        if (slots.length === 0) {
          schedule();
          return;
        }
        lastInteraction.current = Date.now();
        // Options that may come up at all: a motion whose premise is missing is
        // out (a selfie with no phone would set the pins and play nothing).
        // 条目表 -> 可用的 (选项|null, 权重) 对。
        // 权重 0 或条目被删掉 = 不参与；动作前提不满足（比如没有蛋包饭就挤不了番茄酱）
        // 也在这一刻过滤掉。
        //
        // 这里**不再**过滤 `option.fidget === false`：那个标记现在只用来决定"默认池子
        // 里有没有它"（见 fidgetEntriesFor）。用户手动把它加进池子，就该按他说的算 ——
        // 否则界面上加得进去、运行时永远抽不到，那才是真的莫名其妙。
        const entriesOf = (slot) => {
          const out = [];
          for (const entry of fidgetEntriesFor(slot)) {
            if (!(entry.weight > 0)) continue;
            if (entry.label === null || entry.label === undefined) {
              out.push([null, entry.weight]);
              continue;
            }
            const option = (slot.options ?? []).find((o) => o.label === entry.label);
            if (option === undefined) continue;
            if (typeof option.motion === "string" && !motion.current.canPlay(option.motion)) continue;
            out.push([option, entry.weight]);
          }
          return out;
        };
        // Weighted draw over the entries (选项 | 「默认」) — see `draw`.
        const draw = (slot) => {
          // 条目已经是 (选项|null, 权重)，直接加权抽 —— 增删条目就是改池子本身。
          const entries = entriesOf(slot);
          if (entries.length === 0) return null;
          let total = 0;
          for (const [, w] of entries) total += w;
          let roll = Math.random() * total;
          for (const [option, w] of entries) {
            roll -= w;
            if (roll <= 0) return option;
          }
          return entries[entries.length - 1][0];
        };
        // 只要池子里还有**有份量的东西**就参与抽签。注意「默认」本身算数：它就是"回到
        // 默认"，一个只剩「默认」的池子仍然要掷 —— 否则用户把选项权重都压到 0 之后，
        // 那个槽位就再也不会被清空（曾经用 `usable()` 过滤掉纯「默认」池，正是这个坑）。
        const pool = slots.filter((slot) => entriesOf(slot).length > 0);
        fidgetTallyRef.current.poolSize = slots.length + "/" + pool.length;
        if (pool.length === 0) { schedule(); return; }
        // 每个池子各自 roll 一次 —— 手部、情绪、脸红、嘴、眼睛**同时**摇，
        // 而不是"这次只摇一两个槽位"。用户要的是每次摸鱼都重新掷一遍所有池子，
        // 组合出来的样子才会变；只摇一个的话，其余槽位永远停在上一次的结果上，
        // 摸鱼看起来就总是同一套。
        // "默认"（这次不动）仍然由各槽位自己的 fidgetNone 权重决定（嘴 8、眼 11…），
        // 所以这不是"每次都全变"，而是"每次每个池子都掷一次骰子"。
        const changes = pool.map((slot) => [slot, draw(slot)]);
        // A fidget should still be MOVEMENT. If the weighted draw left everything
        // alone, force one HAND slot that can play a motion — the hands are where
        // the pet's actions live, and forcing the mouth would defeat the point of
        // weighting it.
        // NO "make sure something happens" fallback. There used to be one, and
        // it fired on 82% of draws — overriding the very weights that decide how
        // often each slot should move, and collapsing the pet onto whichever
        // option happened to be the only lively one. The weights alone control
        // the mix now; fidgetNone is the knob for "how often does this slot
        // move at all".
        // 这里原来还有一条**隐藏**的自动自拍：手机在手时，40% 的摸鱼会顺手拍一张
        // （`SELFIE_CHANCE` + 一个 `__selfie__` 伪条目，`slot === null` 那条分支）。
        //
        // 自拍变成独立槽位之后它就是残留了 —— 用户明确问过"是不是有以前的残留代码会
        // 调自拍和快速自拍"。现在自拍只有一条路：**槽位**。池子里配了就按池子抽，
        // 没配就不拍，不再有"明明没配它却自己拍了一张"。
        for (const [slot, option] of changes) {
          fidgetTallyRef.current.picked[slot.id] = (fidgetTallyRef.current.picked[slot.id] ?? 0) + 1;
          const key = slot.id + ":" + (option === null ? "无" : option.label);
          fidgetTallyRef.current.drawn[key] = (fidgetTallyRef.current.drawn[key] ?? 0) + 1;
          // 抽到「默认」= **回到默认**（把这个槽位清成 none），不是"这次不动"。
          //
          // 曾经把它改成"不动"（为了修"摸鱼把用户手选的爱心眼擦掉"），结果制造了一个更
          // 糟的坑：**掷中过的选项再也回不去**。用户拿 `默认 10 : 脸红 1` 的池子证明给我
          // 看 —— 脸红一旦被掷中（1/11）就一直挂在脸上，因为"不动"永远不会关掉它。
          //
          // 现在语义回到"清空"，配对那边由 applyExpressions 的不变量兜着：爱心眼还在
          // 选中，冒爱心就不会丢；眼睛被掷回默认，冒爱心跟着走（那本来就是配对的意思）。
          if (option !== null && typeof option.motion === "string"
            && !motion.current.canPlay(option.motion)) {
            // **应用前再查一遍前提**：所有池子都是按"这一轮开始前"的状态掷的，右手掷成
            // 比耶之后，自拍的前提其实已经不成立了 —— 不再查就会"先比耶、再拍照"
            // （用户报的"我设置了拍照的前提是右手手机，为什么还会出现右手比耶然后拍照"）。
            continue;
          }
          chooseSlotOptionRef.current(slot, option);
        }
        schedule();
      };
      fidgetLiveRef.current = true;
      fidgetRef.current = () => fire(true);
      schedule();
      return () => window.clearTimeout(timer);
    }, [ready, pet]);

    // ---- click + drag -------------------------------------------------
    // Interaction bookkeeping lives above the effects that read it, so the
    // idle-fidget scheduler can tell "left alone" from "being handled".
    const dragState = useRef(null);
    // 诊断读口：按住那一刻路由用的三个答案（尾鳍点不到这类问题要能直接看见它们，
    // 而不是从"她说了什么"倒推）。
    const lastPressRef = useRef(null);

    // Last time the user touched the pet; the idle-fidget timer (#6) measures
    // quiet time from here so a fidget never fires under the user's cursor.
    const lastInteraction = useRef(Date.now());
    // Auto-clear timer for a manually pinned expression (requirement #3).
    const expressionTimer = useRef(0);
    // Session-phase plumbing (declared here so the SSE effect can read it).
    const phaseRef = useRef("idle");
    const phaseMotionRef = useRef(PHASE_MOTION);
    const phaseExpressionRef = useRef(PHASE_EXPRESSION);
    /** 相位的「出厂 + pet.json」基线；用户覆盖叠在上面（见 phaseMotionFor）。 */
    const phaseBaseRef = useRef({ motions: PHASE_MOTION, expressions: PHASE_EXPRESSION });
    /** 上一次应用过的池子签名，用来判断"池子真的变了没有"。 */
    const phasePoolsRev = useRef("");
    /** phase -> 这一轮抽中的动作组（池子里抽到动作时用它，见 setPhaseResolver）。 */
    const phaseGroupRef = useRef({});
    /** 每个相位各抽中了什么，给诊断用（形状和 fidgetTally 一样是抽屉数）。 */
    const phaseTallyRef = useRef({});
    // Gaze target, mirrored onto the pet root as data-gaze.
    const [gaze, setGaze] = useState("center");
    gazeSinkRef.current = setGaze;
    // Last session phase the stream delivered, mirrored as data-phase, and a
    // phase that arrived while another animation held the body (re-applied on
    // the next idle so a busy moment cannot make the mirror go stale).
    const [phase, setPhaseState] = useState("idle");
    /**
     * 宿主主题（"light" / "dark"），写在根节点上给面板与气泡的配色用。
     *
     * 初值是浅色：DSH 默认浅色，宁可先浅一下，也别在浅色主题里先闪一个深色面板。
     */
    const [theme, setTheme] = useState("light");
    useEffect(() => {
      const sync = () => {
        const next = readHostTheme();
        setTheme((prev) => (prev === next ? prev : next));
      };
      sync();
      // 宿主换主题的方式不止一种（换 class、换 data 属性、直接改 style），三种都盯
      // 上；再加一个低频兜底 —— 漏掉一次就会一直显示错的那套配色。
      const observer = new MutationObserver(sync);
      for (const node of [document.documentElement, document.body]) {
        if (node === null) continue;
        try {
          observer.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode"] });
        } catch { /* 观察不了就算，还有轮询兜底 */ }
      }
      const sidebar = document.querySelector('[data-pane="sidebar"]');
      if (sidebar !== null) {
        try {
          observer.observe(sidebar, { attributes: true });
        } catch { /* 同上 */ }
      }
      const timer = window.setInterval(sync, 2000);
      return () => {
        observer.disconnect();
        window.clearInterval(timer);
      };
    }, []);
    /**
     * The character's silhouette as CSS `clip-path` path data (requirement #5).
     * Empty until the alpha mask has been extracted; while empty the proxy is
     * hidden and the stage keeps its old full-box behaviour.
     */
    const [maskPath, setMaskPath] = useState("");
    /**
     * `[data-hit]` 真正用的路径 = 轮廓快照 + **尾巴那一块矩形**（跟着摆动更新）。
     *
     * 为什么要并：轮廓是开机从渲染画布抓一次的静态网格，而尾鳍一直在摆 —— 摆出去的那一
     * 瞬间，点击落在 `clip-path` 之外、事件直接穿透到页面（实测 `elementFromPoint=HTML`，
     * 而 `hitsMask` / `hitsTail` 都说是她）。这正是用户报的"尾巴一直在摆动，摸尾巴很难
     * 点到"。并一条矩形只多 20 来个字符，而且**只有一层 DOM**：再叠一层会和主层抢事件，
     * 落哪一层取决于 z 序与更新时间，那种不确定性极难查。
     */
    const [tailPath, setTailPath] = useState("");
    const hitPath = tailPath === "" ? maskPath : (maskPath === "" ? tailPath : maskPath + tailPath);
    const pendingPhase = useRef(null);
    // Published by the stream effect so the (earlier-declared) subscription can
    // flush a deferred phase; a ref avoids a declaration-order dependency.
    const pendingPhaseRef = pendingPhase;
    const flushPhaseRef = useRef(() => {});

    /**
     * Whether the press landed on the character rather than on the transparent
     * part of its square canvas.
     *
     * This pack declares no Cubism HitAreas at all, so the region comes from the
     * rendered alpha silhouette. It is the fallback path: once the mask is known
     * the interactive proxy is already clipped to the same silhouette, and this
     * only has to answer for the pre-mask window.
     */
    const hitsModel = useCallback((clientX, clientY) => {
      const stage = stageRef.current;
      if (stage === null) return false;
      const rect = stage.getBoundingClientRect();
      return motion.current.hitsMask(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
    }, []);

    /**
     * Whether the press landed on the pet's HEAD (requirement #1).
     *
     * 重锤出击 is the "pat the head" reaction, so it is reserved for the head;
     * tapping the desk or the body no longer swings a hammer. The region is
     * measured from the model's own facial drawables, so it needs no per-pet
     * tuning.
     */
    const hitsHead = useCallback((clientX, clientY) => {
      const stage = stageRef.current;
      if (stage === null) return false;
      const rect = stage.getBoundingClientRect();
      return motion.current.hitsHead(clientX - rect.left, clientY - rect.top);
    }, []);

    /** 摸尾巴的命中（和摸头同一套，坐标换算也一样走舞台矩形）。 */
    const hitsTail = useCallback((clientX, clientY) => {
      const stage = stageRef.current;
      if (stage === null) return false;
      const rect = stage.getBoundingClientRect();
      return motion.current.hitsTail(clientX - rect.left, clientY - rect.top);
    }, []);

    /**
     * Right-click on the pet opens the whole control panel.
     *
     * The pet has no always-visible chrome any more: a toolbar that appeared on
     * hover sat on top of the character and covered her, and hover is also the
     * one gesture a click-through overlay cannot express well. A context menu
     * is deliberate, and the browser's own menu is suppressed so the gesture
     * means only one thing.
     */
    /**
     * Close the panel on Escape or on a click outside the pet.
     *
     * Clicks that land on the pet or the panel are ignored, so using the panel
     * never dismisses it. The pet's root is pointer-events:none, so a click on
     * a transparent corner targets the page behind and does count as outside —
     * which is the behaviour you want.
     */
    useEffect(() => {
      if (!panelOpen) return undefined;
      const onKey = (event) => {
        if (event.key === "Escape") setPanelOpen(false);
      };
      const onDown = (event) => {
        const root = rootRef.current;
        if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
        setPanelOpen(false);
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("pointerdown", onDown, true);
      return () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("pointerdown", onDown, true);
      };
    }, [panelOpen]);

    /**
     * 显示层：这只宠物现在归谁管。
     *
     * 宠物有两条呈现路径 —— **页面内**（就是这里）与**桌面上**（一个原生窗口进程）。
     * 两边都可能活着，所以按 `mode` + 桌面端心跳算出一个 owner；**owner 不是我就让位**
     * （判据见 `rootStyle` 调用处：两边跑的是同一段客户端代码，"我是谁"要自己判断）。
     *
     * 让位用的是 `visibility: hidden` + `pointer-events: none`，**不是 `display: none`**：
     * 后者会让元素尺寸变 0（`getBoundingClientRect()` 全零），而命中遮罩、自适应缩放都
     * 靠尺寸算 —— 藏起来再显示回来时判定就歪了。`visibility` 保留布局，一藏一显不留后遗症。
     *
     * **轮询不在这里**：它由模块级单例 `ensureLayerPolling()` 负责。写在这个组件的 effect
     * 里曾经导致一个很隐蔽的 bug —— 选了"桌面"之后这个组件让位/不渲染，轮询随之停掉，
     * 于是设置页那一行永远停在旧文本（要重开设置页才更新）。观测者不能是要观测的那个东西。
     */
    useEffect(() => {
      ensureLayerPolling();
    }, []);

    const onContextMenu = useCallback((event) => {
      event.preventDefault();
      setPanelOpen(true);
    }, []);

    /**
     * 桌面端专属：**托盘菜单**驱动的两个动作。
     *
     * 桌宠没有任务栏按钮（壳把窗口设成不进任务栏），托盘是唯一的常驻入口。所以
     * "设置…"和"归位"这两项要把动作送到页面里来：
     *
     *   * `settings` → 打开面板并切到设置页签（等于替用户点开它）；
     *   * `reset`    → 位置与大小回到默认，并演一下"归位"的反应。
     *
     * **两条通道都接**：
     *   * `window.__petCommand(name)` —— 桌面壳的**命令队列**（页面每 33ms 取一次）；
     *   * `pet://reset` / `pet://settings` DOM 事件 —— 网页端与将来可能有的桥。
     *
     * 为什么命令走 HTTP 而不是 Tauri 的窗口事件：`window.emit()` **不发 DOM 事件**、
     * 只走 IPC，而外部页面没有 `window.__TAURI__`（壳里 `withGlobalTauri: false`）。
     * 原来只监听 DOM 事件，于是托盘里"设置""归位"点了**永远没反应**（用户报过）。
     */
    useEffect(() => {
      if (!desktopNow()) return undefined;
      const onReset = () => {
        // 默认位置就是首次打开时那套（面板右下角），见 pos 的初始化。
        const a = anchorFromPos({ right: 24, bottom: 0 }, DEFAULT_SIZE);
        anchorRef.current = a;
        setSize(DEFAULT_SIZE);
        setPos({ right: 24, bottom: 0 });
        saveStored({ size: DEFAULT_SIZE, right: 24, bottom: 0, side: a.side, offset: Math.round(a.offset), fx: undefined, fy: undefined });
        lastInteraction.current = Date.now();
        say(pick(linesNow().reset));
      };
      const onSettings = () => {
        setTab("settings");
        setPanelOpen(true);
      };
      /** 壳的命令队列入口：名字与 DOM 事件同一套。 */
      const onCommand = (command) => {
        if (command === "reset") onReset();
        else if (command === "settings") onSettings();
      };
      window.__petCommand = onCommand;
      window.addEventListener("pet://reset", onReset);
      window.addEventListener("pet://settings", onSettings);
      return () => {
        if (window.__petCommand === onCommand) delete window.__petCommand;
        window.removeEventListener("pet://reset", onReset);
        window.removeEventListener("pet://settings", onSettings);
      };
    }, [say]);

    const onPointerDown = useCallback((event) => {
      if (event.button !== 0) return;
      // A press on a transparent corner only ever starts a drag: it must not
      // arm a click reaction, which is what made the whole square feel live.
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        // 桌面端判"拖动 / 点击"与"她被拖了多远"用的是**屏幕**坐标（见 onMove/onUp）：
        // 壳挪窗口时 `clientX` 是常量，只有屏幕坐标反映用户的手真的走了。
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        // 再记一份"窗口现在在哪"：壳把窗口挪走之后 `window.screenX` 会跟着变，这是
        // 屏幕坐标之外的第二个独立证据（`screenX` 在某些壳里可能报 0）。
        startWindowX: window.screenX,
        startWindowY: window.screenY,
        right: posRef.current.right,
        bottom: posRef.current.bottom,
        moved: false,
        onModel: hitsModel(event.clientX, event.clientY),
        // Resolved once, at press time: the model keeps swaying, so asking
        // again on release could answer differently than the press did.
        onHead: hitsHead(event.clientX, event.clientY),
        onTail: hitsTail(event.clientX, event.clientY),
      };
      lastPressRef.current = Object.assign({ at: Date.now(), layer: event.currentTarget?.getAttribute?.("data-tail") !== null ? "tail" : "hit" }, dragState.current);
      setDragging(true);
      // 桌面端：**按住她 = 让壳开始挪窗口**（网页端什么都不发）。
      // 判断"按在谁身上"只能在页面里做 —— 右键面板也在同一个窗口里，壳分不出来。
      beginWindowDrag(event.clientX, event.clientY);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    }, [hitsModel, hitsHead, hitsTail]);

    useEffect(() => {
      const onMove = (event) => {
        const state = dragState.current;
        if (state === null) return;
        // 网页端量 `client`（位置就在窗口里挪）；桌面端量 `screen` —— 那边壳在挪**窗口**，
        // 指针相对窗口根本没动，用 client 的话"拖了半天一次都没超过 slop"，松手会被
        // 当成点击（她会说一句话，而不是待在原地）。
        const dx = isDesktopShell ? event.screenX - state.startScreenX : event.clientX - state.startX;
        const dy = isDesktopShell ? event.screenY - state.startScreenY : event.clientY - state.startY;
        if (!state.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        state.moved = true;
        // 桌面端：位置归**壳**管（窗口跟着指针走），页面里的 right/bottom 一动不动。
        // 两边同时动就是双倍位移 —— 这是最容易写出来的错。
        if (isDesktopShell) return;
        const width = sizeRef.current;
        const nextPos = {
          right: clampRight(state.right - dx, width),
          bottom: clampBottom(state.bottom - dy, width),
        };
        anchorRef.current = anchorFromPos(nextPos, width);
        setPos(nextPos);
      };
      const onUp = (event) => {
        const state = dragState.current;
        if (state === null) return;
        dragState.current = null;
        setDragging(false);
        // 桌面端：告诉壳"我松手了"。壳那边还有按键状态与超时兜底，这条只是让它立刻停。
        endWindowDrag();
        // 桌面端：`pointermove` 可能漏几帧（窗口在追指针），松手这一刻的坐标才是
        // "她到底被拖了多远"的最终答案。三条证据取其一即可：
        //   1. 拖动过程中已经判过（`state.moved`）；
        //   2. 指针的屏幕坐标变了（`event.screenX/screenY`）；
        //   3. **窗口**的屏幕位置变了（`window.screenX/screenY`）—— 壳挪窗口这件事的
        //      直接后果，与指针事件的语义无关。
        const moved = state.moved || (isDesktopShell && (
          Math.abs((event?.screenX ?? state.startScreenX) - state.startScreenX) >= DRAG_SLOP_PX
          || Math.abs((event?.screenY ?? state.startScreenY) - state.startScreenY) >= DRAG_SLOP_PX
          || Math.abs(window.screenX - state.startWindowX) >= DRAG_SLOP_PX
          || Math.abs(window.screenY - state.startWindowY) >= DRAG_SLOP_PX
        ));
        if (moved) {
          lastInteraction.current = Date.now();
          // 网页端：位置是这一份自己的（localStorage）。桌面端：位置在壳那边
          // （屏幕坐标，`pet-window.json`）—— 这里再存一遍反而会盖掉"窗口内挪位置"
          // 那套已经不再成立的口径。
          if (!isDesktopShell) {
            setPos((current) => {
              const a = anchorRef.current ?? anchorFromPos(current, sizeRef.current);
              saveStored({ right: Math.round(current.right), bottom: Math.round(current.bottom), side: a.side, offset: Math.round(a.offset), fx: undefined, fy: undefined });
              return current;
            });
          }
        } else if (state.onModel) {
          lastInteraction.current = Date.now();
          // **摸尾巴优先于摸头**（2026-09 按用户要求翻回来的）。
          //
          // 历史：最早就是"先判尾巴"，用户报"摸头出的是摸尾巴的效果" → 改成"先判头"。
          // 当时的原因是**失败模式**：`hitsTail` 把 16 块名字带"尾/翅"的几何全算尾巴，
          // 其中 11 块是**可换配件**（几何一直留在原地、横跨全身），于是尾鳍上 86.6% 的
          // 点同时算头（`cdp-interact` 里量到的），先判尾巴等于"点在头部也给尾巴反应"。
          //
          // 现在那个前提没了：尾鳍已按**贴图**收窄到 5 块真尾鳍（`TAIL_FIN_UV`），实测
          // 重叠降到 **9%**（网格 32×32：只算头 262、只算尾巴 17、两者都算 29）。而用户
          // 看到的是"尾巴画在头发上面"—— 点在**看得见的尾鳍**上时，他要的是摸尾巴。
          // 取舍：那 29 格（头部区域里的一小片）现在会给尾巴反应；换来的是可见尾鳍上的
          // 点击行为与画面一致。改回去只需把这两个分支换回来。
          if (state.onTail && FLAGS.tailEnabled) {
            const list = interactionReactions("tailReactions");
            if (list.length > 0) runReactionRef.current(pick(list));
            say(pick(linesNow().tail));
          } else if (state.onHead && FLAGS.patEnabled) {
            // 摸头：从 `patReactions` 里随机挑一个（默认是 重锤出击 / 问号 / 星星眼），
            // 并且**故意不脸红**。表情类反应是"闪一下"，到点由自动清理收走，
            // 所以摸头不会在用户选的槽位上留下永久表情。
            const list = interactionReactions("patReactions");
            if (list.length > 0) runReactionRef.current(pick(list));
            say(pick(linesNow().pat));
          } else {
            // Anywhere else on the character is a lighter acknowledgement —
            // deliberately WITHOUT 重锤出击, which now belongs to the head only.
            say(pick(linesNow().click));
          }
        }
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      return () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
    }, [flashExpression, say]);

    // ---- persistence ---------------------------------------------------
    useEffect(() => { saveStored({ size }); }, [size]);
    // 模型加载完后再按"可见内容"夹一次：挂载时还不知道模型宽高比，inset 是按 0 算的。
    useEffect(() => {
      if (!ready) return undefined;
      const id = window.requestAnimationFrame(() => {
        setPos(() => commitAnchor(anchorRef.current, sizeRef.current));
      });
      return () => window.cancelAnimationFrame(id);
    }, [ready]);
    useEffect(() => { saveStored({ flip }); }, [flip]);
    useEffect(() => { saveStored({ petId }); if (petId !== undefined) applyExpressions({}); }, [petId, applyExpressions]);

    if (catalog !== null && catalog.pets.length === 0) {
      return h("div", { [PET_ATTR]: "", style: rootStyle(size, pos) },
        h("div", { "data-hint": "" },
          h("div", null, t("还没有可用的 Live2D 宠物。")),
          h("div", { style: { marginTop: 6 } }, t("把宠物目录放到：")),
          h("code", null, "%DSH_HOME%\\pets\\<id>\\pet.json"),
        ),
      );
    }

    let overlay = null;
    if (coreMissing) {
      overlay = h("div", { "data-hint": "" },
        h("div", null, h("b", null, t("缺少 Live2D Cubism Core 运行时"))),
        h("div", { style: { marginTop: 6 } }, t("请把官方 live2dcubismcore.min.js 放到：")),
        h("code", null, "%DSH_HOME%\\pets\\.runtime\\live2dcubismcore.min.js"),
      );
    } else if (error !== null) {
      overlay = h("div", { "data-hint": "" },
        h("div", null, h("b", null, t("加载失败"))),
        h("div", { style: { marginTop: 6, opacity: .8, fontSize: 11 } }, error),
      );
    } else if (!ready) {
      overlay = h("div", { "data-hint": "", style: { opacity: .65 } }, t("加载模型…"));
    }

    /**
     * Turn the pinned expression set into parameter writes.
     *
     * Every expression carries its own .exp3.json parameters in the catalog, so
     * a pin becomes a flat list of { id, value, blend }, applied by the
     * controller on every frame. Because they layer on top of the motion
     * output, several can be active at once — which is what a dress-up panel
     * needs and what the engine's single-current-expression manager could never
     * do.
     */
    useEffect(() => {
      const byName = new Map((pet?.expressions ?? []).map((entry) => [entry.name, entry]));
      const layers = [];
      const seen = new Map();
      for (const name of Object.keys(pinned)) {
        if (pinned[name] !== true) continue;
        for (const parameter of byName.get(name)?.params ?? []) {
          // Last pin wins for a shared parameter, so a later choice overrides
          // an earlier one rather than accumulating.
          const at = seen.get(parameter.id);
          if (at === undefined) {
            seen.set(parameter.id, layers.length);
            layers.push(parameter);
          } else {
            layers[at] = parameter;
          }
        }
      }
      motion.current.setExpressionLayers(layers);
    }, [pinned, pet]);

    const panel = panelOpen && pet !== undefined
      ? h("div", {
          "data-panel": "",
          // 桌面端的设置页签需要更宽（见样式表里那条 [data-wide]）。
          ...(tab === "settings" ? { "data-wide": "" } : {}),
          // Pin the panel once it is on screen (requirement #11).
          //
          // It is anchored to the pet's box, so resizing the pet moved the panel
          // out from under the pointer — right while the user is dragging the
          // size slider INSIDE that panel. Freezing it at the coordinates it
          // first appeared at keeps the controls reachable.
          style: panelBox === null ? undefined : {
            position: "fixed",
            left: panelBox.left + "px",
            top: panelBox.top + "px",
            right: "auto",
            bottom: "auto",
          },
        },
          h("header", null,
            catalog.pets.length > 1
              ? h("select", {
                  value: pet.id,
                  onChange: (event) => setPetId(event.target.value),
                }, catalog.pets.map((entry) => h("option", { key: entry.id, value: entry.id }, petDisplayName(entry))))
              : h("span", { "data-title": "", title: petDescription(pet) }, petDisplayName(pet)),
            h("button", {
              type: "button",
              "data-close": "",
              title: t("关闭（Esc）"),
              onClick: () => setPanelOpen(false),
            }, "×"),
          ),
          h("div", { "data-tabs": "" },
            h("button", { type: "button", ...(tab === "motions" ? { "data-on": "" } : {}), onClick: () => setTab("motions") }, t("动作 ") + pet.motions.length),
            // 表情 and 装扮 are one menu now: all 44 expressions are slots
            // (glasses, stickers, hair, cloth, claws, desk, hands, then eyes,
            // mood, mouth, symbols, ambience, blush, desk actions).
            h("button", { type: "button", ...(tab === "slots" ? { "data-on": "" } : {}), onClick: () => setTab("slots") }, t("装扮 ") + (pet.expressionSlots ?? []).length),
            // 这里原来还有第三个「设置」页签。它从一开始就是**过渡**：设置正文真正的家是
            // DSH 自己的设置页（那一节由 host 注册，和这里共用同一份 store），右键面板
            // 里再放一份，只是"改池子不用翻设置"。用户要求去掉 —— 面板现在只负责
            // 「点一下换个样子」，改数值去设置页。
            //
            // **桌面端是例外**：那边没有 DSH 设置页（`ctx.slots` 挂不上），设置正文
            // 没有别的家 —— 所以只在桌面端把这一页签加回来。守卫见 desktopNow()。
            desktopNow() ? h("button", {
              type: "button",
              "data-tab-settings": "",
              ...(tab === "settings" ? { "data-on": "" } : {}),
              onClick: () => setTab("settings"),
            }, t("设置")) : null,
          ),
          h("div", { "data-body": "" }, tab === "slots"            // Dress-up slots: one choice each, and choices in different slots
            // coexist (glasses AND cat ears AND a dark tablecloth).
            ? (pet.expressionSlots ?? []).map((slot) => {
                // An option is active when every expression it carries is pinned:
                // 白魔爪 needs the claw AND its recolour, so checking only the
                // first would light it up for 粉魔爪 too.
                // Selected = the label this slot actually holds. NOT
                // "every expression is pinned": a motion-only option has an EMPTY
                // expression list, and [].every(...) is vacuously true, so
                // 掏出手机 and 吹泡泡糖 rendered as permanently pressed.
                //
                // 读的是**有效选择**（`effectiveSlotChoice`）：会话相位接管时，面板要跟着
                // 显示相位抽到什么，而不是你上一次手选的 —— 以前两边脱节，用户报过
                // "会话的状态没有在右键菜单的装扮里同步 button"。
                const chosenLabel = effectiveSlotChoice(slot.id);
                const active = slot.options.find((option) => option.label === chosenLabel);
                return h("div", { "data-group": "", key: slot.id, "data-slot": slot.id },
                  h("span", null, displaySlotLabel(slot.id)),
                  h("div", { "data-chips": "" },
                    h("button", {
                      type: "button",
                      key: "__none",
                      ...(active === undefined ? { "data-on": "" } : {}),
                      onClick: () => chooseSlotOption(slot, null),
                    }, displaySlotNone(slot)),
                    slot.options.map((option) => h("button", {
                      type: "button",
                      key: option.label,
                      ...(option.label === chosenLabel ? { "data-on": "" } : {}),
                      "data-slot-option": option.label,
                      // `true` = 手动点选：带动作的选项，前提由插件补齐（点自拍会先掏手机）。
                      onClick: () => chooseSlotOption(slot, option, true),
                    }, displayOptionLabel(slot.id, option.label))),
                  ),
                );
              })
            : tab === "motions"
            ? pet.motions.filter((entry) => !(pet.hiddenMotions ?? []).includes(entry.group))
              .map((entry) => h("div", { "data-group": "", key: entry.group },
                h("span", null, displayMotionLabel(entry)),
                h("div", { "data-chips": "" },
                  Array.from({ length: entry.count }, (_, index) => h("button", {
                    key: index,
                    type: "button",
                    ...(motionGroup === entry.group ? { "data-on": "" } : {}),
                    "data-motion-group": entry.group,
                    onClick: () => playMotion(entry.group, index),
                  }, entry.count > 1 ? t("第 ") + (index + 1) + t(" 段") : t("播放"))),
                ),
              ))
            : tab === "settings"
            // 桌面端专属：设置正文（和 DSH 设置页那一节是同一个组件、同一份 store）。
            // 外面这层 `data-settings` 把作用域带进来 —— 面板只有 270→340px 宽，
            // 样式表里已经为窄容器收过一档列宽。
            ? h("div", { "data-settings": "", "data-panel-settings": "" }, h(PetSettingsBody, { compact: true }))
            : null,
          ),
          h("div", { "data-hintrow": "" }, t("在宠物身上点右键打开这里 · Esc 或点空白处关闭")),
          h("footer", null,
            h("button", { type: "button", title: t("缩小"), onClick: () => changeSize(sizeRef.current - 40) }, "－"),
            h("input", {
              type: "range", min: MIN_SIZE, max: MAX_SIZE, step: 20, value: size,
              title: size + "px",
              style: { "--fill": fillOf(size, MIN_SIZE, MAX_SIZE) + "%" },
              onChange: (event) => changeSize(Number(event.target.value)),
            }),
            h("button", { type: "button", title: t("放大"), onClick: () => changeSize(sizeRef.current + 40) }, "＋"),
            h("span", { "data-sizelabel": "" }, size + "px"),
            h("button", {
              type: "button",
              title: t("左右翻转朝向"),
              "data-flip": "",
              ...(flip ? { "data-on": "" } : {}),
              onClick: () => setFlip((v) => !v),
            }, t("翻转")),
            h("button", { type: "button", onClick: resetAll }, t("归位")),
          ),
        )
      : null;

    return h("div", {
      [PET_ATTR]: "",
      ref: rootRef,
      // **让位判据**：owner 不是我，就把自己藏起来（判据见组件顶部的 `yieldToOther`）。
      //
      // 客户端半区在**两边**都跑（DSH 页面里一份、桌面端窗口里一份），所以"我是谁"要自己
      // 判断：桌面壳会建 `window.__petDesktop`（页面侧没有这个）。
      //   * 页面里：所有权在桌面端 → 让位（否则会看见两只）
      //   * 桌面端：所有权在页面内（用户选了"页面内"）→ 让位
      // 这两个方向必须都判，否则会出现"两只"或"一只都没有"。
      style: rootStyle(size, pos, yieldToOther),
      // Observability: the committed action of the motion state machine
      // ('idle' while resting) and the current gaze target, so the pet's
      // behaviour is inspectable without reaching into engine internals.
      "data-motion": motionGroup === "" ? "idle" : motionGroup,
      "data-gaze": gaze,
      "data-phase": phase,
      // 显示层：owner=desktop 时这一份已经让位（藏在桌面端那只后面）。
      "data-layer": layer.owner,
      "data-layer-mode": layer.mode,
      // 这一份是"页面里"还是"桌面窗口里" —— 让位判据与诊断都靠它。
      "data-renderer": isDesktopShell ? "desktop" : "page",
      // 宿主主题：面板与气泡的配色 token 按它切（见 CSS 里的 --pp-*）。
      "data-theme": theme,
    },
      overlay !== null ? overlay : null,
      h("div", {
        ref: stageRef,
        "data-stage": "",
        // No mask yet: keep the whole box interactive rather than inert.
        ...(maskPath === "" ? { "data-nomask": "" } : {}),
        ...(dragging ? { "data-dragging": "" } : {}),
        // The fallback path: with no mask the stage itself starts the drag.
        ...(maskPath === "" ? { onPointerDown, onContextMenu } : {}),
      },
        // Only the silhouette is interactive; everything else in the square
        // canvas stays click-through to the page behind (requirement #5).
        //
        // **尾巴那一块要并进这条路径**：轮廓是开机抓一次的静态快照，而尾鳍一直在摆，
        // 摆出快照的那一瞬间点击会穿透到页面（实测：`elementFromPoint=HTML`，而判定说
        // 是她）。并一条矩形只多 20 来个字符，比"再叠一层 DOM"更不容易和主层抢事件
        // —— 两层叠着的时候，落哪一层取决于 z 序与更新时机，那种不确定性正是这一串
        // 问题里最难查的部分。
        h("div", {
          "data-hit": "",
          ...(hitPath === "" ? { "data-off": "" } : { style: { clipPath: "path('" + hitPath + "')", WebkitClipPath: "path('" + hitPath + "')" } }),
          ...(hitPath === "" ? {} : { onPointerDown, onContextMenu }),
        }),
      ),
      // 位置由头部几何与视口共同决定，台词仍走所有互动共用的 say。
      // 让位的那一份连气泡都不挂：fixed 气泡不跟着根节点一起藏（见 `yieldToOther`）。
      (yieldToOther || bubble === null) ? null : h("div", {
        "data-bubble": "",
        style: {
          "--speech-scale": speechScale(size),
        },
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      }, bubble),
      panel,
    );
  }



  /** Positioning lives on the pet's own root div, so it works whether it is
   * reached through the React container or not. */
  function rootStyle(size, pos, yieldToOther) {
    const style = { width: size, height: size, right: pos.right, bottom: pos.bottom, maxWidth: "100vw", maxHeight: "100vh" };
    if (yieldToOther === true) {
      // 让位给**另一份**实现：**不用 display:none**（尺寸会变 0，命中遮罩与自适应缩放都
      // 靠它算，藏一次再显示判定就歪了）。visibility 保留布局，pointer-events 顺带让点击穿过去。
      //
      // ⚠️ 判据是"owner **不是**我"，不是"owner 是桌面端"。
      // 客户端半区在**两边**都跑：页面里一份、桌面端的窗口里一份，而两边跑的是同一段
      // 客户端代码。所以"owner === desktop"在**桌面端那一份里**也为真 —— 写成那样会把
      // 唯一该显示的那只藏起来（实测：窗口可见、canvas 也在画、就是 `visibility: hidden`，
      // 用户看到的是"桌面上什么都没有"）。
      style.visibility = "hidden";
      style.pointerEvents = "none";
    }
    return style;
  }

  // --------------------------------------------------------------- mount

  let mounted = null;

  function teardown() {
    if (mounted === null) return;
    const current = mounted;
    mounted = null;
    try { current.root.unmount(); } catch { /* already gone */ }
    current.container.remove();
  }

  /**
   * 往 DSH 自己的设置界面里挂一节「桌宠」。
   *
   * DSH 客户端插件通过 slot 往宿主界面插东西，设置页那一节的写法就是
   * ctx.slots.inject("settings.section", () => ctx.slots.register(meta, render))，
   * 字段照抄自 dsh-rule-manager 的客户端 bundle（它就是这么出现在设置里的）：
   *   name/id/order/label  +  一个返回 React 元素的函数。
   *
   * 右键面板里那份设置只是过渡（用户明说的），正牌入口在这里。
   */
  // 设置区的样式**全部**在 SETTINGS_CSS 里（按 data-* 属性选）。这里原来留了几个
  // 行内样式常量（labelStyle / removeStyle / …），行内优先级高于样式表，一旦想统一
  // 调外观就会被它们压住 —— 那些常量已经全部删掉，改外观请改样式表。

  /**
   * 会话相位：**每个相位一组池子**（每个槽位一张条目表）。
   *
   * 用户的原话是"相位现在是单选的，其实本意也是跟摸鱼一样的可以配多个，然后在池子里
   * 随机，所以说跟摸鱼是一样的功能"。所以这里不再是"动作 / 表情两个下拉"，而是和摸鱼
   * 一模一样的条目表 —— 区别只有一层嵌套：摸鱼是 槽位→条目，相位是 相位→槽位→条目。
   *
   * 列表里只出现**被定制过**的相位（一行 = 一条定制）；新增一个相位会先按 pet.json
   * 的 `looksByPhase` 把默认池子显示出来，改哪张表就物化哪张表。
   */
  function PhaseControls({ compact = false } = {}) {
    useSettings();
    // 设置页先概览全部相位，一次展开一个；窄面板保持原有逐行折叠行为。
    const [folded, setFolded] = useState({});
    const [selected, setSelected] = useState(null);
    const [uploading, setUploading] = useState({});
    const [uploadErrors, setUploadErrors] = useState({});
    const updateUploaded = async (phase, file) => {
      setUploading((previous) => Object.assign({}, previous, { [phase]: true }));
      setUploadErrors((previous) => Object.assign({}, previous, { [phase]: "" }));
      try {
        await changeUploadedSound(phase, file);
        if (file !== null && PHASE_OVERRIDES.sounds[phase]?.length === 0) setPhaseSoundMuted(phase, false);
      } catch (error) {
        setUploadErrors((previous) => Object.assign({}, previous, {
          [phase]: error instanceof Error ? error.message : t("保存音频失败"),
        }));
      } finally {
        setUploading((previous) => Object.assign({}, previous, { [phase]: false }));
      }
    };
    const pet = MANIFEST.current;
    if (pet === null) return h("div", { "data-empty": "phases" }, t("宠物还没加载好"));
    const slots = pet.expressionSlots ?? [];
    const known = Array.from(new Set([
      ...PHASE_LINE_KEYS,
      ...Object.keys(PHASE_MOTION),
      ...Object.keys(pet.looksByPhase ?? {}),
      ...Object.keys(PHASE_OVERRIDES.phases),
    ]));
    // **全部相位都列出来**，不再是"只列定制过的"。
    //
    // 用户问过："会话相位里是空的，但点了添加有默认值，这正常吗？应该初始就带上默认值吧。"
    // 老设计是故意的（列表 = 你定制过的部分；加一行才看到默认样子），好处是"没有覆盖就
    // 不会被覆盖钉住"—— pet.json 以后改进了默认值你照样吃得到。但代价是：空列表让人
    // **看不出宠物默认会演什么**，而且和「摸鱼」那张卡不一致（摸鱼永远列着它的池子）。
    //
    // 现在每行显示的是**有效池子**（有覆盖用覆盖，没有就用 pet.json 的默认），行头标出
    // 「默认 / 已改过」，只有改过的那行才显示「重置动作」。覆盖依然**只在真的编辑时**
    // 才落盘（`setPhasePool` 会把有效池子整份物化），所以"看一眼"不留痕迹、
    // 以后默认值改进了也照样能吃到。
    return h("div", { "data-settings": "", "data-setting": "phases" },
      h(ReminderControls, { key: "notify-reminder" }),
      known.length === 0
        ? h("div", { "data-empty": "phases" }, t("这只宠物没有配置任何会话相位"))
        : null,
      known.map((phase) => {
        const custom = PHASE_OVERRIDES.phases[phase] !== undefined;
        const pools = phasePoolsFor(phase);
        const used = Object.keys(pools);
        const free = slots.filter((slot) => used.indexOf(slot.id) === -1);
        const open = compact ? folded[phase] !== true : selected === phase;
        const candidates = used.reduce((sum, slotId) => sum + (pools[slotId] ?? []).length, 0);
        const soundFile = uploadedSoundFor(phase);
        const hasDefaultSound = defaultSoundFor(phase) !== undefined;
        return h("div", { key: phase, "data-phase": phase,
          ...(open ? { "data-expanded": "" } : {}),
          ...(custom ? { "data-phase-custom": "" } : {}) },
          h("div", { "data-phase-head": "", ...(open ? {} : { "data-collapsed": "" }) },
            h("div", { "data-phase-head-main": "" },
              h("button", {
                type: "button",
                "data-phase-toggle": phase,
                "aria-expanded": open,
                title: open ? t("收起") : t("展开"),
                onClick: () => compact
                  ? setFolded((prev) => Object.assign({}, prev, { [phase]: !(prev[phase] === true) }))
                  : setSelected((prev) => prev === phase ? null : phase),
              },
                h("span", { "data-caret": "" }, open ? "▾" : "▸"),
                h("span", { "data-phase-name": "" }, PHASE_LINE_FIELDS.find((field) => field.key === phase)?.label ?? phase),
                h("code", null, phase),
              ),
              custom ? h("button", {
                type: "button",
                "data-phase-remove": phase,
                title: t("恢复此相位的动作槽位默认值"),
                "aria-label": t("恢复") + phase + t("的动作槽位默认值"),
                onClick: () => removePhaseRow(phase),
              }, t("重置动作")) : null,
            ),
            h("div", { "data-phase-meta": "" },
              h("span", { "data-phase-chip": "motion", ...(custom ? { "data-custom": "" } : {}) },
                t("动作 ") + used.length + t(" 槽 · ") + candidates + t(" 候选") + (custom ? t(" · 已改") : "")),
              h("span", { "data-phase-chip": "line",
                ...(PHASE_OVERRIDES.lines.phase?.[phase] !== undefined ? { "data-custom": "" } : {}) },
                t("台词 ") + (PHASE_OVERRIDES.lines.phase?.[phase] !== undefined ? t("已改") : t("默认"))),
              h("span", { "data-phase-chip": "sound",
                ...(PHASE_OVERRIDES.sounds[phase] !== undefined || soundFile !== undefined ? { "data-custom": "" } : {}) },
                t("音频 ") + (PHASE_OVERRIDES.sounds[phase] !== undefined ? t("已静音")
                  : soundFile !== undefined ? t("已上传") : petSoundNotesFor(phase).length === 0 ? t("未配置") : t("宠物默认"))),
            ),
          ),
          open ? [
            h("div", { key: "details", "data-phase-details": "" },
              h("div", { "data-phase-section-title": "" }, t("气泡与提示音")),
              h("div", { "data-phase-line": phase },
                h("label", { "data-line-row": "phase:" + phase },
                  h("span", { "data-row-label": "" }, t("气泡台词")),
                  h("input", {
                    type: "text",
                    "data-line-input": "phase:" + phase,
                    value: linesNow().phase?.[phase] ?? "",
                    placeholder: pet.lines?.phase?.[phase] ?? "",
                    onChange: (event) => applyOverride({ lines: { phase: { [phase]: event.target.value } } }),
                  })),
                Object.prototype.hasOwnProperty.call(PHASE_OVERRIDES.lines.phase ?? {}, phase)
                  ? h("button", {
                    type: "button",
                    "data-reset": "",
                    "data-phase-line-reset": phase,
                    onClick: () => {
                      delete PHASE_OVERRIDES.lines.phase[phase];
                      saveOverrides();
                      notifySettings();
                    },
                  }, t("恢复默认")) : null,
              ),
              h("label", { "data-phase-sound": phase },
                h("span", { "data-row-label": "" }, t("提示音")),
                petSoundNotesFor(phase).length === 0 && soundFile === undefined && !hasDefaultSound
                  ? h("span", { "data-note-inline": "" }, t("未配置；可上传音频"))
                  : h("span", { "data-phase-sound-control": "" },
                    h("input", {
                      type: "checkbox",
                      "aria-label": (PHASE_LINE_FIELDS.find((field) => field.key === phase)?.label ?? phase) + t("提示音"),
                      checked: PHASE_OVERRIDES.sounds[phase] === undefined
                        ? soundFile !== undefined || hasDefaultSound || soundNotesFor(phase).length > 0
                        : soundNotesFor(phase).length > 0,
                      onChange: (event) => setPhaseSoundMuted(phase, !event.target.checked),
                    }),
                    h("span", { "data-note-inline": "" },
                      soundFile === undefined && hasDefaultSound
                        ? t("内置默认音频") + (PHASE_OVERRIDES.sounds[phase] === undefined ? "" : t(" · 已静音"))
                        : soundFile === undefined
                        ? petSoundNotesFor(phase).map((note) => note[0] + "Hz").join(" → ")
                          + (PHASE_OVERRIDES.sounds[phase] === undefined ? t(" · 宠物默认") : t(" · 已静音"))
                        : t("已上传 ") + (soundFile.mime === "audio/mpeg" ? "MP3"
                          : soundFile.mime.replace("audio/", "").toUpperCase())
                          + " · " + (soundFile.bytes < 1024 ? "<1" : Math.round(soundFile.bytes / 1024)) + " KB"
                          + (PHASE_OVERRIDES.sounds[phase] === undefined ? "" : t(" · 已静音"))))),
              h("div", { "data-phase-upload": phase },
                // 「试听」放在上传这一行：它既不为某个来源独占，也不该塞进上面那个
                // `<label>`（label 里放 button，点试听会连带把静音勾选框点掉）。
                h("button", {
                  type: "button",
                  "data-phase-preview": phase,
                  disabled: !canPreviewPhaseSound(phase),
                  title: t("试听这个相位的有效来源（不受总开关与单相位静音影响，音量用当前提示音音量）"),
                  onClick: () => { previewPhaseSound(phase); },
                }, t("试听")),
                h("label", { "data-upload-picker": phase, "data-busy": uploading[phase] === true ? "" : undefined },
                  h("input", {
                    type: "file", accept: ".mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg",
                    "data-upload-input": phase, disabled: uploading[phase] === true,
                    onChange: (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void updateUploaded(phase, file);
                    },
                  }),
                  uploading[phase] ? t("上传中…") : soundFile === undefined ? t("上传音频") : t("替换音频")),
                h("span", { "data-upload-hint": "" }, t("MP3 / WAV / OGG，最多 1 MB")),
                soundFile === undefined ? null : h("button", {
                  type: "button", "data-upload-reset": phase, disabled: uploading[phase] === true,
                  onClick: () => { void updateUploaded(phase, null); },
                }, t("移除上传")),
                uploadErrors[phase] ? h("span", { role: "alert", "data-upload-error": phase }, uploadErrors[phase]) : null,
              ),
            ),
            h("div", { key: "motion-head", "data-phase-motion-head": "" },
              h("span", null, t("动作槽位")),
              h("span", { "data-phase-motion-hint": "" }, t("按候选权重抽取"))),
            used.length === 0
              ? h("div", { "data-pool-empty": "", key: "empty" }, t("没有动作槽位，可在下方添加"))
              : null,
            ...used.map((slotId) => {
              // 槽位 id 来自池子的键：清单里没有它（换了宠物）就退化成一个空槽位，
              // 至少让用户看得到、删得掉。
              const slot = slots.find((item) => item.id === slotId)
                ?? { id: slotId, label: slotId, none: "无", options: [] };
              return h(PoolTable, {
                key: slotId,
                slot,
                entries: pools[slotId],
                noneLabel: t("空着"),
                allowAll: true,
                owner: "phase:" + phase,
                idPrefix: phase + ":",
                // 相位下面的槽位都是"配上去的"，所以每张表都能整个拿掉。
                removeSlot: () => removePhasePool(phase, slotId),
                rowAttr: "data-phase-pool-row",
                addAttr: "data-phase-pool-add",
                weightAttr: "data-phase-pool-weight",
                removeAttr: "data-phase-pool-remove",
                setEntries: (entries) => setPhasePool(phase, slotId, entries),
              });
            }),
            // 「加槽位」和池内的「加候选」必须长得不一样：点错的后果不同 ——
            // 池内那个是往这张表加一条，这个是**新建一张表**。所以前面带一行小字。
            free.length === 0 ? null : h("div", { key: "addslot", "data-add-row": "", "data-slot-row": "" },
              h("span", { "data-add-title": "" }, t("加槽位")),
              free.map((slot) => h("button", {
                key: slot.id,
                type: "button",
                "data-phase-slot-add": phase,
                "data-add-option": slot.id,
                "data-slot-chip": "",
                title: t("给这个相位加一张槽位表"),
                onClick: () => {
                  // 新加的槽位先给一张**空表**：空表 = 这个槽位在这个相位下不出手。
                  // 想让它清空，就加一条「空着」。
                  setPhasePool(phase, slot.id, []);
                },
              }, "＋ " + displaySlotLabel(slot.id)))),
          ] : null,
        );
      }),
      // 这里原来还有一排「＋ 相位」按钮（给没定制过的相位开一行）。现在全部相位都直接
      // 列出来了，那个入口没有存在意义 —— 而且它正是"点一下才看到默认值"的来源。
    );
  }

  /**
   * 摸鱼：每个槽位一张**条目表**，每条一行、可删，右上角 ＋ 可加。
   *
   * 一条 = 一个候选：`默认`（label 为 null，这次不动）或某个选项。删掉某条就是把它
   * 移出池子；整张表空了，这个槽位就彻底不参与摸鱼。
   */
  /**
   * 一条目下面的「关系」行（缩进一级）：每一行能删，行尾能加。
   *
   * 两种关系刻意用不同前缀，别让它们看起来像同一件事：
   *   同时 → pairs（选了它就一起点亮）
   *   前提 → requires（必须已经在该状态，否则这个条目根本播不出来）
   *
   * 关系的归属是**选项**（键 `<槽位>:<标签>`，见 relationsOf）：同一个姿势在摸鱼表、
   * 相位池、右键面板里看到的是同一份关系，改一处三处一起变 —— 这正是"模块化"要的。
   */
  function relationRows(slot, entry, owner) {
    if (entry.label === null || entry.label === undefined) return [];
    const key = slot.id + ":" + entry.label;
    const { pairs, requires } = relationsOf(slot.id, entry.label);
    const row = (kind, targetSlot, label) => h("span", {
      key: kind + ":" + (targetSlot ?? "") + ":" + label,
      "data-relation": kind,
      "data-relation-of": key,
      "data-relation-key": (targetSlot ?? "") + ":" + label,
      // 同一个选项会同时出现在摸鱼表和相位池里（关系是选项的属性），所以行上
      // 再标一下"这是在哪张表里显示的"，测试才能分别寻址。
      "data-relation-in": owner,
      title: kind === "pair" ? t("选了它就一起点亮") : t("必须先处于这个状态才播得出来"),
    },
    h("b", null, kind === "pair" ? t("同时") : t("前提")),
    // 两种关系都写全「槽位 = 选项」：只写选项名的话（"同时：猫猫"）看不出猫猫是
    // 贴在哪个槽位上的，而关系恰恰是跨槽位的东西。
    targetSlot === null || targetSlot === undefined
      ? "：" + label
      : "：" + slotLabelOf(targetSlot) + " = " + displayOptionLabel(targetSlot, label),
    h("button", {
      type: "button",
      "data-relation-remove": "",
      title: t("删掉这条关系"),
      onClick: () => removeRelation(key, kind === "pair" ? "pairs" : "requires", { slot: targetSlot ?? null, label }),
    }, "×"),
    );
    const out = [];
    for (const [targetSlot, label] of Object.entries(pairs)) out.push(row("pair", targetSlot, label));
    for (const item of requires) out.push(row("require", item.slot, item.label));
    return out;
  }

  /**
   * 给一条目加关系：一个下拉里放两种关系，用 `<optgroup>` 分开。
   *
   * 不拆成"先选槽位再选选项"两个控件：那要两步 change 事件，测试和用户都会点错。
   * 值的形状是 `pair|<槽位>|<标签>` / `require|<槽位>|<标签>`。
   */
  function relationAdd(slot, entry, owner) {
    if (entry.label === null || entry.label === undefined) return null;
    const key = slot.id + ":" + entry.label;
    const { pairs, requires } = relationsOf(slot.id, entry.label);
    // `同时` 指向本槽位 = 把自己换成另一个，没意义，所以本槽位的选项不进这一栏。
    // `前提` 指向本槽位**是有意义的**：它是"必须先处于那个状态"，比如
    // 「自拍 → 前提：右手 = 掏出手机」—— 同一个槽位的上一个状态。只排除它自己。
    const others = (kind) => {
      const out = [];
      for (const other of MANIFEST.current?.expressionSlots ?? []) {
        if (other.id === slot.id && kind === "pair") continue;
        for (const option of other.options ?? []) {
          if (option.label === entry.label) continue;
          out.push({
            slot: other.id,
            slotLabel: displaySlotLabel(other.id),
            label: option.label,
            displayLabel: displayOptionLabel(other.id, option.label),
          });
        }
      }
      return out;
    };
    const options = (kind) => others(kind)
      .filter((item) => (kind === "pair"
        ? pairs[item.slot] !== item.label
        : !requires.some((row) => row.slot === item.slot && row.label === item.label)))
      .map((item) => h("option", {
        key: item.slot + ":" + item.label,
        value: kind + "|" + item.slot + "|" + item.label,
        // 本槽位的前提在显示上加一句说明，免得跟"同槽位互斥"混淆。
      }, (item.slot === slot.id ? t("（本槽位）") : item.slotLabel) + " = " + item.displayLabel));
    const pairOptions = options("pair");
    const requireOptions = options("require");
    if (pairOptions.length === 0 && requireOptions.length === 0) return null;
    return h("select", {
      "data-relation-add": key,
      "data-relation-in": owner,
      value: "",
      onChange: (event) => {
        const value = event.target.value;
        if (value === "") return;
        const at = value.indexOf("|");
        const at2 = value.indexOf("|", at + 1);
        const kind = value.slice(0, at);
        setRelation(key, kind === "pair" ? "pairs" : "requires", {
          slot: value.slice(at + 1, at2),
          label: value.slice(at2 + 1),
        });
      },
    },
    h("option", { value: "" }, t("＋ 关系")),
    pairOptions.length === 0 ? null : h("optgroup", { label: t("同时") }, pairOptions),
    requireOptions.length === 0 ? null : h("optgroup", { label: t("前提") }, requireOptions),
    );
  }

  /** 条目表里一条的唯一键：`默认 / 空着` 统一记成 `__none`。 */
  const entryKeyOf = (entry) => (entry.label === null || entry.label === undefined ? "__none" : entry.label);

  /**
   * 一张**条目表**：摸鱼池和相位池共用的那张。
   *
   * 两个池子本来就是同一套东西（用户原话"相位跟摸鱼是一样的功能"），差别只有三处，
   * 所以全部做成参数：
   *   - `setEntries` —— 存哪儿（摸鱼按槽位存，相位还要带相位名）
   *   - `noneLabel`  —— 条目空值叫什么：摸鱼是「默认」（这次不动），相位是「空着」
   *   - `*Attr`      —— DOM 上的前缀，两张表要能分别寻址
   *
   * 条目行下面缩进的那层是**关系**（同时 / 前提），也能加能删。关系挂在选项上而不是
   * 条目上，所以在哪张表里改都一样。
   */
  function PoolTable(props) {
    const { slot, entries, setEntries, noneLabel, owner } = props;
    const rowAttr = props.rowAttr;
    const addAttr = props.addAttr;
    const weightAttr = props.weightAttr;
    const removeAttr = props.removeAttr;
    // 属性值要不要带前缀：摸鱼表就是槽位名（`mouth:吹泡泡糖`），相位池要带相位名
    // （`tool:rhand:写本本`）—— 两个相位可以同时开着同一张槽位表，不带前缀就没法寻址。
    const idPrefix = props.idPrefix ?? "";
    // 条目的 label 是身份（存档 / 关系都用它），这里只换**渲染**出来的文字。
    const labelOf = (entry) => (entry.label === null || entry.label === undefined
      ? noneLabel
      : displayOptionLabel(slot.id, entry.label));
    const keyOf = (entry) => idPrefix + slot.id + ":" + entryKeyOf(entry);
    const addKey = idPrefix + slot.id;
    const numberInput = (value, onChange, extra) => h("input", Object.assign({
      type: "number", min: 0, max: 99, step: 1, value: String(value),
      onChange: (event) => onChange(Number(event.target.value)),
    }, extra));
    const present = new Set(entries.map((entry) => entryKeyOf(entry)));
    const candidates = props.allowAll === true
      ? (slot.options ?? [])
      // 摸鱼**不碰**标了 fidget:false 的选项：吐舌、星星眼这些是"被叫出来"的，
      // 不该在没人管的时候自己出现。相位池是另一回事，那边全都能配。
      : (slot.options ?? []).filter((option) => option.fidget !== false);
    const addable = [{ value: "__none", label: noneLabel }]
      .concat(candidates.map((option) => ({ value: option.label, label: displayOptionLabel(slot.id, option.label) })))
      .filter((item) => !present.has(item.value));
    // 权重条按**占池子总权重的比例**画：它就是这个条目被抽中的概率。
    // 分母为 0（全是 0 或空表）时退化成一条空槽，不会出现 NaN 宽度。
    const total = entries.reduce((sum, entry) => sum + (entry.weight > 0 ? entry.weight : 0), 0);
    const add = (value) => setEntries(entries.concat([{ label: value === "__none" ? null : value, weight: 1 }]));
    return h("div", { "data-pool": owner, "data-pool-slot": slot.id },
      h("div", { "data-pool-head": "" },
        h("span", { "data-pool-title": "" }, displaySlotLabel(slot.id)),
        h("span", { "data-pool-meta": "" },
          entries.length === 0 ? t("空表") : entries.length + t(" 条候选")),
        // 用户自己加进来的槽位可以整个拿掉（默认集合不给删：它们是宠物自己的身子，
        // 删了这张表就再也回不来了）。
        typeof props.removeSlot === "function" ? h("button", {
          type: "button",
          "data-pool-remove-slot": slot.id,
          title: t("把这个槽位从池子里拿掉"),
          onClick: props.removeSlot,
        }, "×") : null,
      ),
      entries.map((entry, index) => {
        const share = entry.weight > 0 && total > 0 ? Math.round((entry.weight / total) * 100) : 0;
        return h("div", {
          key: entryKeyOf(entry) + ":" + index,
          // 两个属性：`data-pool-row` 是**通用标记**（样式表按它排版，两张表共用一套
          // 规则），`[rowAttr]` 才是这张表的唯一键（测试按它寻址）。
          // 只有唯一键的话，样式表就得把 data-fidget-row / data-phase-pool-row
          // 两个名字都抄一遍 —— 抄漏一个的后果就是"某一层根本没排版"。
          "data-pool-row": "",
          [rowAttr]: keyOf(entry),
          // 权重 0 ＝ 这一条留在表里但不参与抽签。整行淡掉、划掉，一眼能看出来，
          // 不用去读那个数字。
          ...(share === 0 ? { "data-off": "" } : {}),
        },
        h("span", { "data-row-label": "", title: labelOf(entry) }, labelOf(entry)),
        // 条是主角（抽中概率），占比数字紧随；权重原始值在右边那一列，只是个旋钮。
        h("span", { "data-weight-cell": "" },
          h("span", { "data-weight-bar": "", title: share + t("% 的概率") },
            h("i", { "data-weight-fill": "", style: { width: share + "%" } })),
          h("span", { "data-share": "" }, share + "%"),
        ),
        numberInput(entry.weight, (value) => {
          const next = entries.slice();
          next[index] = { label: entry.label ?? null, weight: value };
          setEntries(next);
        }, { "data-pool-weight": "", [weightAttr]: keyOf(entry) }),
        h("button", {
          type: "button",
          "data-pool-remove": "",
          [removeAttr]: keyOf(entry),
          title: t("删掉这一条"),
          onClick: () => setEntries(entries.filter((_, at) => at !== index)),
        }, "×"),
        // 「＋ 关系」是这一行的第 5 列（不是另起一行）：多数条目没有任何关系，
        // 让它独占一行的话每一条都要占两行高度。
        relationAdd(slot, entry, owner),
        // 两种关系**必须分开显示**，它们不是一回事：
        //   pairs    = 同时触发（选了它就一起点亮，比如 喵喵手 会带出「贴纸=猫猫」）
        //   requires = 播放前提（必须先处于那个状态才播得出来，比如 挤番茄酱 要先有蛋包饭）
        // 关系块整体占满这一行（`[data-relations]` 跨列），否则会被塞进第一格。
        h("div", { key: "relations", "data-relations": "" },
          ...relationRows(slot, entry, owner),
        ),
        );
      }),
      entries.length === 0
        ? h("div", { "data-pool-empty": "" }, t("空表：这个槽位在这个池子里不出手"))
        : null,
      // 候选直接摆出来（虚线的「＋ 名字」），点一下就加 —— 比一个写着"添加"的下拉框
      // 更像"往池子里放东西"，也省掉了"打开下拉才发现有什么"的一步。
      addable.length === 0 ? null : h("div", { "data-add-row": "" },
        addable.map((item) => h("button", {
          key: item.value,
          type: "button",
          "data-pool-add": "",
          [addAttr]: addKey,
          "data-add-option": item.value,
          onClick: () => add(item.value),
        }, "＋ " + item.label)),
      ),
    );
  }

  function FidgetControls() {
    useSettings();
    const pet = MANIFEST.current;
    if (pet === null) return h("div", { "data-empty": "fidget" }, t("宠物还没加载好"));
    const used = fidgetSlotsFor(pet);
    const occupied = new Set(used.map((slot) => slot.id));
    const free = (pet.expressionSlots ?? [])
      .filter((slot) => !occupied.has(slot.id) && (slot.options ?? []).length > 0);
    // 这个标记**不能**也叫 "fidget"：摸鱼节奏那节（TuningControls group="fidget"）
    // 已经占了这个名字，同名会让按 data-setting 选择的测试/探针命中两处。
    return h("div", { "data-settings": "", "data-setting": "fidget-pools" },
      used.length === 0
        ? h("div", { "data-empty": "fidget" }, t("还没有槽位 —— 在下面挑一个加进来"))
        : null,
      used.map((slot) => h(PoolTable, {
        key: slot.id,
        slot,
        entries: fidgetEntriesFor(slot),
        // 「默认」＝这个槽位这次不动（用户定的叫法）。它就是池子里的一条普通条目：
        // 可以删（删了就是"这个槽位每次摸鱼都得出点东西"），所以**不置顶、不置灰**，
        // 也不给它任何特殊待遇。
        noneLabel: t("默认"),
        // 候选**全都**能加：`fidget:false` 只决定"默认池子里有没有它"，不决定
        // "能不能配"。原先这里传 false，于是 吐舌 / 星星眼 这些在界面上根本点不到。
        allowAll: true,
        owner: "fidget",
        // 宠物**声明过的**默认槽位不给整个删掉（它们是宠物自己的身子，删了列表就空了）；
        // 用户自己加进来的可以。默认集合来自 pet.json 的 `live2d.fidgetSlots`。
        removeSlot: defaultFidgetSlots(pet).includes(slot.id) ? null : () => removeFidgetSlot(slot.id),
        rowAttr: "data-fidget-row",
        addAttr: "data-fidget-add",
        weightAttr: "data-fidget-weight",
        removeAttr: "data-fidget-remove",
        setEntries: (entries) => setFidgetEntries(slot.id, entries),
      })),
      // 「加槽位」和池内的「加候选」必须长得不一样：点错的后果不同 ——
      // 池内那个是往这张表加一条，这个是**新建一张表**。所以前面带一行小字。
      // 药丸基色走 `data-add-option`（漏了它就是裸按钮），`data-slot-chip` 再加区分。
      free.length === 0 ? null : h("div", { "data-add-row": "", "data-slot-row": "" },
        h("span", { "data-add-title": "" }, t("加槽位")),
        free.map((slot) => h("button", {
          key: slot.id,
          type: "button",
          "data-fidget-slot-add": slot.id,
          "data-add-option": slot.id,
          "data-slot-chip": "",
          title: t("把这个槽位加进摸鱼池"),
          onClick: () => addFidgetSlot(slot.id),
        }, "＋ " + displaySlotLabel(slot.id)))),
    );
  }
  /**
   * 设置区的**正文**：一组一张卡片。
   *
   * DSH 设置页和右键面板渲染的是**同一个**正文，所以两处的排版不可能走岔 ——
   * 之前是各写一遍，结果面板里那两张表一直是没样式的裸控件。
   *
   * 它必须是**组件**（`h(PetSettingsBody)`），不能写成 `...PetSettingsBody()`
   * 那样直接调用：直接调用会把里面的 hooks 算到调用方（`Pet`）头上，而右键面板是
   * 按标签页条件渲染的 —— 一切到"设置"，Pet 的 hook 数量就变了，React 会抛
   * "Rendered more hooks than during the previous render" 并把**整只宠物**卸载。
   */
  /** 设置页里每条台词的标题（顺序 = 显示顺序）。 */
  const LINE_FIELDS = [
    { key: "greet", label: t("开始的时候") },
    { key: "click", label: t("点她身上（不是头和尾巴）") },
    { key: "pat", label: t("摸摸头") },
    { key: "tail", label: t("摸尾巴") },
    { key: "spin", label: t("被转晕") },
    { key: "reset", label: t("点「归位」") },
    { key: "loadFailed", label: t("模型加载失败") },
  ];
  const PHASE_LINE_FIELDS = [
    { key: "thinking", label: t("思考中") },
    { key: "tool", label: t("用工具") },
    { key: "waiting", label: t("等你批准") },
    { key: "asking", label: t("等你回答") },
    { key: "helper", label: t("叫了帮手") },
    { key: "queued", label: t("消息排队") },
    { key: "done", label: t("这一轮完成") },
    { key: "failed", label: t("出错") },
  ];

  /**
   * 互动：三个开关 + 三套反应候选。
   *
   * 候选直接用**宠物自己的清单**（动作的中文名 + 表情名），用户不用记 id —— 
   * `runReaction()` 也是这个顺序：先当动作组找，找不到就闪一下表情。
   */
  function InteractControls() {
    useSettings();
    // 候选显示的是**有效那一组**（用户覆盖 <- 宠物声明 <- 内置默认），和运行时
    // `interactionReactions()` 同一个函数：界面上没勾的选项就不该演，勾着的必须真演。
    const listFor = (key) => interactionReactions(key);
    const toggle = (key, label) => {
      const next = listFor(key).slice();
      const at = next.indexOf(label);
      if (at >= 0) next.splice(at, 1);
      else next.push(label);
      applyOverride({ interactions: { [key]: next } });
    };
    const pet = MANIFEST.current ?? {};
    const candidates = Array.from(new Set([
      ...(pet.motions ?? []).map((motion) => motion.label),
      ...(pet.expressions ?? []).map((expression) => expression.label),
    ].filter((label) => typeof label === "string" && label !== "")));
    /** 标签（身份）-> 显示文案；只换按钮上的字，key / data-* / 存档仍是标签。 */
    const candidateLabel = new Map();
    for (const motion of pet.motions ?? []) candidateLabel.set(motion.label, displayMotionLabel(motion));
    for (const expression of pet.expressions ?? []) {
      if (!candidateLabel.has(expression.label)) candidateLabel.set(expression.label, displayExpressionLabel(expression));
    }
    const switchRow = (key, label, note) => h("label", { "data-flag-row": key },
      h("input", {
        type: "checkbox",
        checked: FLAGS[key] === true,
        "data-flag": key,
        onChange: (event) => applyFlag(key, event.target.checked),
      }),
      h("span", { "data-row-label": "" }, label),
      note === undefined ? null : h("span", { "data-note-inline": "" }, note),
    );
    // 从哪里来的写在行尾：**这只宠物没声明这一组**时，用户看到的默认值其实是插件
    // 内置的那几个 —— 不说清楚他会以为"这是宠物自己的设定，改宠物就能改默认"。
    const sourceNote = (key) => {
      const source = reactionSource(key);
      if (source === "user") return t("（已改过）");
      return source === "pet" ? t("（宠物默认）") : t("（内置默认）");
    };
    const reactionRow = (key, title) => h("div", { "data-reaction-set": key, ...(reactionSource(key) === "builtin" ? { "data-reaction-builtin": "" } : {}) },
      h("div", { "data-row-label": "" }, title,
        h("span", { "data-note-inline": "" }, sourceNote(key), t("（随机一个）"))),
      h("div", { "data-chips": "" }, candidates.length === 0
        ? h("span", { "data-note-inline": "" }, t("这只宠物没有可选的动作/表情"))
        : candidates.map((label) => {
          const on = listFor(key).includes(label);
          return h("button", {
            key: label,
            type: "button",
            "data-reaction-chip": key + ":" + label,
            ...(on ? { "data-on": "" } : {}),
            onClick: () => toggle(key, label),
          }, candidateLabel.get(label) ?? label);
        })),
    );
    return h("div", { "data-settings": "", "data-setting": "interact" },
      switchRow("patEnabled", t("摸头有反应")),
      switchRow("tailEnabled", t("摸尾巴有反应")),
      switchRow("spinEnabled", t("鼠标绕着转圈会晕")),
      h(TuningControls, { key: "spin", group: "interact" }),
      reactionRow("patReactions", t("摸头时演什么")),
      reactionRow("tailReactions", t("摸尾巴时演什么")),
      reactionRow("spinReactions", t("转晕时演什么")),
    );
  }

  /**
   * 台词：非会话相位的气泡文本；相位台词在对应相位行。
   *
   * 一组 = 一行输入，**用 `|` 分隔多个变体**（随机挑一句）；相位台词是单句。
   * 留空就退回宠物默认（`pet.json` 的 `live2d.lines`），所以"看一眼"不会把默认改掉。
   */
  function LineControls() {
    useSettings();
    const effective = linesNow();
    const setLines = (patch) => applyOverride({ lines: patch });
    const row = (id, label, value, onInput, placeholder) => h("label", { "data-line-row": id },
      h("span", { "data-row-label": "" }, label),
      h("input", {
        type: "text",
        value,
        placeholder,
        "data-line-input": id,
        onChange: (event) => onInput(event.target.value),
      }),
    );
    return h("div", { "data-settings": "", "data-setting": "lines" },
      h("div", { "data-note": "" }, t("多个变体用 | 分隔（随机挑一句）。留空 = 用宠物默认。")),
      ...LINE_FIELDS.map((field) => row(
        field.key,
        field.label,
        joinLineInput(effective[field.key]),
        (text) => setLines({ [field.key]: splitLineInput(text) }),
        joinLineInput(petDefaultLines()[field.key]),
      )),
    );
  }

  /**
   * 显示层：桌宠在**页面内**还是**桌面上**。
   *
   * 三个选项就是 `pet-desktop.json` 的 `mode`：`auto` 谁在跑听谁的、`inline` 永远在页面里、
   * `desktop` 永远在桌面上（没跑就拉起）。改完 POST 给宿主半区 —— 它负责拉起/收掉桌面端
   * 并写偏好文件；**页面只读不写**，两个写者会互相擦。
   *
   * 这一整张卡只在"这个平台有桌面版"时才有意义；没有的话（比如 macOS 还没构建）给一行
   * 说明而不是三个点了没反应的按钮。
   */
  function LayerControls() {
    useSettings();
    const layer = useLayerState();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState("");
    const current = layer;
    const options = [
      ["auto", t("自动"), t("桌面端在跑就用桌面，否则留在页面里")],
      ["inline", t("页面内"), t("永远在 DSH 页面里（随 DSH 启停）")],
      ["desktop", t("桌面"), t("永远在桌面上；没跑就拉起一个")],
    ];
    const choose = (mode) => {
      setBusy(true);
      setNote(t("正在切换…"));
      fetch(API + "/layer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      }).then((response) => response.json()).then((payload) => {
        setBusy(false);
        // **选「桌面」但没成，必须说清楚为什么** —— 否则症状就是"点了没反应"。
        // 两种最常见：二进制不在（还没装 / 还没构建）、拉起来了但没起来。
        //
        // 这条是补的：第一版只把 `desktopRunning` 翻成一句陈述句（"桌面端没在跑。"），
        // 用户点完看到的字和点之前几乎一样，于是合理地报"啥变化都没有"。
        if (payload?.ok !== true) {
          setNote(t("切换失败：") + (payload?.error ?? t("未知")));
          return;
        }
        if (payload.mode === "desktop" && payload.desktopRunning !== true) {
          setNote(payload.binary?.found === true
            ? t("桌面端拉起来了，但它没在 6 秒内报活 —— 看看是不是被系统拦住了（未签名的 exe 会被 SmartScreen 拦）")
            : t("桌面端二进制不在") + (payload.binary?.hint === undefined ? "" : "：" + tHost(payload.binary.hint)));
          return;
        }
        setNote(payload.desktopRunning === true ? t("桌面端已在跑。") : t("已切回页面内。"));
      }).catch((error) => {
        setBusy(false);
        setNote(t("切换失败：") + String(error && error.message));
      });
    };
    const binary = current.binary ?? {};
    const supported = binary.supported !== false;
    const download = current.download ?? { state: "idle" };
    const missing = supported && binary.found !== true;
    /** 惰性下载：二进制不在时那个按钮做的事（先回话、后台下，进度靠每秒轮询带回来）。 */
    const fetchBinary = () => {
      setNote(t("正在下载桌面端（约 5MB）…"));
      fetch(API + "/layer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "download-desktop" }),
      }).then((response) => response.json()).then((payload) => {
        setNote(payload?.download?.started === true ? t("下载已开始…") : t("下载没能开始：") + (payload?.download?.reason ?? t("未知")));
      }).catch((error) => setNote(t("下载请求失败：") + String(error && error.message)));
    };
    const downloadLine = download.state === "downloading"
      ? t("正在下载…")
      : download.state === "done"
        ? t("下载完成，已就绪")
        : download.state === "failed"
          ? t("下载失败（") + String(download.reason ?? t("未知")) + (download.detail === null || download.detail === undefined ? "" : "：" + download.detail) + "）"
          : null;
    return h("div", { "data-setting": "layer" },
      // 三个选项是**药丸按钮**：形状与反应候选那排 chips 共用同一条规则，所以外面要套一层
      // `[data-reaction-set]`（设置页作用域的 chips 样式挂在它下面）。少这层壳的表现是
      // "三个按钮挤成一行字"，实测过一次。
      h("div", { "data-reaction-set": "", "data-layer-options": "" },
        h("div", { "data-chips": "" },
          ...options.map(([mode, label, hint]) => h("button", {
            key: mode,
            type: "button",
            title: hint,
            disabled: busy,
            ...(current.mode === mode ? { "data-on": "" } : {}),
            "data-layer-mode": mode,
            onClick: () => choose(mode),
          }, label)))),
      // 状态行：**只在这里**说一次"二进制在不在"，不要和选项混在一段里。
      //
      // 缺二进制时给一个**能点的下一步**：只说"不在"，用户除了盯着看没有别的动作可做 ——
      // 这正是"点了桌面没反应"那次投诉的另一半。
      h("div", { "data-note-inline": "", "data-layer-status": "" },
        [supported ? null : t("本平台还没有桌面版构建"),
          missing ? t("桌面端二进制不在") : null,
          supported && binary.found === true
            ? t("桌面端：") + (current.desktopRunning ? t("运行中（已接管）") : t("没在跑")) + "（" + String(binary.source ?? "") + "）"
            : null,
          downloadLine,
          note === "" ? null : note,
        ].filter((line) => line !== null).join(" · ")),
      missing ? h("div", { "data-layer-actions": "" },
        h("button", {
          type: "button",
          disabled: busy || download.state === "downloading",
          "data-layer-download": "",
          onClick: fetchBinary,
        }, download.state === "downloading" ? t("下载中…") : t("下载桌面端（约 5MB）"))) : null,
    );
  }

  /**
   * 一张设置卡片：标题条（+ 右上角提示）+ 内容区。
   *
   * 提到模块作用域是因为现在**两个地方**要画同一种卡片：DSH 设置页那一节，和官方
   * 「插件」页上这一组合包的配置区。各写一份的下场是两边慢慢长得不一样。
   */
  function settingsCard(key, title, hint, body) {
    return h("div", { key, "data-card": key },
      h("div", { "data-card-head": "" },
        h("span", { "data-card-title": "" }, title),
        hint === null || hint === undefined ? null : h("span", { "data-card-hint": "" }, hint),
      ),
      h("div", { "data-card-body": "" }, body),
    );
  }

  /** 设置页的「会话提醒」：当前会话免打扰时机 + 提醒范围（存 overrides.notify）。 */
  function ReminderControls() {
    useSettings();
    const notify = PHASE_OVERRIDES.notify ?? { currentMode: "hidden", scope: "wait" };
    const modeOptions = [
      { value: "hidden", label: t("仅后台或最小化") },
      { value: "unfocused", label: t("切到其他应用时") },
      { value: "always", label: t("始终提醒") },
    ];
    const scopeOptions = [
      { value: "all", label: t("全部会话") },
      { value: "main", label: t("只主会话") },
      { value: "wait", label: t("主会话+等子会话") },
    ];
    return h("div", { "data-notify-block": "" },
      h("div", { "data-phase-section-title": "" }, t("会话提醒")),
      h("div", { "data-phase-line": "notify-current" },
        h("label", { "data-line-row": "notify-current" },
          h("span", { "data-row-label": "" }, t("当前会话提醒时机")),
          h("select", {
            value: notify.currentMode ?? "hidden",
            onChange: (event) => applyOverride({ notify: { currentMode: event.target.value } }),
          }, modeOptions.map((o) => h("option", { key: o.value, value: o.value }, o.label))))),
      h("div", { "data-phase-line": "notify-scope" },
        h("label", { "data-line-row": "notify-scope" },
          h("span", { "data-row-label": "" }, t("提醒范围")),
          h("select", {
            value: notify.scope ?? "wait",
            onChange: (event) => applyOverride({ notify: { scope: event.target.value } }),
          }, scopeOptions.map((o) => h("option", { key: o.value, value: o.value }, o.label))))),
      h("div", { "data-note-inline": "" }, t("当前会话提醒时机只影响你正在看的这个会话；提醒范围决定子会话是否单独提醒。")));
  }

  function PetSettingsBody({ compact = false } = {}) {
    useSettings();
    const card = settingsCard;
    return [
      ...TUNING_GROUPS.filter((group) => !TUNING_GROUPS_INLINE.includes(group.id)).map((group) => card(
        "tune-" + group.id, group.label, group.hint, h(TuningControls, { group: group.id }))),
      // 显示层放最上面：它是"这只宠物在哪"的问题，比手感/池子更先要回答。
      card("layer", t("显示位置"), t("页面内 / 桌面上"), h(LayerControls, null)),
      card("sound", t("会话提示音"), t("总开关 · 音量（拖滑杆会试听）"), [
        h("label", { key: "enabled", "data-flag-row": "soundEnabled" },
          h("input", {
            type: "checkbox",
            checked: FLAGS.soundEnabled === true,
            "data-flag": "soundEnabled",
            onChange: (event) => applyFlag("soundEnabled", event.target.checked),
          }),
          h("span", { "data-row-label": "" }, t("开启会话提示音")),
          h("span", { "data-note-inline": "" }, FLAGS.soundEnabled ? "" : t("默认静音")),
        ),
        h(TuningControls, { key: "volume", group: "sound" }),
      ]),
      card("phases", t("会话相位"), t("点开相位调整台词 · 音频 · 动作"), h(PhaseControls, { compact })),
      // 「摸鱼节奏」（多久摸一次）和「摸鱼」（摸鱼做什么）是同一件事的两半，原来
      // 被「会话相位」隔成两张卡，调摸鱼要上下跳。合成一张：节奏在上、池子在下。
      card("pools", t("摸鱼"), t("多久摸一次 · 摸鱼做什么"), [
        h(TuningControls, { key: "rhythm", group: "fidget" }),
        h(FidgetControls, { key: "pools" }),
      ]),
      card("outfit", t("装扮"), null, h(OutfitControls, null)),
      // 相位台词在相位卡；气泡卡只保留互动台词、开关和位置。
      card("interact", t("互动"), t("摸头 / 摸尾巴 / 转圈"), h(InteractControls, null)),
      card("bubble", t("气泡"), t("显示什么 · 在哪 · 停留多久"), [
        h("label", { key: "enabled", "data-flag-row": "bubbleEnabled" },
          h("input", {
            type: "checkbox",
            checked: FLAGS.bubbleEnabled === true,
            "data-flag": "bubbleEnabled",
            onChange: (event) => applyFlag("bubbleEnabled", event.target.checked),
          }),
          h("span", { "data-row-label": "" }, t("显示气泡")),
          h("span", { "data-note-inline": "" }, FLAGS.bubbleEnabled ? "" : t("已关：任何台词都不弹")),
        ),
        h(TuningControls, { key: "bubble", group: "bubble" }),
        h(LineControls, { key: "lines" }),
      ]),
    ];
  }

  /** DSH 设置页里的「桌宠」一节。 */
  function PetSettingsSection() {
    return h("div", { "data-pet-settings": "" }, h(PetSettingsBody, null));
  }

  /**
   * 侧栏「插件」页上这一组合包的配置区（`plugins.bundle.config`，键 = 包名）。
   *
   * 为什么要有它：官方插件页把"插件自带配置"渲染在**组合包详情页**的描述与行之间
   * （`dsh-client-ui-plugin-manager`；页面只在有人注册了这个键时才画那一节）。我们的
   * 组合包只有一行（`live2d-pet`），所以"这一行的配置"就是"这只宠物的配置"。
   *
   * 它**不是**设置正文的第二个家：相位台词、池子编辑器、装扮与文案仍然只在
   * 「设置 → 桌宠」里改（正文只写一份，这条是 2.0.0 定下来的）。这里是插件页上最常用的
   * 那几项 —— 开关、四根滑杆、显示位置 —— 写进去的还是**同一份共享设置**
   * （`persistShared` → `%DSH_HOME%\pet-settings.json`），所以两个界面永远一致。
   *
   * 样式直接复用设置正文那一套（`[data-pet-settings]` 作用域）：卡片、行、滑杆、药丸
   * 按钮的观感与设置页逐字相同，不需要新写一份 CSS。
   */
  function PetPluginConfig() {
    useSettings();
    const layer = useLayerState();
    const pet = MANIFEST.current ?? {};
    const petLabel = typeof pet.label === "string" && pet.label !== ""
      ? pet.label
      : (typeof pet.id === "string" && pet.id !== "" ? pet.id : t("还没加载"));
    const modeLabel = layer.mode === "inline" ? t("页面内") : (layer.mode === "desktop" ? t("桌面") : t("自动"));
    const ownerLabel = layer.owner === "desktop" ? t("现在在桌面上") : t("现在在页面里");
    const flagRow = (key, label, note) => h("label", { key, "data-flag-row": key },
      h("input", {
        type: "checkbox",
        checked: FLAGS[key] === true,
        "data-flag": key,
        onChange: (event) => applyFlag(key, event.target.checked),
      }),
      h("span", { "data-row-label": "" }, label),
      note === undefined ? null : h("span", { "data-note-inline": "" }, note),
    );
    return h("div", { "data-pet-settings": "", "data-pet-plugin-page": "" },
      // 第一行先说"这只宠物现在在哪"：它比任何开关都更该先回答，
      // 而且换过显示位置的人回来第一眼就是找这一句。
      h("div", { "data-plugin-status": "" },
        t("当前宠物：") + petLabel + t(" · 显示位置：") + modeLabel + "（" + ownerLabel + "）"),
      settingsCard("plugin-flags", t("常用开关"), t("点一下立刻生效"), [
        flagRow("bubbleEnabled", t("显示气泡"), FLAGS.bubbleEnabled ? undefined : t("已关：任何台词都不弹")),
        flagRow("soundEnabled", t("会话提示音"), FLAGS.soundEnabled ? undefined : t("默认静音")),
        flagRow("patEnabled", t("摸头有反应"), undefined),
        flagRow("tailEnabled", t("摸尾巴有反应"), undefined),
        flagRow("spinEnabled", t("鼠标绕着转圈会晕"), undefined),
        flagRow("outfitArchive", t("跨启动记住装扮"), FLAGS.outfitArchive ? undefined : t("已关：也不再记录")),
      ]),
      settingsCard("plugin-tuning", t("手感"), t("注视范围 · 摸鱼节奏 · 音量"),
        h(TuningControls, { keys: ["gazeRangePx", "gazeWatchingRatio", "fidgetQuietMs", "soundVolume"] })),
      settingsCard("plugin-layer", t("显示位置"), t("页面内 / 桌面上"), h(LayerControls, null)),
      h("div", { "data-note": "" },
        t("相位台词、池子编辑器、装扮与台词文案在「设置 → 桌宠」里改。")),
    );
  }

  function applySettings(ctx) {
    if (ctx === null || ctx === undefined) return;
    const slots = ctx.slots;
    if (slots === undefined || slots === null) return;
    try {
      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: "pet-settings",
        order: 40,
        label: () => t("桌宠"),
      }, () => h(PetSettingsSection, null)));
    } catch {
      /* 老版本 DSH 没有这个 slot：右键面板那份还在，不影响使用 */
    }
  }

  /**
   * 侧栏「插件」页里的配置区。
   *
   * 两个容易踩的点：
   *
   *  * **键必须写包名**（`PACKAGE_NAME`）—— 页面按组合包的包名派发这一格，写错的表现是
   *    "注册成功、页面什么都不多"。
   *  * **`slots.inject` 而不是"现在就注册"**：插件页是懒挂载的面板，它的子 slot 在页面
   *    注册时才声明；`inject` 会等到那一刻再跑（页面重开/销毁也跟着走）。
   */
  function applyPluginPage(ctx) {
    if (ctx === null || ctx === undefined) return;
    const slots = ctx.slots;
    if (slots === undefined || slots === null) return;
    try {
      slots.inject("plugins.bundle.config", () => slots.register({
        name: "plugins.bundle.config",
        key: PACKAGE_NAME,
      }, () => h(PetPluginConfig, null)));
    } catch {
      /* 老版本 DSH 没有这条 slot：设置页那一节还在，不影响使用 */
    }
  }

  function apply(ctx) {
    ensureStyle();
    // 先按本地存档起来（宿主不在时这就是全部）。
    restoreTuning();
    restoreOverrides();
    // 刷新后浏览器会锁住声音；下次用户点击页面时再解锁，不自动播放。
    window.addEventListener("pointerdown", unlockSound);
    ctx.effect(() => () => {
      window.removeEventListener("pointerdown", unlockSound);
      // 卸载前把还没触发的音量试听定时器清掉：否则它 160ms 后醒来会**新建**一个
      // AudioContext 并放出一声 —— 宠物都已经走了。
      if (volumePreviewTimer !== 0) {
        window.clearTimeout(volumePreviewTimer);
        volumePreviewTimer = 0;
      }
      if (soundContext !== null) {
        void soundContext.close().catch(() => {});
        soundContext = null;
      }
    }, "live2d-pet: notification audio");
    // 再问宿主要"共享的那一份"：桌面端与 DSH 是两个 origin，localStorage 互不可见，
    // 所以跨窗口一致只能靠宿主。拉回来会覆盖本地（宿主是权威），并广播给两个界面。
    const applyRemote = (payload) => {
      applyShared(payload, {
        tuning: (value) => restoreTuning(value),
        overrides: (value) => {
          restoreOverrides(value);
          notifySettings();
        },
        outfit: (value) => {
          // 装扮是"槽位选择"：灌进去要顺带把 pin 重算一遍（否则画面不跟着变）。
          // 真正的实现在 `Pet` 里（槽位状态在那边），走模块级的桥。
          if (applyOutfitRef.current !== null) applyOutfitRef.current(value);
          notifySettings();
        },
      });
    };
    void pullShared(applyRemote);
    // 3 秒轮询：另一个窗口改了，这个窗口跟着变。`storage` 事件不跨 origin，只能轮询。
    if (sharedPoll === 0) {
      sharedPoll = window.setInterval(() => {
        void pullShared(applyRemote);
        void pullUploadedSounds();
      }, SHARED_POLL_MS);
    }
    applySettings(ctx);
    applyPluginPage(ctx);
    // Takeover: an earlier instance — a hot reload, or one left behind by a
    // crashed reload — must not leave a second floating pet on the page.
    teardown();
    // Sweep containers AND any orphaned pet root an earlier instance left
    // behind, so this apply body is the page's only floating pet.
    for (const stale of Array.from(document.querySelectorAll(
      "[" + ROOT_ATTR + "],[" + LEGACY_ATTR + "],[" + PET_ATTR + "]",
    ))) stale.remove();

    const container = document.createElement("div");
    container.setAttribute(ROOT_ATTR, "");
    document.body.appendChild(container);

    const root = require("react-dom/client").createRoot(container);
    mounted = { root, container };
    root.render(h(Pet, null));

    ctx.effect(() => () => teardown(), "live2d-pet: client lifecycle");
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});
