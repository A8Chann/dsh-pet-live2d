// 用户上传的相位音频只落在独立目录；请求路径和文件名均由白名单生成。
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOUND_PHASES = Object.freeze(['thinking', 'tool', 'waiting', 'asking', 'helper', 'queued', 'done', 'failed'])
export const MAX_AUDIO = 1024 * 1024
export const MAX_SOUND_BODY = 2 * 1024 * 1024

// ---- 容器判据：**与桌面端 Rust 宿主逐条一致** -------------------------------
//
// `dsh-live2d-pet-desktop/src-tauri/src/host/http.rs` 的 `valid_wav` / `valid_ogg` /
// `valid_mp3` / `ogg_checksum` 是同一套规则的另一个实现。**改一边必须同时改另一边**，
// 而且两边都要跑 `tools/sound-vectors.json` 的合同向量（`tools/browser-test/test-sound-upload.mjs`
// 与 Rust 单测 `sound_vectors_contract` 都读它）—— 判据分叉的症状是"网页端传得进、
// 桌面端读不出来/相位的已上传消失"，而且两边都不报错。
//
// 只认魔数是不够的：那样一个 4 字节的 "OggS"、一个乱改过长度的 WAV 都会写进
// `$DSH_HOME/pet-sounds/`，桌面端却读不出来。
const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8)
const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
const at4 = (bytes, from, to) => bytes.toString('latin1', from, to)

function validWav(bytes) {
  if (bytes.length < 12 || at4(bytes, 0, 4) !== 'RIFF' || at4(bytes, 8, 12) !== 'WAVE') return false
  // RIFF 头里的长度字段：流式录音这类文件常写 0 或 0xFFFFFFFF（"长度未知/一直写到尾"），
  // 浏览器照样能播，所以只对这三个值放行，其余仍要求精确匹配（畸形头照旧拒绝）。
  const declared = u32(bytes, 4)
  if (declared !== 0 && declared !== 0xffffffff && declared !== bytes.length - 8) return false
  let offset = 12
  let blockAlign
  let dataSize
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false
    const id = at4(bytes, offset, offset + 4)
    const size = u32(bytes, offset + 4)
    const end = offset + 8 + size
    if (end > bytes.length) return false // 块越界（对应 Rust 的 get() 失败）
    if (id === 'fmt ') {
      if (blockAlign !== undefined || size < 16) return false
      const format = u16(bytes, offset + 8)
      const channels = u16(bytes, offset + 10)
      const rate = u32(bytes, offset + 12)
      const byteRate = u32(bytes, offset + 16)
      const align = u16(bytes, offset + 20)
      const bits = u16(bytes, offset + 22)
      if ((format !== 1 && format !== 3) || channels === 0 || rate === 0 || bits === 0 || bits % 8 !== 0) return false
      if (format === 3 && bits !== 32 && bits !== 64) return false
      if (align !== channels * (bits / 8)) return false
      if (byteRate !== rate * align) return false // rate ≤ 2^32、align ≤ 2^16：JS 双精度够用
      blockAlign = align
    } else if (id === 'data') {
      if (dataSize !== undefined) return false
      dataSize = size
    }
    offset = end + (size % 2) // 块按偶数字节对齐
    if (offset > bytes.length) return false
  }
  if (blockAlign === undefined || dataSize === undefined) return false
  return dataSize > 0 && dataSize % blockAlign === 0
}

/** Ogg 的 CRC32（多项式 0x04c11db7，高位先行，校验时把 22..26 这 4 字节当 0）。 */
function oggChecksum(page) {
  let crc = 0
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index < 26 ? 0 : page[index]
    crc = (crc ^ (byte << 24)) >>> 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x80000000) !== 0 ? 0x04c11db7 : 0)) >>> 0
    }
  }
  return crc
}

