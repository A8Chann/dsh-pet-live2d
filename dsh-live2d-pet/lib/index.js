/**
 * dsh-live2d-pet — host half.
 *
 * A self-contained Live2D desk-pet plugin for the DSH Web GUI. It is
 * deliberately independent of any other pet plugin: it discovers Live2D pet
 * directories itself, serves their model reference closure, serves the Live2D
 * runtime files, and answers one catalog endpoint the browser half renders.
 *
 * Discovery follows the DSH pet convention: every directory under
 * '$DSH_HOME/pets/<id>/' holding a pet.json whose 'renderer' is 'live2d'.
 * The model's declared reference closure (moc3, textures, motions, physics,
 * expressions) is the allow-list the asset route serves — a crafted '..'
 * segment can never match, and realpath containment is the second layer.
 *
 * The proprietary Cubism Core runtime is NEVER bundled or downloaded by this
 * plugin: it is read from the user-supplied
 * '$DSH_HOME/pets/.runtime/live2dcubismcore.min.js'.
 *
 * buildRoutes() is exported so the same route table can be mounted by the
 * DSH web server (apply) and by tests.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'live2d-pet'

export const inject = ['webServer']

/** Browser-facing API base. */
export const API = '/api/live2d-pet'

/** Size ceilings per served file class, in bytes. */
const CAP_JSON = 64 * 1024
const CAP_IMAGE = 24 * 1024 * 1024
const CAP_MODEL = 48 * 1024 * 1024
const CAP_RUNTIME = 24 * 1024 * 1024

const MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.js': 'application/javascript; charset=utf-8',
}

/** $DSH_HOME (defaults to ~/.dsh). */
export function dshHome() {
  const raw = process.env.DSH_HOME
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : join(homedir(), '.dsh')
}

/** Directory holding every installed pet. */
export function petsRoot() {
  return join(dshHome(), 'pets')
}

/** Directory holding the user-supplied Live2D runtime files. */
export function runtimeDir() {
  return join(petsRoot(), '.runtime')
}

/** Package root of this plugin (lib/ -> package root), resolved once. */
let packageRoot
export function pluginRoot() {
  packageRoot ??= fileURLToPath(new URL('..', import.meta.url))
  return packageRoot
}

/** Plain JSON read that never throws. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Safe relative path: no absolute paths, no backslashes, no traversal, plain segments. */
export function safeRel(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[\\/]/.test(value)) return undefined
  const segments = value.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) return undefined
  return segments.join('/')
}

/**
 * The reference closure of one Cubism model3.json — exactly the files the
 * asset route may serve for the pet that declares it.
 */
export function modelClosure(model3) {
  const out = new Set()
  if (typeof model3 !== 'object' || model3 === null) return out
  const refs = model3.FileReferences
  if (typeof refs !== 'object' || refs === null) return out
  const push = (raw) => {
    const safe = safeRel(raw)
    if (safe !== undefined) out.add(safe)
  }
  if (refs.Moc !== undefined) push(refs.Moc)
  if (Array.isArray(refs.Textures)) refs.Textures.forEach(push)
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) if (refs[key] !== undefined) push(refs[key])
  if (Array.isArray(refs.Expressions)) {
    for (const expression of refs.Expressions) {
      if (typeof expression === 'object' && expression !== null) push(expression.File)
    }
  }
  if (typeof refs.Motions === 'object' && refs.Motions !== null) {
    for (const motions of Object.values(refs.Motions)) {
      if (!Array.isArray(motions)) continue
      for (const motion of motions) {
        if (typeof motion === 'object' && motion !== null) push(motion.File)
      }
    }
  }
  return out
}

/**
 * Validate a pet's declared dress-up slots.
 *
 * Anything malformed is dropped rather than passed on: the browser half renders
 * these straight into buttons, so a slot without an id, or an option without an
 * expression, would produce a dead control. An empty result simply means the pet
 * has no dress-up panel, which is the right outcome for a model that needs none.
 */
/**
 * Validate a procedural sweep.
 *
 * A sweep drives model parameters from a generated curve instead of from a
 * baked motion. Only the channels the pet actually names are kept, so a typo in
 * one axis cannot silently produce a stationary hand.
 */
function normaliseSweep(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const axes = {}
  for (const key of ['x', 'y', 'z', 'rz']) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') axes[key] = raw[key].trim()
  }
  if (Object.keys(axes).length === 0) return null
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    ...axes,
    ampX: num(raw.ampX, 16),
    ampY: num(raw.ampY, 8),
    ampZ: num(raw.ampZ, 6),
    // One full trace of the loop, in milliseconds. The pen never lifts: the
    // path closes on itself, which is what makes it read as flowing rather
    // than as a series of strokes being snapped back to the margin.
    loopMs: num(raw.loopMs, 2600),
    // Optional slow drift, so a long-running loop does not look pinned to one
    // spot. 0 keeps it a pure closed curve.
    driftMs: num(raw.driftMs, 0),
    driftY: num(raw.driftY, 0),
  }
}

