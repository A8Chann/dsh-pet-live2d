// 等条件成立，而不是等一个猜出来的毫秒数。
//
// 套件慢的主因不是并发不够，而是**几百处固定 `sleep`**：条件早就满足了也要等满，
// 于是"等缓动到终值"变成"睡 900ms"。更糟的是这种等待**在负载下不可靠** —— 并发一上来
// 帧率掉下去，900ms 不够用了，断言就吃到半途的值（这就是 6 并发时 cdp-motion / cdp-gaze
// 那一类失败的根因）。同一处代码既慢又脆。
//
// 换成轮询之后两头都赚：条件一满足就往下走（通常比猜的数字快好几倍），而负载高时它会
// 自己多等几个 tick 而不是读到半成品 —— **更快也更稳**。
//
// 用法：
//
//   const { waitFor, waitForIdle } = createWaiter(evaluate)
//   await waitForIdle()                       // 等到动作回到 idle
//   await waitFor(() => expr('param>0.9'))    // 等到任意条件
//
// `evaluate` 是驱动器已有的那个"在页面里求值"的函数（各驱动器的名字不同：
// ev / evaluate / expr 都见过，所以这里**由调用方注入**，不替它们统一命名）。
import { setTimeout as sleep } from 'node:timers/promises'

/** 轮询间隔：比一帧略长，别把 CDP 往返本身变成瓶颈。 */
export const POLL_MS = 25

/**
 * 反复求值直到条件成立。
 *
 * @param probe 返回布尔（或可判真值）的异步函数
 * @param options.timeoutMs 上限；超时返回 false（**不抛** —— 让调用方按语义断言，
 *        因为"没等到"有时候本身就是被测契约的一部分）
 * @param options.label 超时时打印出来的名字，方便定位是哪一处等待
 * @param options.pollMs 轮询间隔
 * @param options.onTimeout 超时时的提示（比如打印最后一次读到的值）
 */
export async function waitFor(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? POLL_MS
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      last = await probe()
    } catch (error) {
      last = undefined
      if (options.verbose) console.log('  （等待中出错，继续试：' + String(error && error.message) + '）')
    }
    if (last) return true
    if (Date.now() >= deadline) {
      if (options.label !== undefined) {
        const detail = options.onTimeout === undefined ? '' : ' ' + options.onTimeout(last)
        console.log('  ⏱ 等超时（' + Math.round(timeoutMs) + 'ms）：' + options.label + detail)
      }
      return false
    }
    await sleep(pollMs)
  }
}

/**
 * 建一个绑定到某个驱动器求值函数的等待器。
 *
 * @param evaluate (expression: string) => Promise<unknown>  在页面里跑一段表达式
 */
export function createWaiter(evaluate) {
  const expr = (expression) => evaluate(expression)

  /** 等到动作状态机回到 idle（`data-motion` 是它对外的那一个信号）。 */
  const waitForIdle = (options = {}) => waitFor(
    async () => (await expr('document.querySelector("[data-dsh-live2d-pet]")?.getAttribute("data-motion")')) === 'idle',
    Object.assign({ timeoutMs: 8000, label: '回到 idle' }, options),
  )

  /** 等到某个选择器出现。 */
  const waitForSelector = (selector, options = {}) => waitFor(
    async () => (await expr('!!document.querySelector(' + JSON.stringify(selector) + ')')) === true,
    Object.assign({ timeoutMs: 5000, label: '出现 ' + selector }, options),
  )

  /** 等到页面里那个求值函数返回真。 */
  const waitForExpr = (expression, options = {}) => waitFor(
    async () => (await expr(expression)) === true,
    Object.assign({ timeoutMs: 5000, label: expression.slice(0, 60) }, options),
  )

  /** 等到某一个动作参数超过阈值（"缓动到位了"最常用的判据）。 */
  const waitForParam = (param, threshold, options = {}) => waitFor(
    async () => Number(await expr('window.__dshLive2dPet?.params?.()?.[' + JSON.stringify(param) + '] ?? 0')) > threshold,
    Object.assign({ timeoutMs: 8000, label: param + ' > ' + threshold }, options),
  )

  return { waitFor, waitForIdle, waitForSelector, waitForExpr, waitForParam, expr }
}