function validOgg(bytes) {
  if (bytes.length < 27) return false
  if (at4(bytes, 0, 4) !== 'OggS' || bytes[4] !== 0 || bytes[5] !== 2) return false
  if (u32(bytes, 18) !== 0) return false // 页序号必须是 0：只认第一页
  const segmentCount = bytes[26]
  const segmentsAt = 27
  if (segmentsAt + segmentCount > bytes.length) return false
  const segments = bytes.subarray(segmentsAt, segmentsAt + segmentCount)
  let payloadSize = 0
  for (const size of segments) payloadSize += size
  const start = segmentsAt + segmentCount
  if (start + payloadSize > bytes.length) return false
  const page = bytes.subarray(0, start + payloadSize)
  if (oggChecksum(page) !== u32(bytes, 22)) return false
  let packetEnd = -1
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] < 255) { packetEnd = index; break }
  }
  if (packetEnd < 0) return false
  let packetSize = 0
  for (let index = 0; index <= packetEnd; index += 1) packetSize += segments[index]
  const packet = page.subarray(start, start + packetSize)
  if (packet.length >= 8 && at4(packet, 0, 8) === 'OpusHead') {
    if (packet.length < 19 || packet[8] !== 1 || packet[9] === 0) return false
    if (packet[18] === 0) return packet[9] <= 2 && packet.length === 19
    return packet[18] !== 255 && packet.length >= 21 + packet[9]
  }
  if (packet.length >= 7 && packet[0] === 0x01 && at4(packet, 1, 7) === 'vorbis') {
    return packet.length === 30
      && packet[7] === 0 && packet[8] === 0 && packet[9] === 0 && packet[10] === 0
      && packet[11] !== 0
      && !(packet[12] === 0 && packet[13] === 0 && packet[14] === 0 && packet[15] === 0)
      && (packet[28] & 15) >= 6 && (packet[28] >> 4) >= (packet[28] & 15) && (packet[28] >> 4) <= 13
      && packet[29] === 1
  }
  return false
}

const MP3_BITRATES = {
  mpeg1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  mpeg1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  mpeg1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  mpeg2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  mpeg2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
}
const mp3Bitrates = (version, layer) => {
  if (version === 3) return layer === 3 ? MP3_BITRATES.mpeg1L1 : layer === 2 ? MP3_BITRATES.mpeg1L2 : MP3_BITRATES.mpeg1L3
  return layer === 3 ? MP3_BITRATES.mpeg2L1 : MP3_BITRATES.mpeg2L23
}

function validMp3(bytes) {
  let offset = 0
  if (at4(bytes, 0, 3) === 'ID3') {
    if (bytes.length < 10) return false
    const major = bytes[3]
    const flags = bytes[5]
    if (major < 2 || major > 4 || bytes[4] === 0xff) return false
    for (let index = 6; index < 10; index += 1) {
      if ((bytes[index] & 0x80) !== 0) return false // 尺寸字段是 synchsafe 的
    }
    const reserved = major === 4 ? 0x0f : major === 3 ? 0x1f : 0x3f
    if ((flags & reserved) !== 0) return false
    let tagSize = 0
    for (let index = 6; index < 10; index += 1) tagSize = tagSize * 128 + bytes[index]
    offset = 10 + tagSize + (major === 4 && (flags & 0x10) !== 0 ? 10 : 0)
  }
  if (offset + 4 > bytes.length) return false
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const b3 = bytes[offset + 3]
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return false
  const version = (b1 >> 3) & 3
  const layer = (b1 >> 1) & 3
  const bitrateIndex = (b2 >> 4) & 0x0f
  const rateIndex = (b2 >> 2) & 3
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return false
  const bitrate = mp3Bitrates(version, layer)[bitrateIndex] * 1000
  const rate = Math.floor([44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4))
  const padding = (b2 >> 1) & 1
  const frameSize = layer === 3
    ? Math.floor(12 * bitrate / rate + padding) * 4
    : Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate / rate) + padding
  return (b3 & 3) !== 2 && bytes.length - offset >= frameSize
}

export function soundMime(bytes) {
  if (validWav(bytes)) return 'audio/wav'
  if (validOgg(bytes)) return 'audio/ogg'
  if (validMp3(bytes)) return 'audio/mpeg'
  return undefined
}

function soundDir(home, create) {
  if (create) mkdirSync(home, { recursive: true })
  const dir = join(home, 'pet-sounds')
  if (create && !existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-path')
  return dir
}

function soundPath(home, id, phase, create = false) {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !SOUND_PHASES.includes(phase)) throw new Error('invalid-path')
  return join(soundDir(home, create), `${id}--${phase}.audio`)
}

export function readSound(home, id, phase) {
  try {
    const path = soundPath(home, id, phase)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUDIO) return undefined
    const bytes = readFileSync(path)
    const mime = soundMime(bytes)
    if (!mime || bytes.length > MAX_AUDIO) return undefined
    return { bytes, mime, token: createHash('sha256').update(bytes).digest('hex') }
  } catch { return undefined }
}

export function writeSound(home, id, phase, bytes) {
  const path = soundPath(home, id, phase, true)
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error('unsafe-path')
  const temp = join(soundDir(home, false), `.${randomBytes(16).toString('hex')}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    closeSync(fd)
    renameSync(temp, path)
  } catch (error) {
    try { closeSync(fd) } catch { /* 已关闭 */ }
    try { unlinkSync(temp) } catch { /* 已移走 */ }
    throw error
  }
}

export function resetSound(home, id, phase) {
  let path
  try { path = soundPath(home, id, phase) }
  catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-path')
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function decodeSound(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_AUDIO / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_AUDIO || bytes.toString('base64') !== value || !soundMime(bytes)) return undefined
  return bytes
}