function normaliseSlots(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const slot of raw) {
    if (typeof slot !== 'object' || slot === null) continue
    const id = typeof slot.id === 'string' ? slot.id.trim() : ''
    if (id === '') continue
    const options = []
    for (const option of Array.isArray(slot.options) ? slot.options : []) {
      if (typeof option !== 'object' || option === null) continue
      // An option may need SEVERAL expressions: this model's 白魔爪 is
      // 魔爪换色 layered on 桌面粉魔爪, and the recolour alone renders nothing
      // because there is no claw to recolour. Accept either shape so a pet can
      // write the common single case without an array.
      const raw = Array.isArray(option.expressions)
        ? option.expressions
        : (typeof option.expression === 'string' ? [option.expression] : [])
      const expressions = []
      for (const name of raw) {
        if (typeof name !== 'string') continue
        const trimmed = name.trim()
        if (trimmed !== '' && !expressions.includes(trimmed)) expressions.push(trimmed)
      }
      // An option may also drive a MOTION, because some of this model's actions
      // sit at the same level as an expression: 吹泡泡糖 belongs with the mouth,
      // 掏出手机 and 挤番茄酱 with the hand. `requires` lists expressions that must
      // be on for the action to make sense (挤番茄酱 needs 蛋包饭 first).
      const motion = typeof option.motion === 'string' && option.motion.trim() !== ''
        ? option.motion.trim()
        : null
      const requires = []
      for (const name of Array.isArray(option.requires) ? option.requires : []) {
        if (typeof name === 'string' && name.trim() !== '' && !requires.includes(name.trim())) {
          requires.push(name.trim())
        }
      }
      // Slots this option must RESET. 写本本 is a right-hand action that needs the
      // left hand empty first, and "empty" is another slot's choice, so the
      // option has to be able to clear it.
      const clears = []
      for (const id of Array.isArray(option.clears) ? option.clears : []) {
        if (typeof id === 'string' && id.trim() !== '' && !clears.includes(id.trim())) clears.push(id.trim())
      }
      // A SWEEP is an animation this plugin generates, for parameters the model
      // left unanimated. This model ships 点菜手X/Y/Z (pointX/pointY/pointY2) with
      // a ±30 range and NOTHING driving them — the author meant the hand to
      // follow the mouse and never wired it up. Writing a curve per frame turns
      // them into a hand that actually writes on the tablet.
      // Options that cannot be worn together, named by their LABEL. 吐魂 and
      // 吹泡泡糖 write different parameters, so nothing in the engine stops them
      // overlapping — but the soul leaving the mouth on top of a bubble-gum
      // pucker is one mouth doing two things.
      const conflicts = []
      for (const label of Array.isArray(option.conflicts) ? option.conflicts : []) {
        if (typeof label === 'string' && label.trim() !== '' && !conflicts.includes(label.trim())) {
          conflicts.push(label.trim())
        }
      }
      // Pairs and breaks, for options that travel with (or rule out) another
      // slot's choice: 喵喵手 only makes sense with the cat sticker on, and any
      // other hand pose means the sticker should come off.
      const pairs = {}
      if (typeof option.pairs === 'object' && option.pairs !== null) {
        for (const [slotId, label] of Object.entries(option.pairs)) {
          if (typeof slotId === 'string' && typeof label === 'string' && label !== '') pairs[slotId] = label
        }
      }
      const breaks = []
      for (const label of Array.isArray(option.breaks) ? option.breaks : []) {
        if (typeof label === 'string' && label.trim() !== '' && !breaks.includes(label.trim())) breaks.push(label.trim())
      }
      const sweep = normaliseSweep(option.sweep)
      // Fidget weighting. Most of the time the mouth should simply be normal,
      // and a couple of options should never come up on their own at all, so the
      // idle fidget needs more than a uniform draw.
      const fidgetOff = option.fidget === false
      const fidgetWeight = typeof option.fidgetWeight === 'number' && option.fidgetWeight > 0
        ? option.fidgetWeight
        : 1
      if (expressions.length === 0 && motion === null && sweep === null) continue
      options.push({
        label: typeof option.label === 'string' && option.label !== ''
          ? option.label
          : (expressions[0] ?? motion),
        expressions,
        ...(motion === null ? {} : { motion }),
        ...(requires.length === 0 ? {} : { requires }),
        ...(clears.length === 0 ? {} : { clears }),
        ...(sweep === null ? {} : { sweep }),
        ...(conflicts.length === 0 ? {} : { conflicts }),
        ...(Object.keys(pairs).length === 0 ? {} : { pairs }),
        ...(breaks.length === 0 ? {} : { breaks }),
        ...(fidgetOff ? { fidget: false } : {}),
        ...(fidgetWeight === 1 ? {} : { fidgetWeight }),
      })
    }
    if (options.length === 0) continue
    out.push({
      id,
      label: typeof slot.label === 'string' && slot.label !== '' ? slot.label : id,
      none: typeof slot.none === 'string' && slot.none !== '' ? slot.none : '无',
      // How strongly the idle fidget should prefer leaving this slot alone.
      // The mouth sets it high so the pet mostly looks normal.
      ...(typeof slot.fidgetNone === 'number' && slot.fidgetNone > 0 ? { fidgetNone: slot.fidgetNone } : {}),
      options,
    })
  }
  return out
}