/**
 * **"睡一会儿再断言"合成一个轮询。**
 *
 * 驱动器里最常见的浪费形态就是这两行挨着：
 *
 *     await sleep(900)                                   // 等状态稳定下来
 *     check('视线回正', Math.abs(x) < 0.02)               // 然后看它稳没稳
 *
 * 睡的那个毫秒数是**猜**的：条件早就成立也白等（浪费），负载一高又不够（假红）。
 * 合成一个"重试到超时"之后两头都对：成立就走，不成立才用满上限。
 *
 * ⚠️ **只用于"终值"类断言**。如果被测契约本身就是"要等够 N 秒"（转圈窗口、定格姿势
 * 能撑 9 秒、相位持续播放），那样必须真的等满 —— 用 `mustElapse`，别用这个，
 * 否则就是把测试改掉了。
 *
 * @param read 每次重新读一遍信号，返回 `{ ok, detail }`
 * @param record 记一条断言（各驱动器的 `check` 都是这个签名）
 */
export async function checkEventually(read, record, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, detail: undefined }
  for (;;) {
    try {
      last = (await read()) ?? { ok: false, detail: undefined }
    } catch (error) {
      last = { ok: false, detail: '读数失败：' + String(error && error.message) }
    }
    if (last.ok === true || Date.now() >= deadline) break
    await sleep(POLL_MS)
  }
  const waited = timeoutMs < Number.MAX_SAFE_INTEGER
  record(last.ok === true, last.detail === undefined
    ? (waited ? '（等到即止，上限 ' + timeoutMs + 'ms）' : undefined)
    : last.detail)
  return last.ok === true
}

/**
 * 消费一个 `checkEventually` 用的信号读取器：**读一次就给结论**，
 * 交给 `checkEventually` 去决定要不要再读。
 *
 * 把"怎么读"和"怎么判"分开写，是因为多数断言的判据不止一个字段（参数 + 属性 + DOM），
 * 写成一个返回 `{ ok, detail }` 的闭包最直白。
 */
export const signal = (read) => read

/**
 * 让时间真的过去（**不能**用轮询替代的那一类等待）。
 *
 * 阈值类契约必须等满窗口：转圈要在 6 秒窗口内转够圈数、定格姿势要能撑住 9 秒、相位动作
 * 要持续播放。这类地方的 `sleep` 是**被测语义本身**，换成轮询就等于把测试改掉了。
 * 给它一个名字，是为了让"这处等待为什么保留"在代码里看得出来。
 */
export const mustElapse = (ms) => sleep(ms)

/**
 * 等 harness 页面自报就绪（`document.title === 'done'`）。
 *
 * 18 个 driver 都写过这同一段：
 *
 *     for (let i = 0; i < 240; i++) { await sleep(500); if (await ev('document.title') === 'done') break }
 *
 * 两个毛病：**每轮 500ms**（就绪本身通常 2-4 秒，于是白等半个 tick 才发现在即），
 * 以及最坏 **120 秒**的窗口。换成 100ms 轮询、30 秒上限（和 `waitReady` 一致）——
 * 同一个契约，只是更早发现它成立。18 个 driver 上这一处就是几十秒。
 *
 * 注意上限**收窄**了：从 120 秒到 30 秒。如果哪台机器真的 30 秒都加载不完，那是该红，
 * 而不是让整轮套件多等一分半。
 */
export async function waitForBoot(ev, timeoutMs = 30000) {
  return waitFor(
    async () => (await ev('document.title')) === 'done',
    { timeoutMs, pollMs: 100, label: 'harness 页面就绪（title=done）' },
  )
}
