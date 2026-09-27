// 工具脚本用的共享路径（不再属于任何"sidecar"—— 那个进程已经没有了）。
//
// 全部从本文件自己的位置推出来，换一台机器、换个克隆目录都不用改：
// 仓库里 `dsh-live2d-pet-desktop/` 与 `dsh-live2d-pet/` 是兄弟目录。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

/** dsh-live2d-pet-desktop/tools */
export const HERE = dirname(fileURLToPath(import.meta.url))
/** dsh-live2d-pet-desktop */
export const DESKTOP = resolve(HERE, '..')
/** 仓库根 */
export const ROOT = resolve(DESKTOP, '..')
/**
 * 被复用的插件包（目录名是 `dsh-live2d-pet`，别和仓库名 `dsh-pet-live2d` 弄混 ——
 * 对拍驱动一开始就写错成后者，报的是"找不到 lib/index.js"）。
 *
 * 桌面端现在已经有了自己的 Rust 宿主半区，但**浏览器半区与随包宠物仍然共用这一份** ——
 * 所以网页端的 19 个 driver 依然是桌面端的回归网。对拍驱动也拿它当 JS 参照实现。
 */
export const PLUGIN = join(ROOT, 'dsh-live2d-pet')
/** 页面目录（编译期被 build.rs 嵌进 exe）。 */
export const PAGE_DIR = join(DESKTOP, 'sidecar', 'page')
/** 运行期/调试产物 */
export const RUN = join(DESKTOP, '.run')
mkdirSync(RUN, { recursive: true })