/**
 * 名字里带这些字的部件算"头"：作者在 cdi3 里给每个部件起了中文名
 * （`Part46` = 脸蛋、`Part57/58` = 眼睛、`Part14` = 头发、`Part45/68` = 耳朵…）。
 */
const HEAD_PART_NAME_HINTS = /头|脸|面|眼|眉|嘴|耳|发|eye|face|hair|head|ear|brow|mouth|cheek|nose/i

/**
 * 名字里带这些字的部件算"尾巴/翅膀"（这只宠物有 15 个：狐狸尾 / 猫尾 / 狼尾 / 大翅膀…，
 * 都是可换的配件，同一时刻只有一个是显形的）。
 */
const TAIL_PART_NAME_HINTS = /尾|鳍|翅|翼|fin|tail|wing/i

/**
 * 从 cdi3 里按名字挑部件。
 *
 * 为什么要读 cdi3：摸头/摸尾巴要知道"哪些 drawable 是头、是尾巴"。原来浏览器半区用的是
 * 写死的英文正则（`face|eye|mouth|…`），而这只模型的 drawable id 是 `Part46` 这种 ——
 * **一个都匹配不上**，于是判定静默退化成"点哪都算头"。作者自己的中文名才是权威分类。
 *
 * @returns {string[]} 部件 id；没有 cdi3 或没挑到就是空数组（浏览器半区会退回旧行为）。
 */
function readPartsMatching(dir, modelPath, hints) {
  try {
    const base = modelPath.replace(/\.model3\.json$/i, '')
    const file = findCdi3(dir, base)
    if (file === undefined) return []
    const cdi3 = readJson(file)
    const parts = cdi3?.Parts
    if (!Array.isArray(parts)) return []
    const out = []
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      const id = typeof part.Id === 'string' ? part.Id : undefined
      if (id === undefined || id === '') continue
      const name = typeof part.Name === 'string' ? part.Name : ''
      if (!hints.test(name) && !hints.test(id)) continue
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 找 cdi3.json。
 *
 * 它**不在** model3.json 的引用里（那是 Cubism Editor 的元数据，运行时不读），所以只能
 * 按约定找：与模型同名的 `<base>.cdi3.json` 优先，其次模型旁边、再其次宠物目录和它的
 * 直接子目录 —— 这只宠物就放在 `model/` 子目录里，只在根目录找会一个都挑不到。
 */
function findCdi3(dir, base) {
  const direct = [join(dir, base + '.cdi3.json'), join(dir, 'model', base + '.cdi3.json')]
  for (const file of direct) {
    if (existsSync(file)) return file
  }
  const roots = [dir]
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') roots.push(join(dir, entry.name))
    }
  } catch {
    /* 读不了就只用 dir 本身 */
  }
  for (const root of roots) {
    try {
      const hit = readdirSync(root).find((name) => name.toLowerCase().endsWith('.cdi3.json'))
      if (hit !== undefined) return join(root, hit)
    } catch {
      /* 跳过读不了的目录 */
    }
  }
  return undefined
}

/**
 * 互动反应候选：一串标签（动作的中文名，或表情名）。非字符串/空的都丢掉。
 */
function readReactionList(value) {
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name !== '') : []
}

