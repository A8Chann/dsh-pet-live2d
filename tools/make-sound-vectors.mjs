// 生成 `tools/sound-vectors.json`：音频容器判据的**合同向量**。
//
// 为什么要有这个文件：判据有两份实现 —— 网页宿主 `dsh-live2d-pet/lib/sound-files.js`
// 与桌面宿主 `dsh-live2d-pet-desktop/src-tauri/src/host/http.rs`。两份手写实现迟早分叉，
// 而分叉的症状（"网页端传得进、桌面端读不出来"）不报错、只静默。所以把"哪些字节流算
// 什么格式"抽成一份数据，两边测试都读它：**任何一边改歪了，另一边立刻红**。
//
//   node tools/make-sound-vectors.mjs          # 重新生成（改了下面的构造才需要跑）
//
// 里面的 CRC32 是**按 Ogg 规范独立写的一份**（故意不复用 lib/sound-files.js 的实现）：
// 万一两边同时对 CRC 理解错，这里的向量会跟着错、valid 用例就会红。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'sound-vectors.json')

/** Ogg 页校验：多项式 0x04c11db7、高位先行，校验时把 22..26 这 4 字节当 0。 */
function oggCrc(page) {
  let crc = 0
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index < 26 ? 0 : page[index]
    crc = (crc ^ (byte << 24)) >>> 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (((crc << 1) >>> 0) ^ ((crc & 0x80000000) !== 0 ? 0x04c11db7 : 0)) >>> 0
    }
  }
  return crc
}

/** 最小的合法 WAV：46 字节，fmt 16 + data 2 字节 @ 8 kHz 单声道 16 bit。 */
function wavPcm() {
  const b = Buffer.alloc(46)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(38, 4)
  b.write('WAVE', 8, 'latin1')
  b.write('fmt ', 12, 'latin1')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // 1 声道
  b.writeUInt32LE(8000, 24) // 采样率
  b.writeUInt32LE(16000, 28) // 字节率 = 8000 × 2
  b.writeUInt16LE(2, 32) // 块对齐 = 1 × 16/8
  b.writeUInt16LE(16, 34) // 位深
  b.write('data', 36, 'latin1')
  b.writeUInt32LE(2, 40)
  return b
}

/** IEEE float 32 bit 的 WAV（同一个头，只换 fmt / 长度字段）。 */
function wavFloat32() {
  const b = wavPcm()
  b.writeUInt16LE(3, 20) // format = IEEE float
  b.writeUInt16LE(32, 34) // 32 bit
  b.writeUInt16LE(4, 32) // 块对齐 = 4
  b.writeUInt32LE(32000, 24) // 采样率
  b.writeUInt32LE(128000, 28) // 字节率 = 32000 × 4
  b.writeUInt32LE(40, 4) // RIFF 长度 = 48 - 8
  b.writeUInt32LE(4, 40) // data 长度
  return Buffer.concat([b, Buffer.from([0, 0])]) // 48 字节
}

/** 合法的一页 Opus（47 字节，OpusHead 19 字节包）。 */
function oggOpus() {
  const b = Buffer.alloc(27 + 1 + 19)
  b.write('OggS', 0, 'latin1')
  b[5] = 2 // header type：BOS
  b[26] = 1 // 段表 1 项
  b[27] = 19
  b.write('OpusHead', 28, 'latin1')
  Buffer.from([1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]).copy(b, 36)
  b.writeUInt32LE(oggCrc(b), 22)
  return b
}

/** 合法的一页 Vorbis（58 字节，identification header 30 字节包）。 */
function oggVorbis() {
  const b = Buffer.alloc(27 + 1 + 30)
  b.write('OggS', 0, 'latin1')
  b[5] = 2
  b[26] = 1
  b[27] = 30
  let at = 28
  b[at] = 0x01
  b.write('vorbis', at + 1, 'latin1')
  at += 7
  at += 4 // version = 0
  b[at] = 2 // 2 声道
  at += 1
  b.writeUInt32LE(44100, at) // 采样率
  at += 4
  at += 12 // bitrate max / nominal / min = 0
  b[at] = 0x66 // 块大小（小 6 / 大 6）
  b[at + 1] = 1 // framing
  b.writeUInt32LE(oggCrc(b), 22)
  return b
}

/** 一个 MPEG1 Layer III、128 kbps、44.1 kHz、无 padding 的帧（正好 417 字节）。 */
function mp3Frame() {
  const b = Buffer.alloc(417)
  Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(b, 0)
  return b
}

