// 把 React 的 UMD 产物铺到页面目录下。
//
// 为什么用 UMD 而不是把 React 打进插件：插件在 DSH 里是从**宿主客户端**的模块表里
// `require("react")` 的；桌面端没有那张表，所以页面得自己提供一份——和
// tools/browser-test 的做法一致（那边也是 React UMD + 一个 __ModuleLoader__ 垫片）。
//
// 产物不进仓库：它是依赖包的构建结果，`npm install` 之后跑一次这个脚本即可。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const OUT = join(DESKTOP, 'sidecar', 'page', 'react')

const FILES = [
  ['react/umd/react.development.js', 'react.development.js'],
  ['react-dom/umd/react-dom.development.js', 'react-dom.development.js'],
]

mkdirSync(OUT, { recursive: true })
let copied = 0
for (const [from, to] of FILES) {
  const source = join(DESKTOP, 'node_modules', from)
  if (!existsSync(source)) {
    console.error('缺少 ' + source + ' —— 先在 dsh-live2d-pet-desktop/ 里跑 npm install')
    process.exitCode = 1
    continue
  }
  copyFileSync(source, join(OUT, to))
  copied += 1
  console.log('copied ' + to)
}
if (copied === FILES.length) console.log('REACT_VENDOR_OK')
