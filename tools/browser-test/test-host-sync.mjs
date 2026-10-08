// 随包宠物的**同步**：装过旧版的用户要能拿到新版的默认值。
//
// 这一条是互动反应那批默认值的另一半，而且是它唯一能到达老用户的路：
//
//   - 插件目录随 pnpm / `dsh plugin add` 更新，用户的宠物目录 `$DSH_HOME/pets/<id>/` 不会；
//   - 原来是"目标存在就跳过"，于是 25c4d285 往 pet.json 里加的那批设置（台词 /
//     patReactions / tailReactions / spinReactions / fidgetSlots、asking/helper/queued
//     三个相位、自拍等三个槽位）**一个都没到过桌面**。老用户的宠物一直停在 1.0.x 的样子：
//     互动只有台词不演反应、相位台词一句不弹、装扮里少三个槽位 —— 而且看起来像插件的 bug。
//
// 同步的边界（每条都有断言，不然"同步"就是一次静默的数据覆盖）：
//
//   1. 目标不存在 → 装一份，并记下"这是我装的哪个版本、长什么样"；
//   2. 目标就是我们装下去的那一份（内容指纹对得上）→ 整份更新；
//   3. 冷启动（记录出现之前装的副本）→ 内容与历史上任何一次随包分发**逐字节相同**才更新；
//   4. 用户动过一个字 → **一个字都不碰**，而且要在日志里说出来。
//
// 这是 host 半区的纯逻辑（文件系统进、文件系统出），所以直接测函数，不用起浏览器。
//
//   node test-host-sync.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN } from './paths.mjs'

const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')) }

const BUNDLED = join(PLUGIN, 'pets', 'ds-whale-girl')
const PET_ID = 'ds-whale-girl'
const bundledManifest = JSON.parse(readFileSync(join(BUNDLED, 'pet.json'), 'utf8'))
const BUNDLED_VERSION = String(bundledManifest.version)
/** 旧版本：只要比随包那份旧就行（版本比较按点分数字，不认语义化后缀）。 */
const OLD_VERSION = '1.0.1'
if (BUNDLED_VERSION === OLD_VERSION) {
  console.error('FAIL  这条测试要求随包宠物的版本已经抬起来（现在是 ' + BUNDLED_VERSION + '）')
  process.exit(1)
}
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * 起一个独立的 DSH_HOME，把 host 半区按**这个 HOME** 加载进来。
 *
 * 每个用例一个模块实例：模块里缓存了 pluginRoot()，而 DSH_HOME 是每次现读的，
 * 分开加载更不容易互相串。
 */
async function freshHost(home) {
  process.env.DSH_HOME = home
  const url = pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href + '?case=' + Math.random().toString(36).slice(2)
  return import(url)
}

/** 一份"用户装过旧版"的宠物目录：把随包那份拷过去，然后把 pet.json 的版本改旧。 */
function installOldCopy(home, { version = OLD_VERSION, edit } = {}) {
  const target = join(home, 'pets', PET_ID)
  mkdirSync(join(home, 'pets'), { recursive: true })
  cpSync(BUNDLED, target, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(target, 'pet.json'), 'utf8'))
  manifest.version = version
  if (edit !== undefined) edit(manifest)
  writeFileSync(join(target, 'pet.json'), JSON.stringify(manifest, null, 2))
  return target
}

/** 记一份同步记录（模拟"这份是我们装下去的"）。 */
function writeRecord(home, payload) {
  mkdirSync(join(home, 'pets'), { recursive: true })
  writeFileSync(join(home, 'pets', '.synced.json'), JSON.stringify(payload, null, 2))
}

/** 同步记录要落在这个位置（pets/ 下，不在宠物目录里）。 */
const homeFor = (name) => mkdtempSync(join(tmpdir(), 'pet-sync-' + name + '-'))
const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
const homes = []