const id3 = (frame) => Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x04abcd', 'latin1'), frame])

const withRiffSize = (bytes, size) => {
  const copy = Buffer.from(bytes)
  copy.writeUInt32LE(size, 4)
  return copy
}
const withByte = (bytes, at, value) => {
  const copy = Buffer.from(bytes)
  copy[at] = value
  return copy
}

const vectors = [
  { name: 'wav-pcm16', mime: 'audio/wav', bytes: wavPcm(), note: '最小合法 PCM WAV' },
  { name: 'wav-float32', mime: 'audio/wav', bytes: wavFloat32(), note: 'IEEE float 32 bit' },
  {
    name: 'wav-streaming-size-0',
    mime: 'audio/wav',
    bytes: withRiffSize(wavPcm(), 0),
    note: '长度字段写 0（流式录音常见）：放行',
  },
  {
    name: 'wav-streaming-size-unknown',
    mime: 'audio/wav',
    bytes: withRiffSize(wavPcm(), 0xffffffff),
    note: '长度字段写 0xFFFFFFFF（一直写到尾）：放行',
  },
  {
    name: 'wav-riff-size-wrong',
    mime: null,
    bytes: withRiffSize(wavPcm(), 39),
    note: '长度字段对不上（既不是 0/未知，也不是 文件长度-8）：拒绝',
  },
  { name: 'wav-no-data-chunk', mime: null, bytes: withRiffSize(wavPcm().subarray(0, 36), 28), note: '只有 fmt、没有 data' },
  { name: 'wav-truncated', mime: null, bytes: wavPcm().subarray(0, 44), note: '被截断的 WAV' },
  {
    name: 'wav-byte-rate-mismatch',
    mime: null,
    bytes: (() => { const b = wavPcm(); b.writeUInt32LE(8000, 28); return b })(),
    note: '字节率与 采样率×块对齐 不符',
  },
  { name: 'ogg-opus', mime: 'audio/ogg', bytes: oggOpus(), note: 'OpusHead 首包 + 正确 CRC' },
  { name: 'ogg-vorbis', mime: 'audio/ogg', bytes: oggVorbis(), note: 'Vorbis identification header + 正确 CRC' },
  { name: 'ogg-crc-broken', mime: null, bytes: withByte(oggOpus(), 30, oggOpus()[30] ^ 1), note: '改了一个字节：CRC 对不上' },
  { name: 'ogg-payload-missing', mime: null, bytes: oggOpus().subarray(0, 27), note: '段表说要 19 字节，后面什么都没有' },
  { name: 'ogg-truncated', mime: null, bytes: oggOpus().subarray(0, 46), note: '整页没读完' },
  { name: 'ogg-header-only', mime: null, bytes: Buffer.from('OggS', 'latin1'), note: '只有 4 字节魔数（旧版 JS 判据会收下它）' },
  { name: 'mp3-frame', mime: 'audio/mpeg', bytes: mp3Frame(), note: '一个完整帧（417 字节，正好卡在边界）' },
  { name: 'mp3-id3v2', mime: 'audio/mpeg', bytes: id3(mp3Frame()), note: 'ID3v2.4 标签 + 帧' },
  { name: 'mp3-id3-no-frame', mime: null, bytes: id3(Buffer.alloc(0)), note: '只有 ID3 标签，后面没有帧' },
  { name: 'mp3-bad-bitrate-index', mime: null, bytes: withByte(mp3Frame(), 2, 0xf0), note: 'bitrate index = 15（非法）' },
  { name: 'mp3-short-frame', mime: null, bytes: mp3Frame().subarray(0, 416), note: '帧头声明 417 字节，实际少 1 字节' },
  { name: 'plain-text', mime: null, bytes: Buffer.from('<script>alert(1)</script>', 'utf8'), note: '根本不是音频' },
]

const payload = {
  _comment: '音频容器判据的合同向量：dsh-live2d-pet/lib/sound-files.js 的 soundMime() 与 '
    + 'dsh-live2d-pet-desktop/src-tauri/src/host/http.rs 的 sound_mime() 必须对每一项给出同一个 mime；'
    + 'mime 为 null 表示必须拒绝。生成器：tools/make-sound-vectors.mjs。',
  vectors: vectors.map(({ name, mime, bytes, note }) => ({ name, mime, note, base64: bytes.toString('base64') })),
}
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log('已写出 ' + OUT + '：' + payload.vectors.length + ' 条向量')
