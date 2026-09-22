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
  // "slots" 是 DSH 客户端界面给插件的扩展点（设置页就是这么挂进去的）。
  const inject = ["slots"];

  const API = "/api/live2d-pet";
  const STORAGE_KEY = "dsh-live2d-pet.state.v1";
  const ROOT_ATTR = "data-dsh-live2d-pet-root";
  const PET_ATTR = "data-dsh-live2d-pet";
  const LEGACY_ATTR = "data-dsh-live2d-pet-container";
  const MIN_SIZE = 160;
  const MAX_SIZE = 760;
  const DEFAULT_SIZE = 300;

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
      try {
        const raw = core?._model?.parameters;
        if (raw === undefined || raw === null) return -1;
        return Array.from(raw.ids).indexOf(id);
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
    const applyRelease = (values, core) => {
      if (releasedOverrides === null || values === null) return;
      for (const id of Object.keys(releasedOverrides)) {
        const at = parameterIndex(core, id);
        if (at >= 0) values[at] = releasedOverrides[id];
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
      if (expressionLayers.length === 0 && sweepSpec === null && mouthFollow <= 0 && mouthLean === 0
        && releasedOverrides === null) {
        // The mouth contributes nothing at rest, and saying so is part of the
        // contract: leaving the last moving values here would report an open
        // mouth after the pointer had already come back to the centre.
        mouthWritten = { open: 0, form: 0 };
        // The release still has to be applied — it is not tied to any of the
        // things this guard is about.
        applyRelease(core._model.parameters.values, core);
        return;
      }
      try {
        const values = core._model.parameters.values;
        applyRelease(values, core);
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
        for (const layer of expressionLayers) {
          const at = parameterIndex(core, layer.id);
          if (at < 0) continue;
          const current = values[at];
          if (layer.blend === "Multiply") values[at] = current * layer.value;
          else if (layer.blend === "Overwrite") values[at] = layer.value;
          else values[at] = current + layer.value;
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
      // A motion whose premise is missing must not play from ANY caller.
      if (guardFor !== null && guardFor(group) !== true) return false;
      // The pet's declared policy is the default; an explicit caller option
      // (the panel, or the session-phase driver) still wins.
      const opts = Object.assign({}, optionsFor(group), options || {});
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

    return {
      /** Bind a freshly loaded model and start its idle loop. */
      attach(nextVendor, nextModel, catalogMotions, nextOptions) {
        vendor = nextVendor;
        model = nextModel;
        groups = indexGroups(nextModel, catalogMotions);
        motionOptions = nextOptions ?? null;
        idleName = resolveIdleName(groups);
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
        sweepSpec = null;
        hookedCore = null;
        drawnValues = null;
        releasedOverrides = null;
        headBox = null;
        hitMask = null;
        hitBox = null;
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
      updatePointer(x, y, width, height) {
        if (model === null) return;
        const half = { x: Math.max(1, width / 2), y: Math.max(1, height / 2) };
        const shape = (value) => {
          // A small dead zone, so hand tremor near the centre does not make the
          // eyes wander, and a linear ramp beyond it up to full deflection.
          const size = Math.abs(value);
          if (size <= TUNING.gazeDeadzone) return 0;
          const t = Math.min(1, (size - TUNING.gazeDeadzone) / (1 - TUNING.gazeDeadzone));
          return value < 0 ? -t : t;
        };
        const nx = shape((x - half.x) / half.x);
        // Screen y grows downward; the controller wants up-positive.
        const ny = shape((y - half.y) / half.y);
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
      /** Diagnostic: the normalized gaze target the pointer last produced. */
      gazeTarget: () => gazeTarget,
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
      },
      idleName: () => idleName,
      groups: () => groups,
      /** Declared playback policy for one motion group (diagnostics). */
      optionsFor,
      /** Whether the idle fidget is allowed to pick this motion group. */
      fidgetAllowed,
      /**
       * Whether a tap landed on the head (requirement #1).
       *
       * The stored box is in MODEL space, so the click is pushed through the
       * model's own inverse transform — the same mapping the engine uses for
       * gaze — which keeps it correct at any pet size or position.
       *
       * Returns true when the head could not be measured: an unrecognised model
       * keeps the previous "any tap reacts" behaviour instead of going inert.
       */
      hitsHead(x, y) {
        if (headBox === null || model === null || vendor === null) return true;
        try {
          // Pass one arg only: the engine then clones into a fresh Point, so
          // the stage-space input and the model-space output never alias.
          const point = model.toModelPosition(new vendor.Point(x, y));
          return point.x >= headBox.minX && point.x <= headBox.maxX
            && point.y >= headBox.minY && point.y <= headBox.maxY;
        } catch {
          return true;
        }
      },
      /** Diagnostic: the measured head box in model space, or null. */
      headBox: () => headBox,
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
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveStored(patch) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign(loadStored(), patch)));
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
    // Until the silhouette is known the whole box stays live, so the pet is
    // never inert; it degrades to the pre-mask behaviour instead of nothing.
    ROOT_SEL + " [data-stage][data-nomask]{pointer-events:auto;cursor:grab}",
    ROOT_SEL + " [data-bubble]{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:6px;max-width:min(240px,60vw);width:max-content;padding:7px 11px;border-radius:12px;background:linear-gradient(160deg,rgba(38,52,84,.95),rgba(21,28,46,.95));border:1px solid rgba(120,170,255,.3);box-shadow:0 8px 24px rgba(0,0,0,.35);color:#e8eefc;font:400 12px/1.5 inherit;white-space:pre-wrap;pointer-events:none}",
    // Sits outside the pet's box entirely, so it must re-arm itself.
    ROOT_SEL + " [data-panel]{position:absolute;right:calc(100% + 10px);bottom:0;width:270px;max-height:min(440px,72vh);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:rgba(22,29,46,.95);backdrop-filter:blur(14px);border:1px solid rgba(120,170,255,.24);box-shadow:0 14px 40px rgba(0,0,0,.44);color:#e8eefc;font:400 12px/1.5 inherit;pointer-events:auto}",
    ROOT_SEL + " [data-panel] header{display:flex;align-items:center;gap:6px;padding:9px 11px;border-bottom:1px solid rgba(120,170,255,.14);font-weight:600}",
    ROOT_SEL + " [data-panel] header select{flex:1;min-width:0;background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(120,170,255,.24);border-radius:7px;padding:4px 6px;font:inherit}",
    ROOT_SEL + " [data-panel] header [data-title]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ROOT_SEL + " [data-panel] header [data-close]{margin-left:auto;flex:none;width:22px;height:22px;padding:0;line-height:1;border:0;border-radius:6px;background:transparent;color:#9fb0cf;font:400 15px/1 inherit;cursor:pointer}",
    ROOT_SEL + " [data-panel] header [data-close]:hover{background:rgba(255,255,255,.14);color:#eaf1ff}",
    // The panel is the whole UI now, so it also owns the hint that tells you
    // how to get rid of it.
    ROOT_SEL + " [data-panel] [data-hintrow]{padding:0 10px 7px;color:#7f90ad;font-size:10px;line-height:1.5}",
    ROOT_SEL + " [data-panel] [data-tabs]{display:flex;gap:2px;padding:6px 8px 0}",
    ROOT_SEL + " [data-panel] [data-tabs] button{flex:1;border:0;background:transparent;color:#9fb0cf;font:600 11px/2 inherit;border-radius:7px;cursor:pointer}",
    ROOT_SEL + " [data-panel] [data-tabs] button[data-on]{background:rgba(120,170,255,.2);color:#eaf1ff}",
    ROOT_SEL + " [data-panel] [data-body]{flex:1;overflow:auto;padding:8px}",
    ROOT_SEL + " [data-panel] [data-group]{margin-bottom:9px}",
    ROOT_SEL + " [data-panel] [data-group]>span{display:block;margin:0 0 4px 2px;color:#8ea3c8;font-size:10px;letter-spacing:.06em}",
    ROOT_SEL + " [data-panel] [data-chips]{display:flex;flex-wrap:wrap;gap:4px}",
    ROOT_SEL + " [data-panel] [data-chips] button{border:1px solid rgba(120,170,255,.22);background:rgba(255,255,255,.055);color:#dce6f8;font:400 11px/1.5 inherit;padding:3px 8px;border-radius:999px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ROOT_SEL + " [data-panel] [data-chips] button:hover{background:rgba(120,170,255,.24)}",
    ROOT_SEL + " [data-panel] [data-chips] button[data-on]{background:rgba(120,170,255,.34);border-color:rgba(160,200,255,.55)}",
    ROOT_SEL + " [data-panel] footer{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid rgba(120,170,255,.14);color:#9fb0cf;font-size:11px}",
    ROOT_SEL + " [data-panel] footer input[type=range]{flex:1;min-width:0}",
    // 面板底部那根"大小"滑杆和设置页那排是同一套外观。
    ...sliderLook(ROOT_SEL + " [data-panel] footer input[type=range]"),
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

    // ---- 行：标签 / 权重条 / 数值 / × ----------------------------------
    // 用通用标记 `[data-pool-row]`（两张表都带），不是各自的唯一键属性 ——
    // 否则这里得把两个属性名都抄一遍，抄漏一个就是"那一层没排版"。
    scope + " [data-field],"
      + scope + " [data-pool-row]{display:grid;align-items:center;gap:8px;padding:2px 0}",
    scope + " [data-field]{grid-template-columns:104px 1fr 46px}",
    scope + " [data-pool-row]{grid-template-columns:1fr 72px 44px 22px 74px}",
    // 没有关系的条目：关系块是空的，`grid-column:1/-1` 的空元素不占高度（下面那条），
    // 于是整条就是干干净净一行。
    scope + " [data-relations]:empty{display:none}",
    scope + " [data-row-label]{font-size:11px;opacity:.85;overflow:hidden;"
      + "text-overflow:ellipsis;white-space:nowrap}",

    // ---- 权重条：一眼看出这个池子的概率分布 ----------------------------
    // `display:block` 不能省：span 默认是 inline，高度会被直接忽略 —— 表现是
    // "权重条根本没渲染出来"，而 DOM 里它明明在。
    scope + " [data-weight-bar]{display:block;position:relative;height:5px;"
      + "border-radius:999px;background:rgba(127,127,127,.2);overflow:hidden}",
    scope + " [data-weight-bar]>i{display:block;height:100%;border-radius:999px;"
      + "background:rgba(120,170,255,.8);transition:width .12s ease-out}",
    scope + " [data-pool-row][data-off] [data-weight-bar]>i{background:rgba(127,127,127,.5)}",
    scope + " [data-pool-row][data-off] [data-row-label]{opacity:.45;text-decoration:line-through}",

    // ---- 输入控件 ------------------------------------------------------
    // `box-sizing` 不能省：输入框和下拉默认是 content-box，`width:44px` 只量内容、
    // padding 和 border 另算 —— 实际占 44+12+2=58px，比 grid 给的 44px 列宽，
    // 表现就是输入框向右漫出来、压住 × 按钮。同样适用于第 5 列那个 74px 的
    // 「＋ 关系」下拉。
    scope + " input[type=number]{box-sizing:border-box;width:44px;text-align:center;font-size:11px;"
      + "-moz-appearance:textfield}",
    scope + " input[type=number]::-webkit-outer-spin-button,"
      + scope + " input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
    scope + " input[type=number]," + scope + " select{box-sizing:border-box;font:inherit;color:inherit;"
      + "background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.28);"
      + "border-radius:7px;padding:1px 6px;max-width:100%}",
    scope + " input[type=number]:hover," + scope + " select:hover{border-color:rgba(127,127,127,.5)}",
    scope + " input[type=range]{flex:1;min-width:80px}",
    // 滑杆外观（轨道/圆钮/填充）和面板底部那根共用，见 sliderLook。
    ...sliderLook(scope + " input[type=range]"),
    scope + " input[type=checkbox]{accent-color:rgba(120,170,255,.9)}",
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
    // 宽度要**写死**：select 的固有宽度按最长选项算（那是一串槽位名），不写死就会
    // 变成一条很宽的空框 —— 正是它原来看着最"原始"的原因。弹出列表不受这个宽度影响。
    scope + " [data-phase-add]," + scope + " [data-phase-slot-add]{text-align:left;padding:0 9px}",
    scope + " [data-relation-add]{text-align:left;padding:0 9px;width:74px}",
    scope + " [data-add-option]:hover," + scope + " [data-reset]:hover,"
      + scope + " [data-phase-add]:hover,"
      + scope + " [data-phase-slot-add]:hover," + scope + " [data-relation-add]:hover{"
      + "opacity:1;border-style:solid;border-color:rgba(120,170,255,.75);"
      + "background:rgba(120,170,255,.12)}",

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
    scope + " [data-pool-remove]," + scope + " [data-phase-remove],"
      + scope + " [data-pool-remove-slot]{justify-self:center;"
      + "width:20px;height:20px;line-height:1;font-size:13px;border-radius:6px;"
      + "opacity:.4;color:inherit}",
    scope + " [data-pool-remove]:hover," + scope + " [data-phase-remove]:hover,"
      + " [data-pool-remove-slot]:hover{opacity:1;"
      + "background:rgba(232,120,120,.2);color:#e87878}",
    // 槽位那一行的 × 贴在右边（它是"整张表"的动作，不是"这一条"的）。
    scope + " [data-pool-remove-slot]{margin-left:auto}",

    // ---- 相位：一张卡片套若干张槽位小卡 --------------------------------
    scope + " [data-phase]{border:1px solid rgba(127,127,127,.24);border-radius:10px;"
      + "margin:0 0 8px;overflow:hidden}",
    scope + " [data-phase-head]{display:flex;align-items:center;gap:8px;padding:6px 10px;"
      + "background:rgba(127,127,127,.07);border-bottom:1px solid rgba(127,127,127,.16)}",
    scope + " [data-phase-head][data-collapsed]{border-bottom:0}",
    scope + " [data-phase-toggle]{display:flex;align-items:center;gap:7px;flex:1;min-width:0;"
      + "font-size:12px;font-weight:600;text-align:left;color:inherit}",
    scope + " [data-caret]{font-size:9px;opacity:.55;width:9px}",
    scope + " [data-phase-meta]{font-size:10px;opacity:.5;font-weight:400;"
      + "font-variant-numeric:tabular-nums;white-space:nowrap}",
    scope + " [data-pool]{padding:7px 10px 8px 12px;"
      + "border-top:1px solid rgba(127,127,127,.13)}",
    // 相位头下面紧挨着的那张表不要再来一条分隔线（`[data-pool]:first-of-type`
    // 不可靠：空态那个 div 也是 div，会把它顶掉）。
    scope + " [data-phase-head]+[data-pool]{border-top:0}",
    scope + " [data-pool-head]{display:flex;align-items:center;gap:8px;padding:0 0 3px}",
    scope + " [data-pool-title]{font-size:11px;font-weight:600;opacity:.88}",
    scope + " [data-pool-meta]{font-size:10px;opacity:.42;font-variant-numeric:tabular-nums}",
    scope + " [data-pool-empty]{" + "font-size:10.5px;opacity:.45;padding:2px 0}",

    // ---- 空态 / 说明 ---------------------------------------------------
    scope + " [data-empty]{font-size:11px;opacity:.5;padding:6px 0}",
    scope + " [data-note]{font-size:10.5px;opacity:.55;padding-top:4px}",
    scope + " label{display:flex;align-items:center;gap:7px}",
  ]));
  // CSS 是一整个字符串（上面已经 join 过），不是数组 —— 别对它 concat 数组。
  const STYLE_TEXT = CSS + "\n" + SETTINGS_CSS.join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = STYLE_TEXT;
    document.head.appendChild(tag);
  }

  // ------------------------------------------------------------ lines

  const LINES = {
    greet: ["你好呀，我是鲸鱼娘～", "今天也一起加油吧！", "终于见到你了", "摸鱼时间到？"],
    click: ["呀！", "痒痒的～", "干嘛呀", "摸摸头？", "嘿嘿"],
    reset: ["表情归位～", "清清爽爽"],
    loadFailed: ["呜呜，模型加载失败了"],
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
    /** 指针离舞台多远仍能牵引视线，px。 */
    gazeRange: 240,
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
    { key: "gazeDeadzone", label: "注视死区", min: 0, max: 0.6, step: 0.01 },
    { key: "gazeRange", label: "注视范围 px", min: 0, max: 800, step: 10 },
    { key: "mouthFollow", label: "嘴跟随意", min: 0, max: 1, step: 0.05 },
    { key: "mouthDrop", label: "嘴形强度", min: -1, max: 1, step: 0.05 },
    { key: "mouthEaseMs", label: "嘴缓动 ms", min: 30, max: 800, step: 10 },
    { key: "blinkMinMs", label: "眨眼最短 ms", min: 600, max: 20000, step: 100 },
    { key: "blinkMaxMs", label: "眨眼最长 ms", min: 800, max: 40000, step: 100 },
    // 摸鱼那一组单独排，界面上分开展示（见 TUNING_GROUPS）。
    { key: "fidgetQuietMs", label: "静置多久开始", min: 2000, max: 120000, step: 1000, group: "fidget" },
    { key: "fidgetGapMs", label: "之后最长间隔", min: 4000, max: 300000, step: 1000, group: "fidget" },
  ];
  /** 可调项的分组（没写 group 的都归「手感」）。hint 显示在卡片右上角。 */
  const TUNING_GROUPS = [
    { id: "feel", label: "手感", hint: "指针 / 嘴 / 眨眼" },
    { id: "fidget", label: "摸鱼节奏", hint: "多久开始、间隔多长" },
  ];
  const tuningGroupOf = (field) => field.group ?? "feel";
  const TUNING_KEY = "dsh-pet-live2d.settings.v1";
  /** 装扮存档的 key。放这里是因为开关（applyFlag）也要用它清存档。 */
  const OUTFIT_KEY = "dsh-pet-live2d:outfit";

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
   *   phases: { <相位>: { motion: 组名|null, expression: 表情名|null } }
   *   fidget: { <槽位>: { none: 权重, options: { <选项标签>: 权重 } } }
   */
  /** 当前宠物的清单，给设置界面用（DSH 设置页拿不到组件里的 pet）。 */
  const MANIFEST = { current: null };

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
  const PHASE_OVERRIDES = { phases: {}, fidget: {}, relations: {} };

  /** 槽位 id -> 中文标签（关系行显示「贴纸」而不是 `sticker`）。 */
  const slotLabelOf = (slotId) =>
    (MANIFEST.current?.expressionSlots ?? []).find((slot) => slot.id === slotId)?.label ?? slotId;

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
  const FLAGS = { outfitArchive: true };
  const FLAG_DEFAULTS = Object.freeze(Object.assign({}, FLAGS));
  const OVERRIDE_KEY = "dsh-pet-live2d.settings.v2";

  const saveOverrides = () => {
    try {
      window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify(Object.assign({}, PHASE_OVERRIDES, { flags: FLAGS })));
    } catch {
      /* 无痕模式之类：这次生效，下次不记得 */
    }
  };

  /** 开关类设置：存档 + 广播（装扮存档开关关掉时顺带清掉那份存档）。 */
  const applyFlag = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(FLAGS, key)) return;
    FLAGS[key] = value === true;
    if (key === "outfitArchive" && FLAGS[key] === false) {
      try {
        window.localStorage.removeItem(OUTFIT_KEY);
      } catch {
        /* 无痕模式：本来也没存下 */
      }
    }
    saveOverrides();
    notifySettings();
  };

  /**
   * 条目表校验：一条 = `{ label, weight }`，label 为 null 表示「保持不变 / 空着」。
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
  const restoreOverrides = () => {
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(OVERRIDE_KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (saved === null || typeof saved !== "object") return;
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
    const flags = saved.flags;
    if (flags !== null && typeof flags === "object") {
      for (const key of Object.keys(FLAGS)) {
        if (typeof flags[key] === "boolean") FLAGS[key] = flags[key];
      }
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
   * 摸鱼池的**条目表**：一条 = 一个候选（label=null 表示「保持不变」）。
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
   * 摸鱼要遍历的槽位：**默认六个 + 用户自己加过的**。
   *
   * 默认集合（`FIDGET_SLOTS`）只是宠物给的一份建议 —— 手、情绪、脸红、嘴、眼睛。
   * 用户问过"为什么摸鱼里面不能加槽位和候选"，答案是这两件事当时都被我写死在代码里
   * 了：界面上只列那六个，运行时也只认那六个。没有任何理由，删掉这个限制。
   */
  const fidgetSlotsFor = (pet) => {
    const ids = FIDGET_SLOTS.slice();
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
    try {
      window.localStorage.setItem(TUNING_KEY, JSON.stringify(TUNING));
    } catch {
      /* 无痕模式之类：这次改动仍然生效，只是下次不记得 */
    }
    notifySettings();
  };

  /**
   * 启动时把存档里的可调项读回来（每个值都按区间夹一遍）。
   *
   * 手改坏了存档最多回到合法范围，不会出现「死区 5」这种把宠物冻住的配置。
   */
  const restoreTuning = () => {
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(TUNING_KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (saved === null || typeof saved !== "object") return;
    let restored = false;
    for (const field of TUNING_FIELDS) {
      const value = saved[field.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      TUNING[field.key] = clampSetting(field, value);
      restored = true;
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
    const fields = TUNING_FIELDS.filter((field) => only === undefined || tuningGroupOf(field) === only);
    return h("div", { "data-settings": "", "data-setting": only ?? "all" },
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
      only === undefined || only === "feel"
        ? h("div", { "data-add-row": "" },
          h("button", {
            type: "button",
            "data-reset": "tuning",
            onClick: () => applyTuning(Object.assign({}, TUNING_DEFAULTS)),
          }, "恢复默认"))
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
        h("span", { "data-row-label": "" }, "跨启动记住装扮"),
      ),
      h("div", { "data-note": "" },
        "眼镜 / 发饰 / 魔爪 / 巴菲 / 桌布 / 手机换色 —— ",
        FLAGS.outfitArchive ? "关掉会同时清掉已存的那套。" : "已关闭，也不再记录。"),
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

  /** Chance that a fidget with the phone out also takes a photo. */
  const SELFIE_CHANCE = 0.4;


  /**
   * What a head pat may answer with (requirement #5).
   *
   * One of these at random, and no blush — the blush is what a tap used to add
   * unconditionally, which made every pat look identical.
   */
  const HEAD_PAT_REACTIONS = [
    { motion: "Hammer" },
    { expression: "问号" },
    { expression: "星星眼" },
  ];

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

  function Pet() {
    const stageRef = useRef(null);
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
      api.phaseNow = (phase) => { if (typeof phase === "string") flushPhaseRef.current?.(phase); };
      api.phaseTally = () => phaseTallyRef.current;
      api.resetPhaseTally = () => { phaseTallyRef.current = {}; };
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
      window.__dshLive2dPet.expressions = () => Object.keys(pinnedRef.current);
      // Programmatic pin set, for diagnostics and the regression suite. It goes
      // through the same funnel as the panel, so slot rules apply identically.
      window.__dshLive2dPet.setExpressions = (names) => {
        const next = {};
        for (const name of names || []) next[name] = true;
        applyExpressionsRef.current(next);
      };
    }
    const [motionGroup, setMotionGroup] = useState("");

    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState(null);
    const [coreMissing, setCoreMissing] = useState(false);
    const [ready, setReady] = useState(false);
    const [bubble, setBubble] = useState(null);
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
    const clampBottom = (value, width) =>
      Math.max(-Math.round(width * BOTTOM_OVERHANG_RATIO), Math.min(window.innerHeight - 60, value));

    const [petId, setPetId] = useState(() => loadStored().petId);
    const [size, setSize] = useState(() => {
      const stored = loadStored().size;
      return typeof stored === "number" && stored >= MIN_SIZE && stored <= MAX_SIZE ? stored : DEFAULT_SIZE;
    });
    const [pos, setPos] = useState(() => {
      const stored = loadStored();
      return {
        right: typeof stored.right === "number" ? Math.max(0, stored.right) : 24,
        // 存档里可能是负的（用户把它压到了屏幕下边），别把它夹回 0。
        bottom: typeof stored.bottom === "number" ? Math.max(-BOTTOM_OVERHANG_MAX, stored.bottom) : 0,
      };
    });

    sizeRef.current = size;
    posRef.current = pos;

    const pet = catalog !== null && catalog.pets.length > 0
      ? (catalog.pets.find((entry) => entry.id === petId) ?? catalog.pets[0])
      : undefined;

    const say = useCallback((text) => {
      setBubble(text);
      window.clearTimeout(bubbleTimer.current);
      bubbleTimer.current = window.setTimeout(() => setBubble(null), 4200);
    }, []);

    useEffect(() => () => window.clearTimeout(bubbleTimer.current), []);

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
        currentModel.scale.set(fit * fitRef.scale);
        currentModel.position.set(width / 2 + fitRef.x, height / 2 + fitRef.y);
        // Keep the gaze anchored to the model's own centre after a resizeso a
        // stale pointer position cannot leave it staring off-frame.
        focusDefault();
      };
      layoutRef.current = layout;

      const boot = async () => {
        if (!await ensureCore(catalog.coreUrl)) {
          if (!disposed) setCoreMissing(true);
          return;
        }
        if (disposed) return;
        setCoreMissing(false);
        const vendor = await ensureVendor(catalog.vendorUrl);
        if (disposed) return;
        if (vendor === undefined) throw new Error("vendor bundle unavailable");
        configureVendor(vendor);

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

        const loaded = await vendor.Live2DModel.from(pet.modelUrl, {
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
          say(pick(LINES.loadFailed));
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

    // ---- greeting -----------------------------------------------------
    useEffect(() => {
      if (!ready || greeted.current) return;
      greeted.current = true;
      say(pick(LINES.greet));
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
        const rect = stage.getBoundingClientRect();
        // The DEFAULT resting target is the model's own centre — not the last
        // pointer position — so the pet always settles back to a neutral gaze.
        motion.current.updatePointer(rect.width / 2, rect.height / 2, rect.width, rect.height);
        reportGaze("center");
      };
      let resting = false;
      focusDefault();
      resting = true;
      const onMove = (event) => {
        const rect = stage.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const near = x >= -TUNING.gazeRange && y >= -TUNING.gazeRange
          && x <= rect.width + TUNING.gazeRange && y <= rect.height + TUNING.gazeRange;
        if (near) {
          resting = false;
          motion.current.updatePointer(x, y, rect.width, rect.height);
          reportGaze("pointer");
        } else if (!resting) {
          resting = true;
          focusDefault();
        }
      };
      /**
       * 指针「不在场」了：回正。
       *
       * 鼠标一旦移出窗口，pointermove 就不再发来，宠物会**僵在最后一个注视方向**上
       * （用户报的就是这个）。页面拿不到窗口外的指针位置——那需要原生钩子，浏览器
       * 里没有这个能力——所以这里能做的是回正：离开窗口 / 窗口失焦 / 切标签页，
       * 都当成指针不在场，视线与嘴一起缓动回中位。
       */
      const onLeave = () => {
        if (resting) return;
        resting = true;
        focusDefault();
      };
      const root = document.documentElement;
      root.addEventListener("mouseleave", onLeave);
      window.addEventListener("blur", onLeave);
      document.addEventListener("visibilitychange", onLeave);
      window.addEventListener("pointermove", onMove, { passive: true });
      return () => {
        window.removeEventListener("pointermove", onMove);
        root.removeEventListener("mouseleave", onLeave);
        window.removeEventListener("blur", onLeave);
        document.removeEventListener("visibilitychange", onLeave);
        focusDefaultRef.current = () => {};
      };
    }, [ready]);

    // ---- imperative actions -------------------------------------------
    // Every manual play is a one-shot through the controller: it stops the
    // previous motion, forces the new one past the priority gate, and returns
    // to idle afterwards even when the motion is flagged Loop.
    const playMotion = useCallback((group, index) => {
      motion.current.playOnce(group, index, { kind: "panel" });
    }, []);

    // The pinned expression is re-layered after every motion start: a motion
    // resets expression parameters as it takes over, so a pinned face would
    // otherwise be wiped the moment the pet plays a reaction.
    const applyExpressions = useCallback((next) => {
      setPinned(next);
      pinnedRef.current = next;
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
      try {
        const out = {};
        for (const id of OUTFIT_SLOTS) {
          const label = slotSelectionsRef.current[id];
          if (label !== undefined) out[id] = label;
        }
        window.localStorage.setItem(OUTFIT_KEY, JSON.stringify(out));
      } catch {
        /* 无痕模式之类存不下：不影响这次，只是下次不记得 */
      }
    };
    const readOutfit = () => {
      if (!FLAGS.outfitArchive) return null;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(OUTFIT_KEY) ?? "null");
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
    const chooseSlotOption = useCallback((slot, option) => {
      // 关系（同时 / 前提）是按**选项**生效的：用户在这里改过的内容必须对面板点选、
      // 摸鱼抽中、相位抽中同时成立，所以统一在这一个入口合成。
      option = effectiveOption(slot.id, option);
      const next = Object.assign({}, pinnedRef.current);
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
      saveOutfit();
          if (!wanted && typeof target.options.find((o) => o.label === label)?.motion === "string") {
            slotMotionRef.current = null;
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
      applyExpressions(next);
      // A motion attached to a slot plays and PARKS on its last frame, so the
      // chosen look stays put instead of dropping back to the idle loop.
      const chosen = Object.assign({}, slotSelectionsRef.current);
      if (option === null) delete chosen[slot.id];
      else chosen[slot.id] = option.label;
      slotSelectionsRef.current = chosen;
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
      let desired = null;
      for (const other of petRef.current?.expressionSlots ?? []) {
        const label = slotSelectionsRef.current[other.id];
        if (label === undefined) continue;
        const picked = other.options.find((o) => o.label === label);
        if (typeof picked?.motion === "string") { desired = picked.motion; break; }
      }
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
      // A dress-up choice PERSISTS. The auto-clear exists so a reaction or a
      // session phase cannot leave the pet stuck, but an outfit is an explicit
      // choice the user reverses from this panel (or with 归位), and expiring it
      // after a few seconds would make the panel feel broken.
      window.clearTimeout(expressionTimer.current);
    }, [applyExpressions]);

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
      commitPinsRef.current();
      motion.current.resetToRest();
      say(pick(LINES.reset));
    }, [applyExpressions, say]);

    /**
     * 启动时把上次的装扮穿回来。
     *
     * 放在 ready 之后：那时 catalog 已经填好 slotByIdRef，能校验存档里的
     * label 在当前 pet.json 里还存在（换模型/改配置之后存档可能对不上，
     * 对不上就当没存过，不要凭空造一个选项出来）。
     */
    const outfitRestoredRef = useRef(false);
    useEffect(() => {
      if (outfitRestoredRef.current || !ready) return;
      if (slotByIdRef.current.size === 0) return;
      outfitRestoredRef.current = true;
      const saved = readOutfit();
      if (saved === null) return;
      const chosen = Object.assign({}, slotSelectionsRef.current);
      let restored = false;
      for (const id of OUTFIT_SLOTS) {
        const label = saved[id];
        if (typeof label !== "string") continue;
        if (slotByIdRef.current.get(id)?.options.some((o) => o.label === label) !== true) continue;
        chosen[id] = label;
        restored = true;
      }
      if (!restored) return;
      slotSelectionsRef.current = chosen;
      commitPinsRef.current();
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
      };
      // The sustain loop lives in the controller, but the phase -> group map
      // comes from the pet manifest, so hand the resolver over. 池子里抽到过动作的
      // 相位优先用它自己那一轮的结果，否则重播的会是另一套动作。
      motion.current.setPhaseResolver((phase) => phaseGroupRef.current[phase] ?? phaseMotionRef.current[phase]);
      // Premise check for a motion group. Evaluated against the CURRENT slot
      // selections, so it stays true while the look keeps the phone out and goes
      // false the moment the slot changes.
      motion.current.setGuardResolver((group) => {
        const guard = guardsRef.current[group];
        if (guard === undefined) return true;
        return Object.entries(guard).every(([slotId, labels]) => {
          // 相位"抽空了"这个槽位时不能退回用户的选择：owns 为真且值是 null 就是空。
          const owns = Object.prototype.hasOwnProperty.call(phaseChoicesRef.current, slotId);
          const chosen = owns ? phaseChoicesRef.current[slotId] : slotSelectionsRef.current[slotId];
          return chosen !== undefined && chosen !== null && labels.includes(chosen);
        });
      });
      // The motion subscription (declared above) flushes a deferred phase here.
      flushPhaseRef.current = applyPhase;
      const onMessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        const phase = payload?.phase;
        if (typeof phase !== "string") return;
        setPhaseState(phase);
        if (phase === phaseRef.current) return;
        phaseRef.current = phase;
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
        const usable = (slot) => entriesOf(slot).map((pair) => pair[0]).filter((option) => option !== null);
        // Weighted draw over "leave it alone" plus the usable options. The mouth
        // carries a heavy fidgetNone so the pet mostly looks normal rather than
        // pulling a face every time it idles.
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
        const pool = slots.filter((slot) => usable(slot).length > 0);
        fidgetTallyRef.current.poolSize = slots.length + "/" + pool.length;
        if (pool.length === 0) { schedule(); return; }
        // 每个池子各自 roll 一次 —— 手部、情绪、脸红、嘴、眼睛**同时**摇，
        // 而不是"这次只摇一两个槽位"。用户要的是每次摸鱼都重新掷一遍所有池子，
        // 组合出来的样子才会变；只摇一个的话，其余槽位永远停在上一次的结果上，
        // 摸鱼看起来就总是同一套。
        // "保持不变"仍然由各槽位自己的 fidgetNone 权重决定（嘴 8、眼 11…），
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
        // With the phone already out, a fidget sometimes takes a photo — the
        // whole reason the phone slot exists. The selfie's own guard requires the
        // phone, so this can only fire when it is genuinely out.
        const phoneOut = () => slotSelectionsRef.current.rhand === "掏出手机";
        const phoneWanted = changes.some(([slot, option]) => slot.id === "rhand" && option?.label === "掏出手机")
          || phoneOut();
        if (phoneWanted && motion.current.canPlay("Selfie") && Math.random() < SELFIE_CHANCE) {
          changes.push([null, { label: "__selfie__", selfie: true }]);
        }
        for (const [slot, option] of changes) {
          if (slot === null) {
            // Not a slot choice: a one-shot reaction that parks like the rest.
            const group = Math.random() < 0.5 ? "Selfie" : "SelfieQuick";
            if (motion.current.canPlay(group)) {
              motion.current.playOnce(group, 0, { kind: "fidget", hold: true, persist: true });
            }
            continue;
          }
          fidgetTallyRef.current.picked[slot.id] = (fidgetTallyRef.current.picked[slot.id] ?? 0) + 1;
          const key = slot.id + ":" + (option === null ? "无" : option.label);
          fidgetTallyRef.current.drawn[key] = (fidgetTallyRef.current.drawn[key] ?? 0) + 1;
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
     * The character's silhouette as CSS `clip-path` path data (requirement #5).
     * Empty until the alpha mask has been extracted; while empty the proxy is
     * hidden and the stage keeps its old full-box behaviour.
     */
    const [maskPath, setMaskPath] = useState("");
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

    const onContextMenu = useCallback((event) => {
      event.preventDefault();
      setPanelOpen(true);
    }, []);

    const onPointerDown = useCallback((event) => {
      if (event.button !== 0) return;
      // A press on a transparent corner only ever starts a drag: it must not
      // arm a click reaction, which is what made the whole square feel live.
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        right: posRef.current.right,
        bottom: posRef.current.bottom,
        moved: false,
        onModel: hitsModel(event.clientX, event.clientY),
        // Resolved once, at press time: the model keeps swaying, so asking
        // again on release could answer differently than the press did.
        onHead: hitsHead(event.clientX, event.clientY),
      };
      setDragging(true);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    }, [hitsModel, hitsHead]);

    useEffect(() => {
      const onMove = (event) => {
        const state = dragState.current;
        if (state === null) return;
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (!state.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        state.moved = true;
        const width = sizeRef.current;
        const nextPos = {
          right: Math.max(0, Math.min(window.innerWidth - width, state.right - dx)),
          bottom: clampBottom(state.bottom - dy, width),
        };
        setPos(nextPos);
      };
      const onUp = () => {
        const state = dragState.current;
        if (state === null) return;
        dragState.current = null;
        setDragging(false);
        if (state.moved) {
          lastInteraction.current = Date.now();
          setPos((current) => {
            saveStored({ right: Math.round(current.right), bottom: Math.round(current.bottom) });
            return current;
          });
        } else if (state.onModel) {
          lastInteraction.current = Date.now();
          if (state.onHead) {
            // Patting the head picks ONE of three reactions at random
            // (requirement #5) — and deliberately does not blush. The two face
            // reactions are transient: they are flashed and the auto-clear
            // takes them away, so a pat never leaves a permanent face on a
            // slot the user chose.
            const reaction = pick(HEAD_PAT_REACTIONS);
            if (reaction.motion !== undefined) {
              const groups = motion.current.groups();
              const tap = [reaction.motion, "TapHead", "tap_head"].find((group) => Array.isArray(groups[group]));
              if (tap !== undefined) motion.current.playOnce(tap, 0, { kind: "tap" });
            } else if (reaction.expression !== undefined) {
              flashExpression(reaction.expression);
            }
            say(pick(LINES.click));
          } else {
            // Anywhere else on the character is a lighter acknowledgement —
            // deliberately WITHOUT 重锤出击, which now belongs to the head only.
            say(pick(LINES.click));
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
    useEffect(() => { saveStored({ petId }); if (petId !== undefined) applyExpressions({}); }, [petId, applyExpressions]);

    if (catalog !== null && catalog.pets.length === 0) {
      return h("div", { [PET_ATTR]: "", style: rootStyle(size, pos) },
        h("div", { "data-hint": "" },
          h("div", null, "还没有可用的 Live2D 宠物。"),
          h("div", { style: { marginTop: 6 } }, "把宠物目录放到："),
          h("code", null, "%DSH_HOME%\\pets\\<id>\\pet.json"),
        ),
      );
    }

    let overlay = null;
    if (coreMissing) {
      overlay = h("div", { "data-hint": "" },
        h("div", null, h("b", null, "缺少 Live2D Cubism Core 运行时")),
        h("div", { style: { marginTop: 6 } }, "请把官方 live2dcubismcore.min.js 放到："),
        h("code", null, "%DSH_HOME%\\pets\\.runtime\\live2dcubismcore.min.js"),
      );
    } else if (error !== null) {
      overlay = h("div", { "data-hint": "" },
        h("div", null, h("b", null, "加载失败")),
        h("div", { style: { marginTop: 6, opacity: .8, fontSize: 11 } }, error),
      );
    } else if (!ready) {
      overlay = h("div", { "data-hint": "", style: { opacity: .65 } }, "加载模型…");
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
                }, catalog.pets.map((entry) => h("option", { key: entry.id, value: entry.id }, entry.displayName)))
              : h("span", { "data-title": "" }, pet.displayName),
            h("button", {
              type: "button",
              "data-close": "",
              title: "关闭（Esc）",
              onClick: () => setPanelOpen(false),
            }, "×"),
          ),
          h("div", { "data-tabs": "" },
            h("button", { type: "button", ...(tab === "motions" ? { "data-on": "" } : {}), onClick: () => setTab("motions") }, "动作 " + pet.motions.length),
            // 表情 and 装扮 are one menu now: all 44 expressions are slots
            // (glasses, stickers, hair, cloth, claws, desk, hands, then eyes,
            // mood, mouth, symbols, ambience, blush, desk actions).
            h("button", { type: "button", ...(tab === "slots" ? { "data-on": "" } : {}), onClick: () => setTab("slots") }, "装扮 " + (pet.expressionSlots ?? []).length),
            h("button", { type: "button", ...(tab === "settings" ? { "data-on": "" } : {}), onClick: () => setTab("settings") }, "设置"),
          ),
          h("div", { "data-body": "" }, tab === "slots"
            // Dress-up slots: one choice each, and choices in different slots
            // coexist (glasses AND cat ears AND a dark tablecloth).
            ? (pet.expressionSlots ?? []).map((slot) => {
                // An option is active when every expression it carries is pinned:
                // 白魔爪 needs the claw AND its recolour, so checking only the
                // first would light it up for 粉魔爪 too.
                // Selected = the label this slot actually holds. NOT
                // "every expression is pinned": a motion-only option has an EMPTY
                // expression list, and [].every(...) is vacuously true, so
                // 掏出手机 and 吹泡泡糖 rendered as permanently pressed.
                const chosenLabel = slotSelectionsRef.current[slot.id];
                const active = slot.options.find((option) => option.label === chosenLabel);
                return h("div", { "data-group": "", key: slot.id, "data-slot": slot.id },
                  h("span", null, slot.label),
                  h("div", { "data-chips": "" },
                    h("button", {
                      type: "button",
                      key: "__none",
                      ...(active === undefined ? { "data-on": "" } : {}),
                      onClick: () => chooseSlotOption(slot, null),
                    }, slot.none),
                    slot.options.map((option) => h("button", {
                      type: "button",
                      key: option.label,
                      ...(option.label === chosenLabel ? { "data-on": "" } : {}),
                      "data-slot-option": option.label,
                      onClick: () => chooseSlotOption(slot, option),
                    }, option.label)),
                  ),
                );
              })
            : tab === "settings"
            // 和 DSH 设置页共用同一个正文（值也共用一份，见模块里的 store）。
            ? h("div", { "data-settings": "" }, h(PetSettingsBody, null))
            : tab === "motions"
            ? pet.motions.filter((entry) => !(pet.hiddenMotions ?? []).includes(entry.group))
              .map((entry) => h("div", { "data-group": "", key: entry.group },
                h("span", null, entry.label),
                h("div", { "data-chips": "" },
                  Array.from({ length: entry.count }, (_, index) => h("button", {
                    key: index,
                    type: "button",
                    ...(motionGroup === entry.group ? { "data-on": "" } : {}),
                    "data-motion-group": entry.group,
                    onClick: () => playMotion(entry.group, index),
                  }, entry.count > 1 ? "第 " + (index + 1) + " 段" : "播放")),
                ),
              ))
            : null,
          ),
          h("div", { "data-hintrow": "" }, "在宠物身上点右键打开这里 · Esc 或点空白处关闭"),
          h("footer", null,
            h("button", { type: "button", title: "缩小", onClick: () => setSize((current) => Math.max(MIN_SIZE, current - 40)) }, "－"),
            h("input", {
              type: "range", min: MIN_SIZE, max: MAX_SIZE, step: 20, value: size,
              title: size + "px",
              style: { "--fill": fillOf(size, MIN_SIZE, MAX_SIZE) + "%" },
              onChange: (event) => setSize(Number(event.target.value)),
            }),
            h("button", { type: "button", title: "放大", onClick: () => setSize((current) => Math.min(MAX_SIZE, current + 40)) }, "＋"),
            h("span", { "data-sizelabel": "" }, size + "px"),
            h("button", { type: "button", onClick: resetAll }, "归位"),
          ),
        )
      : null;

    return h("div", {
      [PET_ATTR]: "",
      ref: rootRef,
      style: rootStyle(size, pos),
      // Observability: the committed action of the motion state machine
      // ('idle' while resting) and the current gaze target, so the pet's
      // behaviour is inspectable without reaching into engine internals.
      "data-motion": motionGroup === "" ? "idle" : motionGroup,
      "data-gaze": gaze,
      "data-phase": phase,
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
        h("div", {
          "data-hit": "",
          ...(maskPath === "" ? { "data-off": "" } : { style: { clipPath: "path('" + maskPath + "')", WebkitClipPath: "path('" + maskPath + "')" } }),
          ...(maskPath === "" ? {} : { onPointerDown, onContextMenu }),
        }),
      ),
      bubble === null ? null : h("div", { "data-bubble": "" }, bubble),
      panel,
    );
  }



  /** Positioning lives on the pet's own root div, so it works whether it is
   * reached through the React container or not. */
  function rootStyle(size, pos) {
    return { width: size, height: size, right: pos.right, bottom: pos.bottom };
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
  function PhaseControls() {
    useSettings();
    // 折叠状态是**每个界面自己的**（设置页和右键面板互不影响），默认全展开：
    // 折叠是给"配好之后收起来"用的，不是默认藏起来。
    const [folded, setFolded] = useState({});
    const pet = MANIFEST.current;
    if (pet === null) return h("div", { "data-empty": "phases" }, "宠物还没加载好");
    const slots = pet.expressionSlots ?? [];
    const known = Array.from(new Set([
      ...Object.keys(PHASE_MOTION),
      ...Object.keys(pet.looksByPhase ?? {}),
      ...Object.keys(PHASE_OVERRIDES.phases),
    ])).sort();
    const rows = known.filter((phase) => PHASE_OVERRIDES.phases[phase] !== undefined);
    const missing = known.filter((phase) => PHASE_OVERRIDES.phases[phase] === undefined);
    return h("div", { "data-settings": "", "data-setting": "phases" },
      rows.length === 0
        ? h("div", { "data-empty": "phases" }, "还没有定制过的相位 —— 在下面挑一个开始")
        : null,
      rows.map((phase) => {
        const pools = phasePoolsFor(phase);
        const used = Object.keys(pools);
        const free = slots.filter((slot) => used.indexOf(slot.id) === -1);
        const open = folded[phase] !== true;
        const candidates = used.reduce((sum, slotId) => sum + (pools[slotId] ?? []).length, 0);
        return h("div", { key: phase, "data-phase": phase },
          h("div", { "data-phase-head": "", ...(open ? {} : { "data-collapsed": "" }) },
            h("button", {
              type: "button",
              "data-phase-toggle": phase,
              title: open ? "收起来" : "展开",
              onClick: () => setFolded((prev) => Object.assign({}, prev, { [phase]: !(prev[phase] === true) })),
            },
            h("span", { "data-caret": "" }, open ? "▾" : "▸"),
            h("span", null, phase),
            h("span", { "data-phase-meta": "" }, used.length + " 槽位 · " + candidates + " 条候选"),
            ),
            h("button", {
              type: "button",
              "data-phase-remove": phase,
              title: "删掉整个相位（回到 pet.json 的默认）",
              onClick: () => removePhaseRow(phase),
            }, "×"),
          ),
          open ? [
            used.length === 0
              ? h("div", { "data-pool-empty": "", key: "empty" }, "空相位：什么都不改 —— 在下面加一个槽位")
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
                noneLabel: "空着",
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
            free.length === 0 ? null : h("div", { key: "addslot", "data-add-row": "" },
              free.map((slot) => h("button", {
                key: slot.id,
                type: "button",
                "data-phase-slot-add": phase,
                "data-add-option": slot.id,
                title: "给这个相位加一张槽位表",
                onClick: () => {
                  // 新加的槽位先给一张**空表**：空表 = 这个槽位在这个相位下不出手。
                  // 想让它清空，就加一条「空着」。
                  setPhasePool(phase, slot.id, []);
                },
              }, "＋ " + slot.label))),
          ] : null,
        );
      }),
      missing.length === 0 ? null : h("div", { "data-add-row": "" },
        missing.map((phase) => h("button", {
          key: phase,
          type: "button",
          "data-phase-add": phase,
          title: "加一个要定制的相位",
          onClick: () => {
            // 只登记一行，池子先不落盘 —— 这样"加一行再删掉"不会留下任何覆盖，
            // 而打开它时看到的就是 pet.json 原本的默认样子。
            applyOverride({ phases: { [phase]: {} } });
          },
        }, "＋ " + phase))),
    );
  }

  /**
   * 摸鱼：每个槽位一张**条目表**，每条一行、可删，右上角 ＋ 可加。
   *
   * 一条 = 一个候选：`保持不变`（label 为 null）或某个选项。删掉某条就是把它
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
      title: kind === "pair" ? "选了它就一起点亮" : "必须先处于这个状态才播得出来",
    },
    h("b", null, kind === "pair" ? "同时" : "前提"),
    // 两种关系都写全「槽位 = 选项」：只写选项名的话（"同时：猫猫"）看不出猫猫是
    // 贴在哪个槽位上的，而关系恰恰是跨槽位的东西。
    targetSlot === null || targetSlot === undefined
      ? "：" + label
      : "：" + slotLabelOf(targetSlot) + " = " + label,
    h("button", {
      type: "button",
      "data-relation-remove": "",
      title: "删掉这条关系",
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
    // 自己槽位的选项不能当关系：`同时` 指向本槽位 = 把自己换成另一个，没意义；
    // `前提` 指向自己 = 永远满足不了。
    const others = [];
    for (const other of MANIFEST.current?.expressionSlots ?? []) {
      if (other.id === slot.id) continue;
      for (const option of other.options ?? []) {
        if (option.label === entry.label) continue;
        others.push({ slot: other.id, slotLabel: other.label, label: option.label });
      }
    }
    const options = (kind) => others
      .filter((item) => (kind === "pair"
        ? pairs[item.slot] !== item.label
        : !requires.some((row) => row.slot === item.slot && row.label === item.label)))
      .map((item) => h("option", {
        key: item.slot + ":" + item.label,
        value: kind + "|" + item.slot + "|" + item.label,
      }, item.slotLabel + " = " + item.label));
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
    h("option", { value: "" }, "＋ 关系"),
    pairOptions.length === 0 ? null : h("optgroup", { label: "同时" }, pairOptions),
    requireOptions.length === 0 ? null : h("optgroup", { label: "前提" }, requireOptions),
    );
  }

  /** 条目表里一条的唯一键：`保持不变 / 空着` 统一记成 `__none`。 */
  const entryKeyOf = (entry) => (entry.label === null || entry.label === undefined ? "__none" : entry.label);

  /**
   * 一张**条目表**：摸鱼池和相位池共用的那张。
   *
   * 两个池子本来就是同一套东西（用户原话"相位跟摸鱼是一样的功能"），差别只有三处，
   * 所以全部做成参数：
   *   - `setEntries` —— 存哪儿（摸鱼按槽位存，相位还要带相位名）
   *   - `noneLabel`  —— 条目空值叫什么：摸鱼是「保持不变」，相位是「空着」
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
    const labelOf = (entry) => (entry.label === null || entry.label === undefined ? noneLabel : entry.label);
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
      .concat(candidates.map((option) => ({ value: option.label, label: option.label })))
      .filter((item) => !present.has(item.value));
    // 权重条按**占池子总权重的比例**画：它就是这个条目被抽中的概率。
    // 分母为 0（全是 0 或空表）时退化成一条空槽，不会出现 NaN 宽度。
    const total = entries.reduce((sum, entry) => sum + (entry.weight > 0 ? entry.weight : 0), 0);
    const add = (value) => setEntries(entries.concat([{ label: value === "__none" ? null : value, weight: 1 }]));
    return h("div", { "data-pool": owner, "data-pool-slot": slot.id },
      h("div", { "data-pool-head": "" },
        h("span", { "data-pool-title": "" }, slot.label),
        h("span", { "data-pool-meta": "" },
          entries.length === 0 ? "空表" : entries.length + " 条候选"),
        // 用户自己加进来的槽位可以整个拿掉（默认集合不给删：它们是宠物自己的身子，
        // 删了这张表就再也回不来了）。
        typeof props.removeSlot === "function" ? h("button", {
          type: "button",
          "data-pool-remove-slot": slot.id,
          title: "把这个槽位从池子里拿掉",
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
        h("span", { "data-weight-bar": "", title: share + "% 的概率" },
          h("i", { "data-weight-fill": "", style: { width: share + "%" } })),
        numberInput(entry.weight, (value) => {
          const next = entries.slice();
          next[index] = { label: entry.label ?? null, weight: value };
          setEntries(next);
        }, { "data-pool-weight": "", [weightAttr]: keyOf(entry) }),
        h("button", {
          type: "button",
          "data-pool-remove": "",
          [removeAttr]: keyOf(entry),
          title: "删掉这一条",
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
        ? h("div", { "data-pool-empty": "" }, "空表：这个槽位在这个池子里不出手")
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
    if (pet === null) return h("div", { "data-empty": "fidget" }, "宠物还没加载好");
    const used = fidgetSlotsFor(pet);
    const occupied = new Set(used.map((slot) => slot.id));
    const free = (pet.expressionSlots ?? [])
      .filter((slot) => !occupied.has(slot.id) && (slot.options ?? []).length > 0);
    return h("div", { "data-settings": "", "data-setting": "fidget" },
      used.length === 0
        ? h("div", { "data-empty": "fidget" }, "还没有槽位 —— 在下面挑一个加进来")
        : null,
      used.map((slot) => h(PoolTable, {
        key: slot.id,
        slot,
        entries: fidgetEntriesFor(slot),
        noneLabel: "保持不变",
        // 候选**全都**能加：`fidget:false` 只决定"默认池子里有没有它"，不决定
        // "能不能配"。原先这里传 false，于是 吐舌 / 星星眼 这些在界面上根本点不到。
        allowAll: true,
        owner: "fidget",
        // 默认那六个不给删（它们是宠物自己的身子，删了列表就空了）；加进来的可以。
        removeSlot: FIDGET_SLOTS.includes(slot.id) ? null : () => removeFidgetSlot(slot.id),
        rowAttr: "data-fidget-row",
        addAttr: "data-fidget-add",
        weightAttr: "data-fidget-weight",
        removeAttr: "data-fidget-remove",
        setEntries: (entries) => setFidgetEntries(slot.id, entries),
      })),
      // 和条目候选同一个药丸样式：`data-add-option` 是 SETTINGS_CSS 里
      // `[data-add-option]` 药丸规则的钩子，漏了它就是裸按钮（下面 docs-and-workflow
      // 也有一节讲这个：面板里曾经整节都是裸控件）。
      free.length === 0 ? null : h("div", { "data-add-row": "" },
        free.map((slot) => h("button", {
          key: slot.id,
          type: "button",
          "data-fidget-slot-add": slot.id,
          "data-add-option": slot.id,
          title: "把这个槽位加进摸鱼池",
          onClick: () => addFidgetSlot(slot.id),
        }, "＋ " + slot.label))),
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
  function PetSettingsBody() {
    useSettings();
    const card = (key, title, hint, body) => h("div", { key, "data-card": key },
      h("div", { "data-card-head": "" },
        h("span", { "data-card-title": "" }, title),
        hint === null || hint === undefined ? null : h("span", { "data-card-hint": "" }, hint),
      ),
      h("div", { "data-card-body": "" }, body),
    );
    return [
      // 卡片 key 必须各不相同：TUNING_GROUPS 里那个 "fidget" 是"摸鱼节奏"，
      // 和下面"摸鱼"那张池子卡不是一回事，同名会让 data-card 变成歧义的。
      ...TUNING_GROUPS.map((group) => card("tune-" + group.id, group.label, group.hint,
        h(TuningControls, { group: group.id }))),
      card("phases", "会话相位", "每个相位一组池子", h(PhaseControls, null)),
      card("pools", "摸鱼", "每个槽位一张条目表", h(FidgetControls, null)),
      card("outfit", "装扮", null, h(OutfitControls, null)),
    ];
  }

  /** DSH 设置页里的「桌宠」一节。 */
  function PetSettingsSection() {
    return h("div", { "data-pet-settings": "" }, h(PetSettingsBody, null));
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
        label: () => "桌宠",
      }, () => h(PetSettingsSection, null)));
    } catch {
      /* 老版本 DSH 没有这个 slot：右键面板那份还在，不影响使用 */
    }
  }

  function apply(ctx) {
    ensureStyle();
    // 设置值在模块作用域，客户端启动时读一次存档就够了。
    restoreTuning();
    restoreOverrides();
    applySettings(ctx);
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