/** Scan one pet directory into a catalog entry, or undefined when unusable. */
export function scanPet(dir, id) {
  const manifestFile = join(dir, 'pet.json')
  if (!existsSync(manifestFile)) return undefined
  const manifest = readJson(manifestFile)
  if (manifest === undefined || typeof manifest !== 'object' || manifest === null) return undefined
  if (manifest.renderer !== 'live2d') return undefined
  const block = manifest.live2d
  if (typeof block !== 'object' || block === null) return undefined
  const modelPath = safeRel(block.model)
  if (modelPath === undefined || !modelPath.endsWith('.model3.json')) return undefined
  const modelFile = join(dir, modelPath)
  if (!existsSync(modelFile)) return undefined
  const model3 = readJson(modelFile)
  if (model3 === undefined) return undefined
  const closure = modelClosure(model3)
  if (closure.size === 0) return undefined
  // The model descriptor itself rides the same route: the browser fetches it
  // first, then every file it names, so it belongs in the servable set.
  closure.add(modelPath)

  // Labels/categories are optional host-only metadata shipped beside the
  // manifest ('catalog.json'); the authoritative motion/expression lists
  // always come from the model itself, so a pet without one still lists
  // everything, just with the model's own names.
  const labels = readJson(join(dir, 'catalog.json')) ?? {}
  const labelFor = (kind, key) => {
    const list = labels[kind]
    if (!Array.isArray(list)) return undefined
    const hit = list.find((entry) => entry !== null && typeof entry === 'object' && entry.key === key)
    return hit === undefined ? undefined : hit
  }

  // Every motion entry carries its own duration and loop flag, read from the
  // motion3.json the model references. The browser half needs both: the
  // engine refuses to restart a still-active group+index, and a motion
  // flagged Loop never emits motionFinish — so playback has to be driven by
  // the model's own timing instead of by that event alone.
  const motions = []
  const motionGroups = model3.FileReferences?.Motions
  if (typeof motionGroups === 'object' && motionGroups !== null) {
    for (const [group, list] of Object.entries(motionGroups)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const meta = labelFor('motions', group)
      const items = list.map((entry, index) => {
        const file = typeof entry === 'object' && entry !== null ? safeRel(entry.File) : undefined
        const motionMeta = file === undefined ? undefined : readJson(join(dir, file))
        const rawDuration = motionMeta?.Meta?.Duration
        // Every parameter the motion writes. The browser half needs this to
        // clean up after a one-shot action: a motion such as 吹泡泡糖 drives
        // its own mouth/pose parameters that the idle loop does NOT drive, so
        // once the motion stops its last written value stays on the model
        // forever unless something puts it back ("泡泡吹完嘴没还原").
        const params = []
        const curves = motionMeta?.Curves
        if (Array.isArray(curves)) {
          for (const curve of curves) {
            if (curve?.Target === 'Parameter' && typeof curve.Id === 'string' && curve.Id !== '') {
              params.push(curve.Id)
            }
          }
        }
        return {
          index,
          duration: typeof rawDuration === 'number' && rawDuration > 0 ? Math.round(rawDuration * 1000) : 0,
          loop: motionMeta?.Meta?.Loop === true,
          params,
        }
      })
      motions.push({
        group,
        count: items.length,
        label: meta?.label ?? group,
        category: meta?.category ?? 'action',
        items,
      })
    }
  }

  const expressions = []
  const expressionRefs = model3.FileReferences?.Expressions
  if (Array.isArray(expressionRefs)) {
    for (const reference of expressionRefs) {
      if (typeof reference !== 'object' || reference === null) continue
      const expressionName = typeof reference.Name === 'string' && reference.Name !== '' ? reference.Name : reference.File
      if (typeof expressionName !== 'string') continue
      const meta = labelFor('expressions', expressionName)
      // Ship each expression's own parameter writes.
      //
      // The engine's expression pipeline loads the file correctly (44
      // definitions, the right parameter count, weight 1) but never actually
      // moves a parameter, so nothing it plays is visible. The browser half
      // therefore applies these values itself through the same parameter
      // machinery it already uses for motions — which also gives the UI the
      // per-expression data it needs to work out which effects conflict.
      const file = safeRel(reference.File)
      const params = []
      if (file !== undefined) {
        let parsed
        try {
          parsed = readJson(join(dir, file))
        } catch {
          parsed = undefined
        }
        if (Array.isArray(parsed?.Parameters)) {
          for (const parameter of parsed.Parameters) {
            if (typeof parameter?.Id !== 'string' || parameter.Id === '') continue
            const value = Number(parameter.Value)
            if (!Number.isFinite(value)) continue
            const blend = parameter.Blend === 'Multiply' ? 'Multiply'
              : parameter.Blend === 'Overwrite' ? 'Overwrite' : 'Add'
            params.push({ id: parameter.Id, value, blend })
          }
        }
      }
      expressions.push({
        name: expressionName,
        label: meta?.label ?? expressionName,
        category: meta?.category ?? 'other',
        file: file ?? '',
        params,
      })
    }
  }

  return {
    id,
    displayName: typeof manifest.displayName === 'string' && manifest.displayName !== '' ? manifest.displayName : id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    scale: typeof block.scale === 'number' && block.scale > 0 && block.scale <= 10 ? block.scale : 1,
    // The manifest's phase -> motion-group / expression maps (same keys the
    // catalog uses), so the browser half can retarget session phases per pet.
    motionsByPhase: typeof block.motions === 'object' && block.motions !== null ? block.motions : {},
    // Per-motion playback policy (hold / reset / prepend) declared by the pet.
    // See the browser half's motion controller: a model whose motion3.json all
    // say "Loop": true cannot express "play once and hold the pose" or "clean
    // up the mouth afterwards" on its own, so the pet says it here.
    motionOptions: typeof block.motionOptions === 'object' && block.motionOptions !== null ? block.motionOptions : {},
    expressionsByPhase: typeof block.expressions === 'object' && block.expressions !== null ? block.expressions : {},
    // Mutually exclusive dress-up slots. Several of the model's expressions are
    // switches for the same thing (three pairs of glasses, three stickers), so
    // the pet declares which may not be worn together; the browser half turns
    // that into a one-choice-per-slot panel.
    expressionSlots: normaliseSlots(block.expressionSlots),
    // Session phase -> a whole LOOK expressed in slot vocabulary
    // ({ whale: "头顶鲸", lhand: "画笔" }), so a phase drives several slots at
    // once instead of a single expression.
    looksByPhase: typeof block.looksByPhase === 'object' && block.looksByPhase !== null ? block.looksByPhase : {},
    // motion group -> { slotId: [acceptable option labels] }. A motion whose
    // premise is missing (a selfie with no phone out, a spray with no whale)
    // must not play at all, from ANY path: the panel, a fidget or a phase.
    motionGuards: typeof block.motionGuards === 'object' && block.motionGuards !== null ? block.motionGuards : {},
    // 头部 / 尾巴部件（部件 id）：摸头、摸尾巴按这些部件的**真实几何**判定。
    // 空数组 = 没 cdi3 或没挑到，浏览器半区退回旧行为。
    headParts: readPartsMatching(dir, modelPath, HEAD_PART_NAME_HINTS),
    tailParts: readPartsMatching(dir, modelPath, TAIL_PART_NAME_HINTS),
    // 台词：宠物自己的声音（问候 / 点击 / 摸头 / 摸尾巴 / 转晕 / 归位 / 每个相位）。
    // 用户能在设置里逐条改，改过的存浏览器；这里是**默认值**。
    lines: typeof block.lines === 'object' && block.lines !== null ? block.lines : {},
    // 互动反应候选（标签：动作的中文名或表情名）。摸头 / 摸尾巴 / 转晕各一组。
    patReactions: readReactionList(block.patReactions),
    tailReactions: readReactionList(block.tailReactions),
    spinReactions: readReactionList(block.spinReactions),
    // 摸鱼默认盯哪几个槽位。以前这六个是**写死在浏览器半区**的（"宠物自己的身子"），
    // 但宠物作者（和用户）会想改：这只宠物把「自拍」也放进了摸鱼池。写在这里之后，
    // "默认集合"也成了宠物自己声明的东西，用户加的槽位照样覆盖在上面。
    fidgetSlots: Array.isArray(block.fidgetSlots) ? block.fidgetSlots.filter((id) => typeof id === 'string') : [],
    // Motion groups that belong to the SLOT menu rather than the 动作 tab.
    // 掏出手机 and 吹泡泡糖 are slot choices now; listing them twice made the
    // same thing reachable two ways, and the tab copy could not hold a pose.
    hiddenMotions: Array.isArray(block.hiddenMotions) ? block.hiddenMotions.filter((m) => typeof m === 'string') : [],
    translate: {
      x: typeof block.translate?.x === 'number' ? block.translate.x : 0,
      y: typeof block.translate?.y === 'number' ? block.translate.y : 0,
    },
    dir,
    modelPath,
    modelUrl: API + '/asset/' + encodeURIComponent(id) + '/' + modelPath.split('/').map(encodeURIComponent).join('/'),
    closure,
    motions,
    expressions,
  }
}

