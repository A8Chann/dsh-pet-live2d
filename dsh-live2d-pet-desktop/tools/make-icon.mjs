// 从一张 PNG 生成桌面端要用的图标：多尺寸 .ico + 32x32 托盘图。
//
// 为什么托盘图要单独出：托盘那块地方只有 16×16 / 20×20，把 256 的图缩下去会发糊；
// 32×32 点对点才清晰。（参考实现 DSH Desktop 也是这么干的。）
//
//   node tools/make-icon.mjs [--source <png>] [--out <目录>]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const OUT_DIR = join(DESKTOP, 'src-tauri', 'icons')
const DEFAULT_SOURCES = [
  join(DESKTOP, 'src-tauri', 'icons', 'icon.png'),
  join(DESKTOP, '..', 'dsh-pet-live2d-banner-shots', 'trimmed', '01-默认待机.png'),
  join(DESKTOP, '..', 'dsh-pet-live2d-banner-shots', 'raw', '01-默认待机.png'),
]
const source = argOf('--source', DEFAULT_SOURCES.find((candidate) => existsSync(candidate)) ?? '')
if (source === '' || !existsSync(source)) {
  console.error('找不到图标源图。用 --source <png> 指定一张（建议 ≥256×256）：\n  ' + DEFAULT_SOURCES.join('\n  '))
  process.exit(1)
}
mkdirSync(OUT_DIR, { recursive: true })

/**
 * 用 System.Drawing 缩放。
 *
 * 为什么借 PowerShell 而不是纯 Node：纯 Node 要自己解 PNG 的 filter/交错再重采样
 * （参考实现里就有这么一份 200 行的实现）。这里只在构建期跑一次，系统自带的 GDI+
 * 已经够用，不值得为它引一个依赖。
 */
function resize(from, to, size) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile(${JSON.stringify(from)})`,
    `$dst = New-Object System.Drawing.Bitmap(${size}, ${size})`,
    '$g = [System.Drawing.Graphics]::FromImage($dst)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    `$g.DrawImage($src, 0, 0, ${size}, ${size})`,
    '$g.Dispose()',
    `$dst.Save(${JSON.stringify(to)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$dst.Dispose()',
    '$src.Dispose()',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' })
}

/** 最小 ICO 容器：目录项里宽高写 0 表示 256（ICO 的历史约定）。 */
function ico(target, entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, index) => {
    const at = index * 16
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    dir.writeUInt8(0, at + 2)
    dir.writeUInt8(0, at + 3)
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(entry.bytes.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.bytes.length
  })
  writeFileSync(target, Buffer.concat([header, dir, ...entries.map((entry) => entry.bytes)]))
}

// 多尺寸 ICO：Windows 会按 DPI / 视图挑合适的那一档。
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const temp = join(OUT_DIR, '.tmp-sizes')
mkdirSync(temp, { recursive: true })
const entries = []
for (const size of SIZES) {
  const file = join(temp, size + '.png')
  resize(source, file, size)
  entries.push({ size, bytes: readFileSync(file) })
}
ico(join(OUT_DIR, 'icon.ico'), entries)
resize(source, join(OUT_DIR, '32x32.png'), 32)
if (join(OUT_DIR, 'icon.png') !== source) copyFileSync(source, join(OUT_DIR, 'icon.png'))

const kb = (file) => Math.round(statSync(file).size / 1024) + 'KB'
console.log('图标就绪（源：' + source + '）')
console.log('  icon.ico   ' + kb(join(OUT_DIR, 'icon.ico')) + '（' + SIZES.join('/') + '）')
console.log('  32x32.png  ' + kb(join(OUT_DIR, '32x32.png')) + '（托盘）')
console.log('  icon.png   ' + kb(join(OUT_DIR, 'icon.png')))
console.log('ICON_OK')
