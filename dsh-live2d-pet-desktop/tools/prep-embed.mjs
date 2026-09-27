// 把要**嵌进 exe** 的东西铺到 sidecar/embed/ 下（这个目录是构建产物，不进仓库）。
//
// 为什么要有这一步：单文件 exe 里没有"旁边那个目录"。sidecar 是 deno compile 出来的
// 独立二进制，它只能读自己编译期嵌进去的东西；插件宿主半区（`lib/index.js`）与随包宠物
// 又必须原样带着（宠物发现、pet.json 的默认值、模型引用闭包全在那儿）。所以：
//
//   sidecar/embed/
//     plugin/            插件包的一份副本（宿主半区 + 随包宠物）—— 布局与真包一致，
//                        因为 `pluginRoot()` 是按 `lib/` 的相对位置推的
//       lib/index.js
//       pets/ds-whale-girl/...
//     client.js          插件浏览器半区
//     vendor.js          插件 vendor 分包（pixi + Live2D 引擎）
//     react.development.js / react-dom.development.js   React UMD
//     page/              桌面端页面（与仓库里的 sidecar/page 同源）
//
// 这些都是**每次构建现铺**：插件改了、页面改了，重跑一次就同步，不需要手工维护副本。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, PLUGIN, ROOT } from '../sidecar/paths.mjs'

const EMBED = join(DESKTOP, 'sidecar', 'embed')
const PAGE_SRC = join(DESKTOP, 'sidecar', 'page')
/** React UMD 用浏览器测试那套现成的依赖（版本与 DSH 客户端保持一致）。 */
const REACT_DIR = join(ROOT, 'tools', 'browser-test', 'node_modules', 'react', 'umd')
const REACT_DOM_DIR = join(ROOT, 'tools', 'browser-test', 'node_modules', 'react-dom', 'umd')

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const log = (message) => console.log('[prep-embed] ' + message)

function require(paths) {
  const missing = paths.filter((file) => !existsSync(file))
  if (missing.length > 0) {
    console.error('缺少这些文件，先补齐再构建：\n  ' + missing.join('\n  '))
    process.exit(1)
  }
}

function sizeOf(dir) {
  let total = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = sizeOf(full)
      total += inner.bytes
      files += inner.files
    } else {
      total += statSync(full).size
      files += 1
    }
  }
  return { bytes: total, files }
}

require([
  join(PLUGIN, 'lib', 'index.js'),
  join(PLUGIN, 'lib', 'client.js'),
  join(PLUGIN, 'lib', 'live2d-vendor.js'),
  join(PLUGIN, 'pets', 'ds-whale-girl', 'pet.json'),
  join(PAGE_SRC, 'index.html'),
  join(REACT_DIR, 'react.development.js'),
  join(REACT_DOM_DIR, 'react-dom.development.js'),
])
/**
 * Cubism Core：Live2D 株式会社的专有运行时，**不能随插件分发**，所以插件正常是从官方
 * CDN 取一次再缓存到 `%DSH_HOME%\pets\.runtime\`。
 *
 * 单文件 exe 不该依赖"第一次要能上网"，所以这里把**本机已经缓存过的那一份**嵌进去
 * （用户机器上就是插件自己下回来的那份，来源仍是官方）。本机没有就退回 CDN 那条路，
 * 行为与网页端一致。`--core <路径>` 可以显式指定。
 */