/** Build the live catalog from disk (fresh per request, so installs are picked up). */
/**
 * 把**随包分发**的宠物装进用户的宠物目录。
 *
 * 以前宠物是仓库里单独一份，装插件的人还得自己再拷一次 —— 从插件市场装完
 * 「看不见宠物」就是这么来的（插件包里有代码，没有模型）。
 *
 * 为什么模型能随包、Cubism Core 不能：模型是 CC BY-NC-SA 4.0，且 Live2D 作者
 * 已明确授权本项目转载与开源（见 pets/ds-whale-girl/LICENSE）；Core 是 Live2D Inc.
 * 的专有软件，只允许从官方渠道取，所以它走 CDN 兜底那条路。
 *
 * 只在目标**不存在**时复制：用户自己改过的宠物永远优先，绝不覆盖。
 */
export function installBundledPets() {
  const bundled = join(pluginRoot(), 'pets')
  if (!existsSync(bundled)) return
  let names = []
  try {
    names = readdirSync(bundled).filter((entry) => !entry.startsWith('.'))
  } catch {
    return
  }
  for (const name of names) {
    const source = join(bundled, name)
    const target = join(petsRoot(), name)
    try {
      if (!statSync(source).isDirectory()) continue
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    } catch {
      /* 只读文件系统之类：让用户自己拷，别让整个目录扫描失败 */
    }
  }
}

export function buildCatalog() {
  installBundledPets()
  const root = petsRoot()
  if (!existsSync(root)) return []
  let names = []
  try {
    names = readdirSync(root).filter((entry) => !entry.startsWith('.'))
  } catch {
    return []
  }
  names.sort()
  const pets = []
  for (const entry of names) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const pet = scanPet(dir, entry)
    if (pet !== undefined) pets.push(pet)
  }
  return pets
}

