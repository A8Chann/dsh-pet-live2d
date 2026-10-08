// 用户上传的相位音频只落在独立目录；请求路径和文件名均由白名单生成。
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOUND_PHASES = Object.freeze(['thinking', 'tool', 'waiting', 'asking', 'helper', 'queued', 'done', 'failed'])
export const MAX_AUDIO = 1024 * 1024
export const MAX_SOUND_BODY = 2 * 1024 * 1024

export function soundMime(bytes) {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return 'audio/mpeg'
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
