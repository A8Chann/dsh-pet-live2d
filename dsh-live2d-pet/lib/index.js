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

import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, sep } from 'node:path'
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
export function buildCatalog() {
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
export const ACTIVITY_PHASES = ['idle', 'thinking', 'waiting', 'tool', 'done', 'failed']

/** How long the 'done' celebration is held before falling back to idle. */
const DONE_HOLD_MS = 3500

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
    this.doneTimer = undefined
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
   * Enter the 'done' celebration and fall back to idle after a hold, so the
   * pet visibly finishes a turn instead of snapping straight back.
   */
  celebrate() {
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.set('done', '')
    this.doneTimer = setTimeout(() => {
      this.doneTimer = undefined
      this.set('idle', '')
    }, DONE_HOLD_MS)
    // Keep the process free to exit; the timer is purely cosmetic.
    this.doneTimer?.unref?.()
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
    if (this.doneTimer !== undefined) {
      clearTimeout(this.doneTimer)
      this.doneTimer = undefined
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