/** realpath containment; a symlink escaping its root is refused. */
function contained(base, candidate) {
  try {
    const realBase = realpathSync(base)
    const realCandidate = realpathSync(candidate)
    return realCandidate === realBase || realCandidate.startsWith(realBase + sep) ? realCandidate : undefined
  } catch {
    return undefined
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

/** Weak validator from size + mtime. */
function weakEtag(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'
}

/** Serve one file with containment, size ceiling and revalidation. */
function serveFile(request, response, base, file, cap) {
  const resolved = contained(base, file)
  if (resolved === undefined) {
    response.writeHead(403)
    response.end()
    return
  }
  let stat
  try {
    stat = statSync(resolved)
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > cap) {
      response.writeHead(413)
      response.end()
      return
    }
  } catch {
    response.writeHead(404)
    response.end()
    return
  }
  const etag = weakEtag(stat)
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag, 'cache-control': 'no-cache' })
    response.end()
    return
  }
  readFile(resolved).then((body) => {
    response.writeHead(200, {
      'content-type': MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-cache',
      etag,
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(body)
  }, () => {
    response.writeHead(404)
    response.end()
  })
}

/** Loopback-only fence: the pet API never answers a non-local peer. */
function loopbackOnly(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Split a request path into the segments after one known prefix. */
function segmentsAfter(pathname, prefix) {
  if (!pathname.startsWith(prefix + '/')) return undefined
  return pathname.slice(prefix.length + 1).split('/')
}

/** The catalog route (GET /api/live2d-pet/catalog). */
function catalogRoute() {
  return {
    kind: 'exact',
    path: API + '/catalog',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      sendJson(response, 200, {
        ok: true,
        coreUrl: API + '/runtime/live2dcubismcore.min.js',
        vendorUrl: API + '/runtime/live2d-vendor.js',
        pets: buildCatalog().map((pet) => ({
          id: pet.id,
          displayName: pet.displayName,
          description: pet.description,
          modelUrl: pet.modelUrl,
          scale: pet.scale,
          translate: pet.translate,
          motionsByPhase: pet.motionsByPhase,
          expressionsByPhase: pet.expressionsByPhase,
          expressionSlots: pet.expressionSlots,
          looksByPhase: pet.looksByPhase,
          motionGuards: pet.motionGuards,
          headParts: pet.headParts,
          tailParts: pet.tailParts,
          lines: pet.lines,
          patReactions: pet.patReactions,
          tailReactions: pet.tailReactions,
          spinReactions: pet.spinReactions,
          fidgetSlots: pet.fidgetSlots,
          hiddenMotions: pet.hiddenMotions,
          motionOptions: pet.motionOptions,
          motions: pet.motions,
          expressions: pet.expressions,
        })),
      })
    },
  }
}

/** The model reference-closure route (GET /api/live2d-pet/asset/<id>/<path>). */
function assetRoute() {
  return {
    kind: 'prefix',
    path: API + '/asset',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      let pathname
      try {
        pathname = new URL(request.url ?? '/', 'http://pet.local').pathname
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const segments = segmentsAfter(pathname, API + '/asset')
      if (segments === undefined || segments.length < 2) {
        response.writeHead(404)
        response.end()
        return
      }
      let id
      let rel
      try {
        id = decodeURIComponent(segments[0])
        rel = segments.slice(1).map(decodeURIComponent).join('/')
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const pet = buildCatalog().find((candidate) => candidate.id === id)
      // The closure probe is a Set lookup on scan-time normalized paths, so a
      // crafted '..' / '.' segment can never match a real file.
      if (pet === undefined || !pet.closure.has(rel)) {
        response.writeHead(404)
        response.end()
        return
      }
      const ext = extname(rel).toLowerCase()
      const cap = ext === '.json' ? CAP_JSON : (ext === '.moc3' ? CAP_MODEL : CAP_IMAGE)
      serveFile(request, response, pet.dir, join(pet.dir, rel), cap)
    },
  }
}

/**
 * Live2D 官方托管的 Cubism Core。
 *
 * 这份运行时是 Live2D 的专有软件，插件**不内置也不代下**（授权要求），但
 * **用户的机器可以从 Live2D 自己的 CDN 取** —— 官方 SDK 文档就是让使用者在页面里
 * 引这一行。取到之后缓存进 runtimeDir()，之后离线也能用。
 *
 * 有了这条兜底，从插件市场装完就能直接用，不必先去找 Cubism Core 放哪。
 */
const CORE_CDN = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

/** 本地没有 Core 时：去 Live2D 官方 CDN 拿一份，顺手缓存到本地。 */
async function fetchCoreFromCdn(response, cachePath) {
  try {
    const upstream = await fetch(CORE_CDN, { redirect: 'follow' })
    if (!upstream.ok) throw new Error('HTTP ' + upstream.status)
    const bytes = Buffer.from(await upstream.arrayBuffer())
    // 拿回来的必须真是一份 JS：否则多半是被网关/登录页替换了。
    if (bytes.length < 10000 || !bytes.includes('Live2DCubismCore')) {
      throw new Error('unexpected payload: ' + bytes.length + ' bytes')
    }
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, bytes)
    } catch {
      /* 缓存写不进去不影响这一次：直接把它发出去 */
    }
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=86400',
      'x-live2d-core-source': 'cdn',
    })
    response.end(bytes)
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      error: 'cubism-core-unavailable',
      detail: String(error?.message ?? error),
      hint: 'Cubism Core 是 Live2D 的专有运行时，本插件不内置。可以让这台机器能访问 '
        + CORE_CDN + '，或自行下载后放到 ' + join(runtimeDir(), 'live2dcubismcore.min.js'),
    })
  }
}

