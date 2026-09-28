// 套件清单：filename -> 它证明的**用户可见契约**。
//
// 单独一个文件、**纯数据、无副作用**：`run-suite.mjs` 一 import 就会开跑（它有顶层执行
// 代码），所以任何想读这份清单的工具（比如 `tools/suite-budget.mjs` 的计时统计）
// 都不能去 import 那个跑者 —— 一 import 就真的把整套跑起来了。
export const SUITE = {
  'test-host-sync.mjs': '随包宠物升级：老装机拿得到新的默认值，改过的一个字都不碰',
  'cdp-sm.mjs': '动作状态机：点击→播放→回待机、重播、连点、面板播放、归位',
  'cdp-v12.mjs': 'v1.2 交互契约：面板不缩放、点击遮罩、视线回正、相位映射、摸鱼',
  'cdp-phase.mjs': '会话相位 → 动作映射（SSE）',
  'cdp-mask.mjs': '点击轮廓网格（alpha 剪影）',
  'cdp-gaze.mjs': '注视跟随与回默认位',
  'cdp-dpr.mjs': 'DPR 渲染倍率（放大清晰）',
  'cdp-sharp.mjs': '2x 超采样下限（缩小不虚）',
  'cdp-motion.mjs': '动作语义：嘴还原 / 喷水 / 定格 / 前置动作',
  'cdp-exp.mjs': '装扮菜单：每个槽位选项都真的写进模型',
  'cdp-handoff2.mjs': '定格姿势能被会话相位接管',
  'cdp-host-events.mjs': '真实 DSH 事件接线（tools/*）+ 相位持续播放',
  'cdp-head.mjs': '点头部才重锤出击；摸鱼不碰重锤/喷水',
  'cdp-idle-return.mjs': '动作/表情到点自动回到初始待机',
  'cdp-passthrough.mjs': '只有角色可拖动，透明处事件穿透',
  'cdp-merge.mjs': '装扮菜单：多槽位叠加、跨槽保留、白魔爪双层',
  'cdp-bubble.mjs': '动作定格能关掉：吹泡泡糖/掏手机 → 无，连测三轮',
  'cdp-interact.mjs': '互动与气泡：摸尾巴/转圈转晕/相位台词/文本·位置·开关可配',
  'cdp-react-defaults.mjs': '互动反应候选的内置默认值：宠物没声明那三组也演得出来',
  'cdp-settings-render.mjs': '设置正文真的渲染得出来（挂在宠物组件之外的组件不许读到组件内的 ref）',
}

/**
 * 可以安全并发的 driver。
 *
 * 依据是**实测的失败模式**，不是猜的：这些 driver 的断言读的是"确定的终值"（几何、
 * 命中、DOM 数量、状态机终态），对帧率不敏感；而没在表里的那些会用固定 sleep 去等缓动，
 * 机器一吃力就读到半途的值。
 *
 * 这份名单**是用失败换来的**，别凭感觉往里加：
 *
 *   * 6 并发那一轮红了 6 条 → `cdp-interact`、`cdp-react-defaults` 挪进独占；
 *   * 后来 `cdp-host-events` 在 3/4 并发下**快速失败**（6.9s，断言级、不是超时）→ 也挪走。
 *     它要驱动活动中枢（`/__nudge` / `/__emit`）再读相位，对时序比别的敏感。
 *
 * 往这里加之前，先在 `--jobs 3` 与 `--jobs 4` 下各跑几遍（实测，不是推理）。
 */
export const PARALLEL_SAFE = new Set([
  'test-host-sync.mjs',
  'cdp-settings-render.mjs',
  'cdp-mask.mjs',
  'cdp-dpr.mjs',
  'cdp-merge.mjs',
  'cdp-handoff2.mjs',
  'cdp-passthrough.mjs',
  'cdp-phase.mjs',
  'cdp-exp.mjs',
])
