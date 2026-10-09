// 官方「插件」页那三样展示元信息（标题 / 描述 / 图标）的**确定性验证**。
//
// 侧栏「插件」页与「设置 → 内置插件」里卡片上的标题、描述、图标**不是页面自己读
// package.json 拼的**：宿主 `dsh-app-boot` 的 `readPluginMeta()` 把它们读出来，经
// `pluginInventory/list` 的 `meta` 字段送给页面（`title` / `description` / `icon`）。
//
// 所以判据就用**宿主那个函数本身**，而不是照着文档再实现一遍 —— 后者只能证明
// "我们和文档一致"，证明不了"宿主读得出来"。它顺带把三类常见错法一次判掉：
//   * `icon` 写成了绝对路径 / 包外路径 → 宿主报 "icon must be a relative file path"
//   * 图标不是 SVG/PNG/JPEG/WebP 或超过 256 KiB → 宿主报对应的那句话
//   * locale 文件没在 `exports` 里导出 → 解析不到，标题就退回包名
//
//   node tools/probe-plugin-page-meta.mjs
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN } from './paths.mjs'

const PACKAGE = 'dsh-pet-live2d'
const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: ok === true })
  console.log((ok === true ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  [' + detail + ']'))
}

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PROFILE_DIR = join(HOME, 'profiles', process.env.DSH_PROFILE ?? 'web')
const INSTALL = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')

// ---- 宿主的读取器（从 DSH 安装里取，和宿主进程拿到的是同一份实现）----------
let readPluginMeta
try {
  const entry = createRequire(join(INSTALL, 'package.json')).resolve('@deepseek-ai/dsh-app-boot')
  ;({ readPluginMeta } = await import(pathToFileURL(entry).href))
} catch (error) {
  console.error('取不到宿主的 readPluginMeta（DSH 装在哪？）：' + String(error && error.message))
  process.exit(2)
}

// 页面/清单查的都是"profile 这一层能不能解析到这个包"，所以父基准取 profile 的 package.json。
const parentURL = pathToFileURL(PROFILE_MANIFEST).href
let meta
try {
  meta = readPluginMeta(PACKAGE, parentURL)
} catch (error) {
  console.error('readPluginMeta 抛了：' + String(error && error.message))
  process.exit(1)
}

check('宿主读到了这个包的展示元信息', meta !== undefined, JSON.stringify(meta)?.slice(0, 200))
if (meta === undefined) {
  console.log('---')
  console.log('PLUGIN PAGE META FAIL 0/' + results.length)
  process.exit(1)
}
check('读取没有诊断错误', meta.error === undefined, meta.error)

// ---- 标题 / 描述：本地化对象 { en, zh, … } --------------------------------
const text = (field) => (meta[field] !== null && typeof meta[field] === 'object' ? meta[field] : null)
const title = text('title')
const description = text('description')
check('标题是本地化对象（不是回退的包名）', title !== null && typeof title.zh === 'string',
  JSON.stringify(title))
check('标题带英文回退', title !== null && typeof title.en === 'string', JSON.stringify(title))
check('描述是本地化对象', description !== null && typeof description.zh === 'string',
  JSON.stringify(description))
check('标题不是包名本身（说明 locale 真的被读到了）', title !== null && title.zh !== PACKAGE && title.en !== PACKAGE,
  'zh=' + String(title?.zh))

// ---- 图标：宿主把文件读成 data URL ----------------------------------------
check('图标是 SVG 的 data URL', typeof meta.icon === 'string' && meta.icon.startsWith('data:image/svg+xml;base64,'),
  String(meta.icon).slice(0, 32))
let decoded = null
if (typeof meta.icon === 'string' && meta.icon.includes(',')) {
  decoded = Buffer.from(meta.icon.slice(meta.icon.indexOf(',') + 1), 'base64')
}
const iconPath = join(PLUGIN, 'icon.svg')
const onDisk = readFileSync(iconPath)
check('data URL 的内容与 icon.svg 逐字节相同', decoded !== null && decoded.equals(onDisk),
  decoded === null ? '没解析出内容' : decoded.length + ' vs ' + onDisk.length + ' 字节')
check('图标在 256 KiB 上限之内', statSync(iconPath).size <= 256 * 1024,
  Math.round(statSync(iconPath).size / 1024) + 'KB')
check('图标画布是 36×36（卡片按 36 渲染）', /viewBox="0 0 36 36"/.test(onDisk.toString('utf8')))

// ---- 行（组合包里的插件行）用的是同一个模块名，元信息也是同一份 -------------
const rowMeta = readPluginMeta(PACKAGE, parentURL)
check('插件行读到的元信息与组合包一致', rowMeta?.title?.zh === meta.title?.zh && rowMeta?.icon === meta.icon)

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log('PLUGIN PAGE META ' + (failed.length === 0 ? 'PASS' : 'FAIL')
  + ' ' + (results.length - failed.length) + '/' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