try {
  // ---- 1. 全新安装 ---------------------------------------------------------
  {
    const home = homeFor('fresh'); homes.push(home)
    const host = await freshHost(home)
    host.installBundledPets({ quiet: true })
    const dir = join(home, 'pets', PET_ID)
    check('全新安装：宠物被装进去了', existsSync(join(dir, 'pet.json')))
    check('全新安装：装的是随包那一版', readManifest(dir).version === BUNDLED_VERSION,
      '装了 ' + readManifest(dir).version + '，随包 ' + BUNDLED_VERSION)
    const pet = host.scanPet(dir, PET_ID)
    check('Web 宿主将宠物声明的相位音符送进 catalog',
      JSON.stringify(pet?.sounds?.done) === JSON.stringify([[660, 0], [880, 0.13]]),
      JSON.stringify(pet?.sounds))
    const old = readManifest(dir)
    delete old.live2d.sounds
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(old))
    check('Web 宿主区分旧宠物缺席与显式空音效表', host.scanPet(dir, PET_ID)?.sounds === null)
    cpSync(join(BUNDLED, 'pet.json'), join(dir, 'pet.json'))
    // 同步记录不能落在宠物目录里：那是用户自己的地盘，多一个文件就是污染。
    check('全新安装：同步记录写在 pets/ 下、不在宠物目录里',
      !existsSync(join(dir, '.synced.json')) && existsSync(join(home, 'pets', '.synced.json')))
    check('全新安装：记录里存了版本 + 内容指纹（下次靠它认人）',
      (() => {
        const record = JSON.parse(readFileSync(join(home, 'pets', '.synced.json'), 'utf8'))
        return record[PET_ID]?.version === BUNDLED_VERSION && record[PET_ID]?.hash === sha(join(dir, 'pet.json'))
      })(),
      readFileSync(join(home, 'pets', '.synced.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 120))
  }

  // ---- 2. 老用户：我们装的旧版本 → 更新 ------------------------------------
  {
    const home = homeFor('old'); homes.push(home)
    const dir = installOldCopy(home)
    // 模拟"2.3.0 之前的 pet.json"：那批新设置一个都没有。
    const before = readManifest(dir)
    delete before.live2d.lines
    delete before.live2d.patReactions
    delete before.live2d.tailReactions
    delete before.live2d.spinReactions
    delete before.live2d.fidgetSlots
    delete before.live2d.looksByPhase.asking
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(before, null, 2))
    // 记录里存的就是**削过之后**那份的指纹：模拟"旧版插件把它装下去时就是这样"。
    writeRecord(home, { [PET_ID]: { version: OLD_VERSION, hash: sha(join(dir, 'pet.json')) } })
    writeFileSync(join(dir, 'my-own-note.txt'), '用户自己放的备注')

    const host = await freshHost(home)
    // 升级要**说出来**（"插件更新了但什么都没变"是最难查的症状之一），
    // 所以这里连日志文案一起断言：它踩过一次"覆盖之后才读旧版本号"，
    // 打出来是「更新到 1.1.0（原先 1.1.0）」。
    const logged = []
    const realLog = console.log
    console.log = (...args) => { logged.push(args.join(' ')) }
    try { host.installBundledPets() } finally { console.log = realLog }
    const after = readManifest(dir)
    check('老用户：升级日志说得出"从哪一版到哪一版"',
      logged.some((line) => line.includes('更新到 ' + BUNDLED_VERSION) && line.includes('原先 ' + OLD_VERSION)),
      JSON.stringify(logged))
    check('老用户：pet.json 被更新到随包那一版', after.version === BUNDLED_VERSION,
      OLD_VERSION + ' -> ' + after.version)
    check('老用户：补上了互动反应候选（这次修的就是这一批默认值）',
      Array.isArray(after.live2d.patReactions) && after.live2d.patReactions.length > 0,
      JSON.stringify(after.live2d.patReactions))
    check('老用户：补上了台词 / 摸鱼槽位 / 新增的三个相位',
      after.live2d.lines !== undefined && after.live2d.fidgetSlots !== undefined
      && after.live2d.looksByPhase.asking !== undefined,
      JSON.stringify(Object.keys(after.live2d.looksByPhase)))
    check('老用户：宠物声明的提示音随升级到达',
      JSON.stringify(after.live2d.sounds?.asking) === JSON.stringify([[520, 0], [780, 0.16]]))
    check('老用户：模型文件也在（整份拷，不是只补 pet.json）',
      existsSync(join(dir, 'model', 'c_0120.moc3')))
    check('老用户：用户自己放进去的文件还在（逐文件覆盖，不是整目录替换）',
      existsSync(join(dir, 'my-own-note.txt')))
    check('老用户：同步记录抬到了新版本',
      JSON.parse(readFileSync(join(home, 'pets', '.synced.json'), 'utf8'))[PET_ID]?.version === BUNDLED_VERSION)
  }

  // ---- 3. 冷启动：老副本 + 没有同步记录 ------------------------------------
  // 这是**真实的历史形状**：同步记录是这一版才有的，所有老装机都没有记录，
  // 目标目录里那份却是我们当年装下去的。判定只能靠"内容与历史指纹逐字节相同"。
  //
  // 注意不能"把内容 Y 标成历史哈希 H"：历史哈希 H 正是内容 X 的哈希，只注册 H
  // 就是只注册 X。所以这里把**当前**这份内容注进指纹表，它扮演的角色就是"我们发过的那一份"。
  {
    const home = homeFor('cold'); homes.push(home)
    const dir = installOldCopy(home, { version: '0.9.0' })
    const pristine = sha(join(dir, 'pet.json'))
    // ① 认得出来（逐字节相同）→ 升级到随包那一版：
    const hostA = await freshHost(home)
    hostA.installBundledPets({ quiet: true, fingerprints: { [PET_ID]: [pristine] } })
    check('冷启动：认得出的旧副本被更新到随包那一版', readManifest(dir).version === BUNDLED_VERSION,
      '0.9.0 -> ' + readManifest(dir).version)
    check('冷启动：更新后写下了同步记录',
      JSON.parse(readFileSync(join(home, 'pets', '.synced.json'), 'utf8'))[PET_ID]?.version === BUNDLED_VERSION)

    // ② 认不出来（用户改了一个字）→ 一个字都不碰：
    const other = homeFor('cold-own'); homes.push(other)
    const otherDir = installOldCopy(other, { version: '0.9.0' })
    const mine = readManifest(otherDir)
    mine.displayName = '我改过的'
    writeFileSync(join(otherDir, 'pet.json'), JSON.stringify(mine, null, 2))
    const editedHash = sha(join(otherDir, 'pet.json'))
    check('夹具：改过之后指纹确实变了（否则下面那条断言是空洞的）', editedHash !== pristine)
    const hostB = await freshHost(other)
    // 指纹表里放的是**改之前**那份：现在目录里是改过的，就不该被认成"我们的"。
    hostB.installBundledPets({ quiet: true, fingerprints: { [PET_ID]: [pristine] } })
    check('冷启动：认不出的旧副本一字未改', readManifest(otherDir).displayName === '我改过的',
      readManifest(otherDir).displayName)
  }

  // ---- 4. 用户自己改过的副本 → 一个字都不碰 --------------------------------
  {
    const home = homeFor('own'); homes.push(home)
    const dir = installOldCopy(home, { version: '1.0.0', edit: (m) => { m.displayName = '我自己改的鲸鱼娘' } })
    const before = readFileSync(join(dir, 'pet.json'), 'utf8')
    // 没有同步记录 = 这份不是我们装的（老版本插件也从来没写过记录），
    // 而且它的内容不在历史指纹表里（被改过）→ 不该被认成"我们的"。
    const host = await freshHost(home)
    host.installBundledPets({ quiet: true })
    check('用户自己的副本：pet.json 一字未改', readFileSync(join(dir, 'pet.json'), 'utf8') === before)
    check('用户自己的副本：版本号还是他自己的', readManifest(dir).version === '1.0.0')
    check('用户自己的副本：名字也还是他自己的', readManifest(dir).displayName === '我自己改的鲸鱼娘')
  }

  // ---- 5. 在我们装的版本上又改了 → 也不碰（指纹对不上） --------------------
  {
    const home = homeFor('edited'); homes.push(home)
    const dir = installOldCopy(home)
    const edited = readManifest(dir)
    edited.displayName = '改过名字的鲸鱼娘'
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(edited, null, 2))
    // 记录里的版本是旧的、指纹是"没改之前"那份 —— 用户改内容时**不会**动 version，
    // 所以这里正是"只看版本号会以为这就是我们装的那份"的地方。
    writeRecord(home, { [PET_ID]: { version: OLD_VERSION, hash: sha(join(dir, 'pet.json')) } })
    const tampered = readManifest(dir)
    tampered.displayName = '又改了一次'
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(tampered, null, 2))
    const host = await freshHost(home)
    host.installBundledPets({ quiet: true })
    check('改过内容的老副本：没有被覆盖（内容指纹对不上）',
      readManifest(dir).displayName === '又改了一次', readManifest(dir).displayName)
  }

  // ---- 6. 版本相同 + 内容相同就不做无谓的重写 ------------------------------
  {
    const home = homeFor('samever'); homes.push(home)
    // 不能借用 installOldCopy()：它会把清单重新序列化一遍，字节和随包那份就不一样了，
    // 于是这条用例测的其实是"内容不同 → 重写"（第一次跑就是这么假红的）。
    const dir = join(home, 'pets', PET_ID)
    mkdirSync(join(home, 'pets'), { recursive: true })
    cpSync(BUNDLED, dir, { recursive: true })
    const pristine = sha(join(dir, 'pet.json'))
    check('夹具：这份的指纹与随包那份逐字节一致（否则下面那条断言是空洞的）',
      pristine === sha(join(BUNDLED, 'pet.json')))
    writeRecord(home, { [PET_ID]: { version: BUNDLED_VERSION, hash: pristine } })
    const stamp = statSync(join(dir, 'pet.json')).mtimeMs
    await new Promise((r) => setTimeout(r, 25))
    const host = await freshHost(home)
    host.installBundledPets({ quiet: true })
    check('已经是最新时不再重写文件（mtime 不变）', statSync(join(dir, 'pet.json')).mtimeMs === stamp)
  }

  // ---- 7. 幂等：连跑三次不重复干活 ----------------------------------------
  {
    const home = homeFor('idem'); homes.push(home)
    const host = await freshHost(home)
    host.installBundledPets({ quiet: true })
    const dir = join(home, 'pets', PET_ID)
    const stamp = statSync(join(dir, 'pet.json')).mtimeMs
    await new Promise((r) => setTimeout(r, 25))
    host.installBundledPets({ quiet: true })
    host.installBundledPets({ quiet: true })
    check('幂等：已经是最新时不再重写文件', statSync(join(dir, 'pet.json')).mtimeMs === stamp)
    check('幂等：记录里仍然只有一个宠物条目',
      Object.keys(JSON.parse(readFileSync(join(home, 'pets', '.synced.json'), 'utf8'))).length === 1)
    check('幂等：宠物目录里没有被塞进第二个文件（记录不在里面）',
      readdirSync(dir).filter((name) => name.startsWith('.synced')).length === 0)
  }

  // ---- 8. 坏掉的 pet.json 不能让目录扫描失败 -------------------------------
  {
    const home = homeFor('broken'); homes.push(home)
    mkdirSync(join(home, 'pets', PET_ID), { recursive: true })
    writeFileSync(join(home, 'pets', PET_ID, 'pet.json'), '{ this is not json')
    const host = await freshHost(home)
    let threw = null
    try { host.installBundledPets({ quiet: true }) } catch (error) { threw = String(error?.message ?? error) }
    check('坏掉的 pet.json 不会让同步抛异常', threw === null, String(threw))
  }
} finally {
  for (const home of homes) { try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ } }
}

const bad = results.filter((r) => !r.ok)
console.log((bad.length === 0 ? 'OK' : 'FAILED') + '  ' + (results.length - bad.length) + '/' + results.length + ' checks passed')
process.exit(bad.length === 0 ? 0 : 1)
