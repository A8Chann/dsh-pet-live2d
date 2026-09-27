// 桌面端运行时（页面侧）——把"web 页面里的桌宠"接成"桌面上的桌宠"。
//
// 两件事：
//
//   1. **穿透判定的权威回答**。壳每 ~33ms 把光标位置交过来，这里回答"光标下面是页面
//      还是桌面"。判定必须在渲染进程做：右键面板、气泡这些 DOM 盒子的位置只有布局知道
//      （剪影那部分 `lib/client.js` 自己管，见下面 hits 的转发）。
//   2. **DSH 客户端接口的桩**。插件需要 `ctx.slots`（设置页扩展点）与 `ctx.effect`
//      （生命周期）。桌面端没有 DSH 的客户端壳，所以给一份最小实现：`slots` 直接给
//      undefined，插件自己会跳过设置页那一节（它本来就是 try/catch 兜着的），右键面板
//      那份 UI 不受影响。
//
// 这个文件是**桌面端专属**的：它不存在于 DSH 里面，所以它怎么改都不会影响网页端。
(function () {
  const plugin = {
    exports: null,
    applied: false,
    error: null,
    sections: {},
  };

  const desktop = {
    /** 壳读的那份运行状态。 */
    state: {
      hover: { interactive: false, reason: 'init', x: -1, y: -1 },
      ignore: null,
      samples: 0,
      probed: 0,
      bootAt: Date.now(),
    },
    /** 上一次判定结果（driver 断言读这个，不读截图）。 */
    lastVerdict: null,
    /** 最近若干次判定，出问题时能回放"那一瞬间判成了什么"。 */
    history: [],

    /** 判定：给定页面坐标，返回 { interactive, reason }。 */
    probe(point) {
      const x = Number(point && point.x);
      const y = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { interactive: false, reason: 'no-coords' };
      }
      const el = document.elementFromPoint(x, y);
      let reason = 'desktop';
      if (el !== null) {
        if (el.closest('[data-panel]') !== null) reason = 'panel';
        else if (el.closest('[data-bubble]') !== null) reason = 'bubble';
        else if (el.closest('[data-dsh-live2d-pet]') !== null) reason = 'pet';
        else if (el.closest('[data-desktop-ui]') !== null) reason = 'ui';
      }
      this.state.probed += 1;
      this.state.samples += 1;
      this.state.hover = { interactive: reason !== 'desktop', reason, x, y, tag: el === null ? null : el.tagName };
      this.lastVerdict = this.state.hover;
      this.history.push(this.state.hover);
      if (this.history.length > 240) this.history.splice(0, this.history.length - 240);
      return this.state.hover;
    },

    /** 读口：driver 用这些字段断言，不需要碰引擎内部。 */
    diag() {
      return {
        boot: plugin.applied,
        bootError: plugin.error ?? window.__bootError ?? null,
        errors: window.__errors ?? [],
        hover: this.state.hover,
        probed: this.state.probed,
        pet: window.__dshLive2dPet !== undefined,
        canvas: document.querySelector('[data-dsh-live2d-pet] canvas') !== null,
      };
    },
  };

  window.__petDesktop = desktop;
  // sidecar 按名字找它（见 sidecar/server.mjs 的 PROBE_FN）：判定函数必须挂在
  // globalThis 上，因为 HTTP 那条路上没有别的句柄能指过来。
  window.__petDesktopProbe = (point) => desktop.probe(point);

  /** 给插件用的最小 ctx：和 DSH 客户端的 apply 契约一致，但只实现桌面端有的那部分。 */
  window.__petCtx = function petCtx() {
    return {
      effect(fn) { try { return fn(); } catch { return () => {}; } },
      // 桌面端 M0 没有设置页宿主：`slots` 故意是 undefined，插件会跳过那一节。
      slots: undefined,
      logger: console,
    };
  };

  window.dispatchEvent(new Event('pet-desktop-runtime'));
})();
