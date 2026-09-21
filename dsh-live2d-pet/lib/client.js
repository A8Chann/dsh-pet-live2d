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
window.__ModuleLoader__.load({ id: "dsh-live2d-pet", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  const react = require("react");
  const h = react.createElement;
  const { useCallback, useEffect, useRef, useState } = react;

  const name = "live2d-pet";
  const inject = [];

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
    const ENGINE_OWNED_PARAM = /^Param(Angle|Eye|Mouth|Body|Breath|Brow)/;
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
        const k = 1 - Math.exp(-dt / MOUTH_EASE_MS);
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
        if (blinkAt === 0) blinkAt = now + BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
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
            blinkAt = now + BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
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
            add(MOUTH_OPEN_PARAM, mouthFollow * (params.maximumValues[openAt] - params.minimumValues[openAt]) * MOUTH_FOLLOW);
          }
          // Scale the author's own open-mouth direction by how high the pointer
          // is: up leans the shape the way selfie.motion3.json does, down leans
          // it the other way.
          add(MOUTH_FORM_PARAM, mouthLean * MOUTH_DROP);
          // The CONTRIBUTION, not the absolute value: the absolute one also
          // carries the pose's own resting shape, which is not ours to assert.
          mouthWritten = {
            open: Number((mouthFollow * MOUTH_FOLLOW).toFixed(3)),
            form: Number((mouthLean * MOUTH_DROP).toFixed(3)),
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
        // The pose to put back is the one the RELEASE seam sees: the
        // outstanding release if this parameter is in it, otherwise the
        // engine's own value.
        //
        // Neither neighbour works. The raw value alone is the frozen motion
        // output once a release is installed — recording that is how the second
        // cycle of 吹泡泡糖 "restored" an inflated mouth. The DRAWN value folds
        // in the layers' own contributions, and restoring those would count
        // them twice: the release would re-apply the mouth's old offset and the
        // mouth pass would add its current one on top.
        const value = releasedOverrides !== null
          && Object.prototype.hasOwnProperty.call(releasedOverrides, id)
          ? releasedOverrides[id]
          : readParameter(id);
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
          if (size <= GAZE_DEADZONE) return 0;
          const t = Math.min(1, (size - GAZE_DEADZONE) / (1 - GAZE_DEADZONE));
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
    ROOT_SEL + " [data-panel] footer [data-sizelabel]{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}",
    ROOT_SEL + " [data-panel] footer button{border:0;background:transparent;color:#9fb0cf;font:inherit;cursor:pointer}",
    ROOT_SEL + " [data-hint]{position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;color:#c3cee6;font-size:12px;line-height:1.6}",
    ROOT_SEL + " [data-hint] code{display:block;margin-top:5px;font-size:11px;opacity:.85;word-break:break-all}",
  ].join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = CSS;
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

  /** How far outside the stage the pointer still steers the gaze, in px. */
  const GAZE_RANGE = 240;

  /** How long a tap may move, in px, before it counts as a drag. */
  const DRAG_SLOP_PX = 4;

  /** Quiet time before the first idle fidget, and the randomised gap after. */
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
  const GAZE_DEADZONE = 0.12;

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
  const MOUTH_DROP = 0.7;

  /**
   * Time constant for the mouth easing, in milliseconds.
   *
   * The gaze is already smooth because the engine lerps its focus controller,
   * but the mouth was written straight from the pointer event, so moving in or
   * out of range snapped it open and shut. ~170ms reads as a reaction rather
   * than a cut.
   */
  const MOUTH_EASE_MS = 170;

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
  const BLINK_MIN_MS = 2200;
  const BLINK_MAX_MS = 6400;
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
  const MOUTH_FOLLOW = 0.65;

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

    const [pinned, setPinned] = useState({});
    const [dragging, setDragging] = useState(false);
    const [petId, setPetId] = useState(() => loadStored().petId);
    const [size, setSize] = useState(() => {
      const stored = loadStored().size;
      return typeof stored === "number" && stored >= MIN_SIZE && stored <= MAX_SIZE ? stored : DEFAULT_SIZE;
    });
    const [pos, setPos] = useState(() => {
      const stored = loadStored();
      return {
        right: typeof stored.right === "number" ? Math.max(0, stored.right) : 24,
        bottom: typeof stored.bottom === "number" ? Math.max(0, stored.bottom) : 0,
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
      phaseMotionRef.current = Object.assign({}, PHASE_MOTION, pet.motionsByPhase || {});
      phaseExpressionRef.current = Object.assign({}, PHASE_EXPRESSION, pet.expressionsByPhase || {});
      looksByPhaseRef.current = pet.looksByPhase || {};
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
        const near = x >= -GAZE_RANGE && y >= -GAZE_RANGE
          && x <= rect.width + GAZE_RANGE && y <= rect.height + GAZE_RANGE;
        if (near) {
          resting = false;
          motion.current.updatePointer(x, y, rect.width, rect.height);
          reportGaze("pointer");
        } else if (!resting) {
          resting = true;
          focusDefault();
        }
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      return () => {
        window.removeEventListener("pointermove", onMove);
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
    commitPinsRef.current = () => {
      const merged = Object.assign({}, userPinsRef.current);
      // A phase owns the slots it names. Overriding key-by-key is not enough:
      // 蛋包饭 and 画笔 are DIFFERENT expressions, so a user-chosen 蛋包饭 would
      // stay pinned through the whole session and put omurice on screen.
      for (const slotId of phaseSlotsRef.current) {
        const slot = slotByIdRef.current.get(slotId);
        for (const option of slot?.options ?? []) {
          for (const name of option.expressions) delete merged[name];
        }
      }
      applyExpressions(Object.assign(merged, phasePinsRef.current));
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
      if (desired !== null && (desired !== previous || option !== null)) {
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
      slotSelectionsRef.current = {};
      commitPinsRef.current();
      motion.current.resetToRest();
      say(pick(LINES.reset));
    }, [applyExpressions, say]);

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
       * Drive the motion + expression for one session phase.
       *
       * A phase is a STATE, not a one-shot event: 'waiting', 'tool' and 'done'
       * can each last many seconds, so they are handed to the controller's
       * sustain loop, which re-triggers the motion until the phase changes
       * (requirement #4). Everything else simply plays once and settles.
       */
      const applyPhase = (phase) => {
        // A phase is a whole LOOK, expressed in the panel's own vocabulary
        // (requirement #10), so it drives several slots at once — and every one
        // of them includes a whale, so the pet is never idle-looking mid-session.
        const look = looksByPhaseRef.current[phase];
        const slotById = new Map((pet?.expressionSlots ?? []).map((slot) => [slot.id, slot]));
        const pins = {};
        if (look !== undefined) {
          for (const [slotId, label] of Object.entries(look)) {
            const option = slotById.get(slotId)?.options.find((o) => o.label === label);
            if (option === undefined) continue;
            for (const name of option.expressions) pins[name] = true;
            for (const name of option.requires ?? []) pins[name] = true;
          }
        }
        phasePinsRef.current = pins;
        phaseSlotsRef.current = Object.keys(look ?? {});
        phaseChoicesRef.current = Object.assign({}, look ?? {});
        // A phase may also need a generated animation (the tool phase writes).
        let sweep = null;
        if (look !== undefined) {
          for (const [slotId, label] of Object.entries(look)) {
            const option = slotById.get(slotId)?.options.find((o) => o.label === label);
            if (option?.sweep !== undefined) sweep = option.sweep;
          }
        }
        phaseSweepRef.current = sweep;
        applySweep();
        commitPinsRef.current();
        const group = phaseMotionRef.current[phase];
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
      // comes from the pet manifest, so hand the resolver over.
      motion.current.setPhaseResolver((phase) => phaseMotionRef.current[phase]);
      // Premise check for a motion group. Evaluated against the CURRENT slot
      // selections, so it stays true while the look keeps the phone out and goes
      // false the moment the slot changes.
      motion.current.setGuardResolver((group) => {
        const guard = guardsRef.current[group];
        if (guard === undefined) return true;
        return Object.entries(guard).every(([slotId, labels]) => {
          const chosen = phaseChoicesRef.current[slotId] ?? slotSelectionsRef.current[slotId];
          return chosen !== undefined && labels.includes(chosen);
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
        const wait = IDLE_FIDGET_MIN_MS + Math.random() * (IDLE_FIDGET_MAX_MS - IDLE_FIDGET_MIN_MS);
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
        if (!force && (busy || quietFor < IDLE_FIDGET_MIN_MS || phaseRef.current !== "idle")) {
          schedule();
          return;
        }
        const slots = (pet?.expressionSlots ?? [])
          .filter((slot) => FIDGET_SLOTS.includes(slot.id) && slot.options.length > 0);
        if (slots.length === 0) {
          schedule();
          return;
        }
        lastInteraction.current = Date.now();
        // Options that may come up at all: a motion whose premise is missing is
        // out (a selfie with no phone would set the pins and play nothing), and
        // so is anything the pet marked fidget:false — 吐舌 does not belong in
        // an idle 摸鱼.
        const usable = (slot) => slot.options.filter((o) =>
          (typeof o.motion !== "string" || motion.current.canPlay(o.motion)) && o.fidget !== false);
        // Weighted draw over "leave it alone" plus the usable options. The mouth
        // carries a heavy fidgetNone so the pet mostly looks normal rather than
        // pulling a face every time it idles.
        const draw = (slot) => {
          const opts = usable(slot);
          if (opts.length === 0) return null;
          const weightOf = (o) => (typeof o.fidgetWeight === "number" && o.fidgetWeight > 0 ? o.fidgetWeight : 1);
          const entries = [[null, typeof slot.fidgetNone === "number" ? slot.fidgetNone : 1]]
            .concat(opts.map((o) => [o, weightOf(o)]));
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
        // "可以只选其中一个或者多个": one or two slots at a time.
        const count = 1 + Math.floor(Math.random() * 2);
        const picked = pool.slice().sort(() => Math.random() - 0.5).slice(0, count);
        const changes = picked.map((slot) => [slot, draw(slot)]);
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
    /** phase -> slot-vocabulary look, from the pet manifest (requirement #10). */
    const looksByPhaseRef = useRef({});
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
        setPos({
          right: Math.max(0, Math.min(window.innerWidth - width, state.right - dx)),
          bottom: Math.max(0, Math.min(window.innerHeight - 60, state.bottom - dy)),
        });
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

  function apply(ctx) {
    ensureStyle();
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
