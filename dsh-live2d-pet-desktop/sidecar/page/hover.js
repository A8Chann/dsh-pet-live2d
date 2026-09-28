// 桌面端运行时（页面侧）。
//
// 两件事：**穿透判定**、**把判定交给壳**。
//
// 为什么判定必须在页面里做：剪影是模型**当前帧变形后的三角面**，只有渲染进程知道
// （`lib/client.js` 里那套命中判定就是这么工作的）；而气泡、右键面板这些 DOM 盒子的
// 位置只有布局知道。所以壳用 `GetCursorPos` 拿到屏幕坐标，交到这里换算成页面坐标再判。
//
// 注意：**不能靠 pointermove 事件**。窗口一旦设成"忽略光标事件"，Windows 会把命中测试
// 交给下层窗口，页面根本收不到鼠标移动——Electron 是靠 `forward: true` 额外把移动消息
// 喂给渲染进程才解决的，Tauri 没有这个开关。所以坐标从壳那边来，这个文件只负责"回答"。
(function () {
  // 开发期把 __petDesktop 暴露出来：壳、driver、devtools 读的是同一个对象。
  const state = {
    hover: { interactive: false, reason: 'init', x: -1, y: -1, at: 0 },
    ignore: null,
    samples: [],
    history: [],
  };

  /** 透明区域点击穿透，剪影与面板吃事件——这就是网页端"事件穿透"的桌面版。 */
  function interactiveAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { interactive: false, reason: 'no-coords' };
    const el = document.elementFromPoint(x, y);
    if (el === null) return { interactive: false, reason: 'outside' };
    const reason = el.closest('[data-panel]') !== null ? 'panel'
      : el.closest('[data-bubble]') !== null ? 'bubble'
        : el.closest('[data-dsh-live2d-pet]') !== null ? 'pet'
          : el.closest('[data-spike-hit]') !== null ? 'spike'
            : 'desktop';
    return { interactive: reason !== 'desktop', reason, tag: el.tagName, cls: String(el.className || '').slice(0, 40) };
  }

  /**
   * 壳每帧调一次：给它当前光标的**页面坐标**，它回答"要不要忽略光标事件"。
   *
   * 判定结果留在 state 里，是为了让 driver 能读到"上一帧判了什么"——断言读的是这个，
   * 不是截图。
   */
  state.probe = function probe(point) {
    const x = point && Number.isFinite(point.x) ? point.x : state.hover.x;
    const y = point && Number.isFinite(point.y) ? point.y : state.hover.y;
    const verdict = interactiveAt(x, y);
    state.hover = Object.assign({ x, y, at: Date.now() }, verdict);
    state.samples.push(state.hover);
    if (state.samples.length > 240) state.samples.splice(0, state.samples.length - 240);
    return state.hover;
  };

  /** 一条可读的判定历史，出问题时不用猜"那一瞬间到底判成了什么"。 */
  state.trace = function trace(limit) {
    return state.samples.slice(-(limit ?? 20)).map((s) => [s.x, s.y, s.reason, s.interactive]);
  };

  /**
   * 和桌宠页面同一个读口的形状（driver 先等 boot，再问 diag）。
   *
   * `canvas` 在 spike 页**故意报 true**：球就是这一页的"要渲染的东西"。让它报 false
   * 会让 spike 驱动多一条永远红、且没有信息的断言；driver 那边会按页面类型说清楚它
   * 验的是哪一半。
   */
  state.diag = function diag() {
    return {
      boot: true,
      spike: true,
      canvas: document.getElementById('balloon') !== null,
      pet: false,
      errors: [],
      hover: state.hover,
      probed: state.samples.length,
    };
  };

  window.__petDesktop = state;
  // sidecar 按名字找它（见 sidecar/server.mjs 的 PROBE_FN）。
  window.__petDesktopProbe = (point) => state.probe(point);
  // 和桌宠页面同一个读口（driver 先等它，再开始验）：spike 页没有"插件注册"这一步，
  // 页面脚本跑完就算启动完成。
  window.__desktopBoot = { ok: true, applied: true, ms: 0, spike: true };
  window.dispatchEvent(new Event('pet-desktop-runtime'));
})();