/** The runtime route (user-supplied Cubism Core + plugin vendor bundle). */
function runtimeRoute() {
  const vendorBase = join(pluginRoot(), 'lib')
  const coreBase = runtimeDir()
  return {
    kind: 'prefix',
    path: API + '/runtime',
    handler: (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      let pathname
      try {
        pathname = new URL(request.url ?? '/', 'http://pet.local').pathname
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const segments = segmentsAfter(pathname, API + '/runtime')
      if (segments === undefined || segments.length !== 1) {
        response.writeHead(404)
        response.end()
        return
      }
      // An exact-name allow-list: a segment carrying a separator never matches.
      const runtimeName = segments[0]
      let base
      if (runtimeName === 'live2dcubismcore.min.js') base = coreBase
      else if (runtimeName === 'live2d-vendor.js') base = vendorBase
      else {
        response.writeHead(404)
        response.end()
        return
      }
      const file = join(base, runtimeName)
      if (!existsSync(file)) {
        // Cubism Core 走官方 CDN 兜底：用户不用再自己找文件。
        if (runtimeName === 'live2dcubismcore.min.js') {
          void fetchCoreFromCdn(response, file)
          return
        }
        sendJson(response, 404, { ok: false, error: 'runtime-file-missing', file: runtimeName })
        return
      }
      serveFile(request, response, base, file, CAP_RUNTIME)
    },
  }
}


// ---------------------------------------------------------------- activity
//
// Session-activity mirror (requirement #4): the pet follows the DSH agent's
// real lifecycle instead of only reacting to clicks.
//
// The event vocabulary is the official one (verified against dsh-agent's
// runtime-types): 'agent/status' carries idle <-> running, 'agent/turn-stopping'
// fires when a turn finishes, 'agent/error' on failure, and 'approval/request'
// (a waterfall event, so it must be resumed) while the user is being asked.
//
// Delivery is a same-origin SSE stream rather than polling: transitions are
// pushed the moment they happen, and an idle page costs only a keep-alive
// comment frame.

/** The activity phases the browser half understands. */
export const ACTIVITY_PHASES = [
  'idle', 'thinking', 'waiting', 'asking', 'tool', 'helper', 'queued', 'done', 'failed',
]

/** How long the 'done' celebration is held before falling back to idle. */
const DONE_HOLD_MS = 3500

/** "你的消息排队了"给一个短促的收到反应，然后回到原来在演的东西。 */
const QUEUED_HOLD_MS = 1600

/** SSE keep-alive interval. */
const SSE_PING_MS = 30000

/**
 * The activity hub: folds DSH session events into one coarse phase, and fans
 * that phase out to every subscribed SSE response.
 */
export class ActivityHub {
  constructor() {
    this.phase = 'idle'
    this.detail = ''
    this.listeners = new Set()
    this.holdTimer = undefined
  }

  /** Current snapshot (sent as the first frame of every stream). */
  snapshot() {
    return { phase: this.phase, detail: this.detail, at: Date.now() }
  }

  /** Subscribe one SSE response; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(phase, detail = '') {
    if (this.phase === phase && this.detail === detail) return
    this.phase = phase
    this.detail = detail
    this.emit()
  }

  /**
   * 演一个**短促反应**相位，过一会儿自动回落到 `fallback`。
   *
   * `done`（庆祝）和 `queued`（收到你排队的消息）都是这一类：宠物演一下，然后回到
   * 它该在的地方。回落之前会确认相位没被别人接管 —— 这段时间里工具开始了、或者
   * 新一轮说话了，就不要再把它拽回旧的 fallback。
   */
  hold(phase, ms, fallback = 'idle') {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
    this.set(phase, '')
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      if (this.phase === phase) this.set(fallback, '')
    }, ms)
    // Keep the process free to exit; the timer is purely cosmetic.
    this.holdTimer?.unref?.()
  }

  /**
   * Enter the 'done' celebration and fall back to idle after a hold, so the
   * pet visibly finishes a turn instead of snapping straight back.
   */
  celebrate() {
    this.hold('done', DONE_HOLD_MS, 'idle')
  }

  emit() {
    const payload = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch {
        /* a dead stream must not break the others */
      }
    }
  }

  dispose() {
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    this.listeners.clear()
  }
}

/**
 * How long the pet stays in the 'tool' phase after the last tool returns.
 *
 * Long enough to bridge the gap between consecutive tool calls in one turn
 * (otherwise the phase flaps and the animation restarts constantly), short
 * enough that the pet visibly settles once the work really stops.
 */
const TOOL_IDLE_MS = 1200

/**
 * Fold the official DSH events into hub phases. Every subscription is optional
 * at runtime: an older host that lacks one simply keeps mirroring the others.
 */
