// 桌面端的共享路径。
//
// 全部从本文件自己的位置推出来，换一台机器、换个克隆目录都不用改：
// 仓库里 dsh-live2d-pet-desktop/ 与 dsh-live2d-pet/ 是兄弟目录。
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

/** dsh-live2d-pet-desktop/sidecar */
export const HERE = dirname(fileURLToPath(import.meta.url))
/** dsh-live2d-pet-desktop */
export const DESKTOP = resolve(HERE, '..')
/** 仓库根 */
export const ROOT = resolve(DESKTOP, '..')
/** 被复用的插件包（宿主半区 + 浏览器半区 + vendor 分包 + 随包宠物） */
export const PLUGIN = join(ROOT, 'dsh-live2d-pet')
/** 桌面端自己的运行期文件（不随包发布，进 .gitignore） */
export const RUN = join(DESKTOP, '.run')
// 壳的状态文件落在这里，先建好目录，免得两边抢着创建。
mkdirSync(RUN, { recursive: true })