const coreArg = argOf('--core')
const coreCandidates = [
  coreArg,
  join(process.env.USERPROFILE ?? '', '.dsh', 'pets', '.runtime', 'live2dcubismcore.min.js'),
  join(process.env.DSH_HOME ?? '', 'pets', '.runtime', 'live2dcubismcore.min.js'),
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
const cubismCore = coreCandidates.find((candidate) => existsSync(candidate))

rmSync(EMBED, { recursive: true, force: true })
mkdirSync(join(EMBED, 'plugin', 'lib'), { recursive: true })
mkdirSync(join(EMBED, 'plugin', 'pets'), { recursive: true })
mkdirSync(join(EMBED, 'page'), { recursive: true })

// 插件包：宿主半区 + 随包宠物。**整套 pets/ 都拷**（作者可能不止一只），
// pluginRoot() 因此能照常推出 'pets' 目录来。
cpSync(join(PLUGIN, 'lib', 'index.js'), join(EMBED, 'plugin', 'lib', 'index.js'))
cpSync(join(PLUGIN, 'pets'), join(EMBED, 'plugin', 'pets'), { recursive: true })
cpSync(join(PLUGIN, 'lib', 'client.js'), join(EMBED, 'client.js'))
cpSync(join(PLUGIN, 'lib', 'live2d-vendor.js'), join(EMBED, 'vendor.js'))

/**
 * React UMD：**优先生产版**（`react.production.min.js`，~140KB），没有再退回开发版
 * （~1.1MB，会往控制台刷 DevTools 提示）。单文件 exe 里体积是要算的，而桌宠自己不需要
 * React 的警告信息——出问题读的是我们自己的 `data-*` 读口与驱动。
 *
 * 页面引用的是固定名 `react.js` / `react-dom.js`，由 sidecar 决定发哪一份，所以换版本
 * 不用改 HTML。
 */
function pickReact(dir, production, development) {
  const prod = join(dir, production)
  if (existsSync(prod)) return { file: prod, flavor: 'production' }
  return { file: join(dir, development), flavor: 'development' }
}
const reactPick = pickReact(REACT_DIR, 'react.production.min.js', 'react.development.js')
const reactDomPick = pickReact(REACT_DOM_DIR, 'react-dom.production.min.js', 'react-dom.development.js')
cpSync(reactPick.file, join(EMBED, 'react.js'))
cpSync(reactDomPick.file, join(EMBED, 'react-dom.js'))
log('React：' + reactPick.flavor + ' / ' + reactDomPick.flavor
  + '（' + Math.round((statSync(reactPick.file).size + statSync(reactDomPick.file).size) / 1024) + 'KB）')

if (cubismCore === undefined) {
  log('**没有找到本地 Cubism Core**：这一版会在首次运行去官方 CDN 取（与网页端相同）')
} else {
  cpSync(cubismCore, join(EMBED, 'live2dcubismcore.min.js'))
  log('Cubism Core 已内嵌（来源：' + cubismCore + '，' + Math.round(statSync(cubismCore).size / 1024) + 'KB）')
}

// 页面：拷过来的是**构建快照**，运行期优先用仓库里那份（改页面不用重新构建）。
for (const name of readdirSync(PAGE_SRC)) {
  if (name === 'react') continue // React 由上面的两个文件提供
  cpSync(join(PAGE_SRC, name), join(EMBED, 'page', name), { recursive: true })
}

// 版本与来源写一份，出问题时能确认"exe 里嵌的到底是哪一版插件"。
const pluginVersion = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).version
writeFileSync(join(EMBED, 'embed.json'), JSON.stringify({
  pluginVersion,
  pet: 'ds-whale-girl',
  petVersion: JSON.parse(readFileSync(join(PLUGIN, 'pets', 'ds-whale-girl', 'pet.json'), 'utf8')).version,
  core: cubismCore === undefined ? 'cdn' : 'embedded',
  builtAt: new Date().toISOString(),
}, null, 2) + '\n')

// 资源清单：**必须显式列出来**。deno compile 的 `--include` 实测不会把 embed 里的
// （由运行期拼路径读取的）文件带进独立二进制，所以解包那一步只能照这份清单来。
// 清单文件放在 sidecar/ 下（与 paths.mjs 同级），这样 `new URL('./embed/' + rel, import.meta.url)`
// 在编译产物里也指得对。
const listFiles = (dir, prefix = '') => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}
const files = listFiles(EMBED).sort()
writeFileSync(
  join(DESKTOP, 'sidecar', 'embed-manifest.mjs'),
  '// 由 tools/prep-embed.mjs 生成：编译期嵌进 sidecar 的资源清单（published 模式按它解包）。\n'
  + '// 不要手改；改了会在下次构建时被覆盖。\n'
  + 'export const EMBED_FILES = [\n'
  + files.map((file) => '  ' + JSON.stringify(file) + ',').join('\n')
  + '\n]\n',
)

const total = sizeOf(EMBED)
log('embed 就绪：' + total.files + ' 个文件，' + (total.bytes / 1024 / 1024).toFixed(2) + ' MB（插件 v' + pluginVersion + '）')
log('资源清单：sidecar/embed-manifest.mjs（' + files.length + ' 条）')
console.log('PREP_EMBED_OK')