export function attachActivityEvents(ctx, hub) {
  const on = (event, handler) => {
    try {
      ctx.on(event, handler)
    } catch {
      /* host without this event */
    }
  }
  // Waterfall events only continue if the handler resumes the chain, so a
  // throw here would silently break tool execution for the whole session.
  const onWaterfall = (event, handler) => {
    try {
      ctx.on(event, (...args) => {
        try {
          return handler(...args)
        } catch {
          // Never swallow the chain: hand control straight on.
          const next = args[args.length - 1]
          return typeof next === 'function' ? next() : undefined
        }
      })
    } catch {
      /* host without this event */
    }
  }
  on('agent/status', (payload) => {
    const status = payload?.status
    if (status === 'running') hub.set('thinking', '')
    else if (status === 'idle' && hub.phase !== 'done') hub.set('idle', '')
  })
  on('agent/turn-stopping', () => hub.celebrate())
  on('agent/error', () => hub.set('failed', ''))
  // approval/request is a waterfall event: it MUST resume the chain.
  on('approval/request', (_request, next) => {
    hub.set('waiting', '')
    return typeof next === 'function' ? next() : undefined
  })

  // Tool activity refines the generic 'thinking' phase while a turn runs.
  //
  // The obvious-looking event name for this is 'tool/call', but that is a
  // SESSION LOG event (a record appended to the transcript), not a cordis
  // lifecycle event — subscribing to it never fires, which is why the pet
  // appeared to ignore tool activity entirely. The live hooks are the
  // 'tools/*' waterfall events, which carry the ToolExecution itself.
  //
  // A turn usually runs MANY tools back to back, so reverting the instant one
  // returns would flap tool -> thinking -> tool several times a second, and each
  // transition restarts the pet's animation. The revert is therefore debounced:
  // it only happens once the tools actually stop arriving.
  let toolIdleTimer
  onWaterfall('tools/pre-execute', (exec, next) => {
    if (toolIdleTimer !== undefined) {
      clearTimeout(toolIdleTimer)
      toolIdleTimer = undefined
    }
    const name = exec?.name
    hub.set('tool', typeof name === 'string' ? name : '')
    return next()
  })
  onWaterfall('tools/post-execute', (_exec, _result, next) => {
    if (toolIdleTimer !== undefined) clearTimeout(toolIdleTimer)
    toolIdleTimer = setTimeout(() => {
      toolIdleTimer = undefined
      // Only step down if nothing else has taken over in the meantime.
      if (hub.phase === 'tool') hub.set('thinking', '')
    }, TOOL_IDLE_MS)
    return next()
  })

  // ---- DSH 0.1.7 里另外三个值得接的状态 --------------------------------------
  //
  // 事件词汇表在 0.1.7 里已经不小（`*.d.ts` 里声明了 100 个可订阅事件），但只有一部分
  // 能翻译成"宠物该演什么"。挑的标准是**它填的是不是一个真实的空档**：
  //
  //   asking  ← user-questions/request：以前"在等你回答问题"这段时间宠物还在演"干活"，
  //             看着像它没停过 ✗ —— 这是最大的一个空档；
  //   helper  ← subagent/start|end：子代理是**长活**（几分钟），和一次普通工具调用
  //             混在一起看不出区别；
  //   queued  ← agent/inbox/inserted：你发的话在它忙的时候插进来，现在至少给个"收到"。
  //
  // 没接的（评估过，不值得）：`fs/write-intent` / `edit-intent` —— 宠物在 tool 相位已经
  // 演「写本本」了，再拆一个 editing 和它重复；`workflow/*` —— 工作流本身是工具调用，
  // 已被 tool 覆盖（`workflow/phase` 的标题倒是可以当 detail，但宠物目前不显示 detail）；
  // `agent/status` 只有 idle / running 两个值，给不出更细的东西。

  // `user-questions/request` 是 waterfall：链一直挂到**你把问题答完**才 resume，所以
  // 这个相位正好等于"卡在等你"的那段，不用自己计时。
  onWaterfall('user-questions/request', (_request, next) => {
    hub.set('asking', '')
    const answered = typeof next === 'function' ? next() : undefined
    const back = () => {
      if (hub.phase === 'asking') hub.set('thinking', '')
    }
    if (answered !== null && typeof answered?.then === 'function') {
      answered.then(back, back)
      return answered
    }
    back()
    return answered
  })
  on('subagent/start', (info) => {
    const label = typeof info?.name === 'string'
      ? info.name
      : (typeof info?.label === 'string' ? info.label : '')
    hub.set('helper', label)
  })
  on('subagent/end', () => {
    if (hub.phase === 'helper') hub.set('thinking', '')
  })
  on('agent/inbox/inserted', () => {
    // 回到"刚才在演的那个"（可能是 tool / asking，也可能是 idle）——不要一律回 idle，
    // 那会让一个正在跑工具的回合看起来停了。
    const previous = hub.phase
    hub.hold('queued', QUEUED_HOLD_MS, previous === 'queued' ? 'thinking' : previous)
  })
}

/** The activity stream + snapshot route. */
function eventsRoute(hub) {
  return {
    kind: 'exact',
    path: API + '/events',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' || hub === undefined) {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const frame = (payload) => {
        // Guard every write: the peer may have gone away mid-push.
        try {
          response.write('data: ' + JSON.stringify(payload) + '\n\n')
        } catch {
          /* stream already closed */
        }
      }
      frame(hub.snapshot())
      const unsubscribe = hub.subscribe(frame)
      const ping = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          /* stream already closed */
        }
      }, SSE_PING_MS)
      ping.unref?.()
      const close = () => {
        clearInterval(ping)
        unsubscribe()
      }
      request.on('close', close)
      response.on('close', close)
      response.on('error', close)
    },
  }
}

/** The complete route table this plugin owns. */
export function buildRoutes(hub) {
  return [catalogRoute(), assetRoute(), runtimeRoute(), eventsRoute(hub)]
}

export function apply(ctx) {
  const hub = new ActivityHub()
  attachActivityEvents(ctx, hub)
  ctx.effect(() => () => hub.dispose(), 'live2d-pet: activity hub')
  ctx.inject(['webServer'], (host) => {
    for (const route of buildRoutes(hub)) {
      try {
        host.effect(() => host.webServer.register(route), 'live2d-pet: route ' + route.path)
      } catch (error) {
        host.logger?.warn('live2d-pet: route ' + route.path + ' failed: ' + String(error))
      }
    }
  })
}
