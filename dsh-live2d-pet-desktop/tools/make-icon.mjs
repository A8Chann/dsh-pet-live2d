// 最小 ICO 生成器：把一个 PNG 塞进 ICO 容器。
//
// 为什么不用现成的库：ICO 就是"文件头 + 目录项 + 一段 PNG 字节"，PNG 压缩的 ICO 是
// Vista 之后的标准写法，二十行就够；为它拉一个依赖不值得。
//
//   node tools/make-icon.mjs <输入.png> <输出.ico> [尺寸]
import { readFileSync, writeFileSync } from 'node:fs'

const [source, target, sizeArg] = process.argv.slice(2)
if (source === undefined || target === undefined) {
  console.error('用法：node tools/make-icon.mjs <输入.png> <输出.ico> [尺寸=256]')
  process.exit(1)
}
const size = Number(sizeArg ?? 256)
const png = readFileSync(source)

// ICONDIR：reserved(0) type(1=icon) count(1)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)

// ICONDIRENTRY：宽 高 调色板 保留 平面 位深 字节数 偏移
// 宽高写 0 表示 256 —— 这是 ICO 格式的历史约定。
const entry = Buffer.alloc(16)
entry.writeUInt8(size >= 256 ? 0 : size, 0)
entry.writeUInt8(size >= 256 ? 0 : size, 1)
entry.writeUInt8(0, 2)
entry.writeUInt8(0, 3)
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(header.length + entry.length, 12)

writeFileSync(target, Buffer.concat([header, entry, png]))
console.log('ICON_OK ' + target + ' (' + png.length + ' bytes png, size=' + size + ')')
