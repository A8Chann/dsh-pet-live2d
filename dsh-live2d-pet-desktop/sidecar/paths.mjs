// 桌面端的共享路径。
//
// 全部从本文件自己的位置推出来，换一台机器、换个克隆目录都不用改：
// 仓库里 dsh-live2d-pet-desktop/ 与 dsh-live2d-pet/ 是兄弟目录。
//
// **published 模式**（deno compile 出来的独立二进制）：源代码不在磁盘上。判据是
// **实测的**，不是猜的：仓库里 `sidecar/embed/` 存在 = 开发期（资源在磁盘上）；
// 不存在 = 独立二进制（资源在编译期嵌进二进制里，启动时按 embed-manifest.mjs 解包）。
// 试过 `Deno.mainModule` 那套判据，在编译产物里不长那个样子 —— 别再用它。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/** dsh-live2d-pet-desktop/sidecar（published 模式下是编译期记录的虚拟路径）。 */
export const HERE = dirname(fileURLToPath(import.meta.url))
/** dsh-live2d-pet-desktop */
export const DESKTOP = resolve(HERE, '..')
/** 仓库根 */
export const ROOT = resolve(DESKTOP, '..')

/** 开发期的 embed 目录（由 tools/prep-embed.mjs 铺好）。 */
const DEV_EMBED = join(DESKTOP, 'sidecar', 'embed')

/**
 * 是不是"编译出来的独立二进制"。
 *
 * 判据是**壳显式告知的**（`PET_DESKTOP_EMBED`），不是猜的：试过 `Deno.mainModule` 与
 * "dev embed 目录在不在"，两个都不可靠 —— 编译产物里的虚拟文件系统也能 `existsSync`，
 * 于是会误判成开发期，然后去读一个不存在的仓库路径（症状是 `Module not found:
 * .../dsh-live2d-pet/lib/index.js`）。单独双击运行（没有壳）时退回"开发期"这一支，
 * 反正那时也没有解包目录可用。
 */
export const PUBLISHED = process.env.PET_DESKTOP_EMBED !== undefined && process.env.PET_DESKTOP_EMBED !== ''

/**
 * 嵌进二进制的那份资源的根目录。
 *
 * 壳（Rust）负责把路径放进 `PET_DESKTOP_EMBED` 并确保目录存在；开发期直接指
 * `sidecar/embed/`。**开发与发布走同一个目录约定**，这样"开发时好好的、打包后找不到
 * 文件"这类问题不会存在。
 */
export const EMBED = resolve(PUBLISHED ? process.env.PET_DESKTOP_EMBED : DEV_EMBED)

/**
 * 插件包的位置。
 *
 * 开发期直接读工作区里的真包（改了立刻生效）；published 模式读解包出来的那份副本
 * ——它的目录布局与真包一致，因为 `pluginRoot()` 是按 `lib/` 的相对位置推的。
 */
export const PLUGIN = PUBLISHED
  ? join(EMBED, 'plugin')
  : (process.env.PET_DESKTOP_PLUGIN ?? join(ROOT, 'dsh-live2d-pet'))

/** 页面目录：开发期用仓库里那份（改页面不用重新构建），published 模式用解包出来的。 */
export const PAGE_DIR = PUBLISHED ? join(EMBED, 'page') : join(DESKTOP, 'sidecar', 'page')

/**
 * 壳的状态文件放哪儿。
 *
 * 这个文件是**壳写的**，sidecar 只读出来挂成 HTTP，所以路径由壳给出。开发期两边都用
 * 仓库里的 `.run/`；发布版在 `%LOCALAPPDATA%` 下的运行期目录（exe 旁边不一定可写）。
 */
export const RUN = resolve(
  process.env.PET_DESKTOP_RUN !== undefined && process.env.PET_DESKTOP_RUN !== ''
    ? process.env.PET_DESKTOP_RUN
    : join(DESKTOP, '.run'),
)
mkdirSync(RUN, { recursive: true })

/**
 * published 模式下把编译期嵌进来的资源解包到 `EMBED`。
 *
 * 为什么要解包、而不是直接从二进制里读：宠物目录（`pet.json` + moc3 + 贴图）要交给
 * 插件的宿主半区去扫描与同步，它只认文件系统。解包一次就够（第二次看到 client.js
 * 在就直接跳过）。
 *
 * 清单由 `tools/prep-embed.mjs` 生成（`embed-manifest.mjs`）——deno compile 的
 * `--include` 实测**没有**把 embed 里的小文件带进二进制，所以绝不能靠静态分析。
 */
export async function ensureEmbed() {
  if (!PUBLISHED) return { extracted: false, files: 0 }
  if (existsSync(join(EMBED, 'client.js')) && existsSync(join(EMBED, 'plugin', 'lib', 'index.js'))) {
    return { extracted: false, files: 0 }
  }
  let manifest
  try {
    manifest = (await import('./embed-manifest.mjs')).EMBED_FILES
  } catch {
    throw new Error('这个二进制没有带资源清单（embed-manifest.mjs）—— 构建时先跑 tools/prep-embed.mjs')
  }
  const { copyFile } = await import('node:fs/promises')
  let files = 0
  for (const relative of manifest) {
    const target = join(EMBED, relative)
    mkdirSync(dirname(target), { recursive: true })
    await copyFile(new URL('./embed/' + relative, import.meta.url), target)
    files += 1
  }
  return { extracted: true, files }
}
