// 提示音单元探针：使用实际客户端代码，替换浏览器音频设备，断言事件与静音行为。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { PLUGIN } from './paths.mjs'

const frequencies = []
const files = []
let suspends = 0
class FakeAudio {
  constructor(url) { this.url = url; this.volume = 1; this.plays = 0; this.pauses = 0; files.push(this) }
  play() { this.plays++; return Promise.resolve() }
  pause() { this.pauses++ }
}
class FakeAudioContext {
  state = 'running'
  currentTime = 1
  destination = {}
  createOscillator() {
    const oscillator = {
      type: '', frequency: { value: 0 }, connect() {},
      start: () => frequencies.push(oscillator.frequency.value), stop() {},
    }
    return oscillator
  }
  createGain() {
    return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
  }
  suspend() { suspends++; this.state = 'suspended'; return Promise.resolve() }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { return Promise.resolve() }
}
const store = new Map()
const window = {
  AudioContext: FakeAudioContext,
  Audio: FakeAudio,
  location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  __ModuleLoader__: { load: ({ factory }) => { window.plugin = factory(() => ({ createElement() {} })) } },
}
const source = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8')
const seam = '  exports.apply = apply;'
assert.equal(source.split(seam).length, 2, '客户端测试入口只能有一处')
runInNewContext(source.replace(seam, `  exports.testSound = { applyFlag, applyTuning, playPhaseSound, restoreTuning, restoreOverrides, setPhaseSoundMuted, soundNotesFor, linesNow, manifest: MANIFEST, uploads: UPLOADED_SOUNDS, getVolume: () => TUNING.soundVolume };\n${seam}`), {
  window, document: {}, console, Map, Set, fetch: () => Promise.resolve({ status: 404 }),
})
const { testSound: sound } = window.plugin
sound.playPhaseSound('done')
assert.equal(frequencies.length, 0, '首次默认静音')
sound.applyFlag('soundEnabled', true)
sound.playPhaseSound('done')
assert.deepEqual(frequencies, [660, 880], '完成提示使用上行两音')
sound.playPhaseSound('failed')
assert.deepEqual(frequencies.slice(-2), [370, 277], '失败提示使用下行两音')
sound.playPhaseSound('waiting')
assert.deepEqual(frequencies.slice(-2), [520, 660], '待批准使用单独提示')
sound.playPhaseSound('asking')
assert.deepEqual(frequencies.slice(-2), [520, 780], '待回答使用单独提示')
sound.playPhaseSound('thinking')
assert.equal(frequencies.length, 8, '普通相位不响')
sound.applyTuning({ soundVolume: 0 })
sound.playPhaseSound('done')
assert.equal(frequencies.length, 8, '音量为零时不响')
sound.restoreTuning({ soundVolume: 3 })
assert.equal(sound.getVolume(), 1, '异常存档音量被夹到合法范围')
sound.applyFlag('soundEnabled', false)
assert.equal(suspends, 1, '关掉提示音立即暂停音频设备')
sound.playPhaseSound('failed')
assert.equal(frequencies.length, 8, '关掉开关时不响')
// 宠物声明优先于内置声音：缺少的相位静音，空数组也明确表示静音。
sound.manifest.current = { sounds: { done: [[900, 0], [1200, 0.12]], failed: [] } }
sound.applyTuning({ soundVolume: 0.5 })
sound.applyFlag('soundEnabled', true)
sound.playPhaseSound('done')
assert.deepEqual(frequencies.slice(-2), [900, 1200], '随宠物换掉完成提示音')
sound.playPhaseSound('waiting')
sound.playPhaseSound('failed')
assert.equal(frequencies.length, 10, '宠物未声明或明确静音的相位不偷用内置音')
sound.setPhaseSoundMuted('done', true)
sound.playPhaseSound('done')
assert.equal(frequencies.length, 10, '用户静音覆盖宠物默认')
sound.restoreOverrides({ sounds: {} })
sound.playPhaseSound('done')
assert.equal(frequencies.length, 12, '另一窗口清除覆盖后恢复宠物默认')
sound.manifest.current = { id: 'pet-a', sounds: { done: [[900, 0]] } }
sound.uploads.petId = 'pet-a'
sound.uploads.sounds = { done: { token: 'a'.repeat(64), mime: 'audio/wav', bytes: 46 } }
sound.playPhaseSound('done')
assert.equal(files.length, 1, '同宠同相位优先使用上传音频')
assert.equal(files[0].volume, 0.5, '上传音频使用单独设置的音量')
assert.equal(frequencies.length, 12, '上传音频不会叠加宠物默认音符')
sound.playPhaseSound('tool')
assert.equal(files[0].pauses, 1, '切到没有声音的相位会停掉上一个上传音频')
sound.playPhaseSound('done')
sound.playPhaseSound('idle')
assert.equal(files[1].pauses, 1, '会话结束回到 idle 不继续播放文件')
sound.playPhaseSound('done')
sound.setPhaseSoundMuted('done', true)
assert.equal(files[2].pauses, 1, '正在播放时单独静音会立即停掉音频')
sound.playPhaseSound('done')
assert.equal(files.length, 3, '相位静音也能覆盖上传音频')
sound.restoreOverrides({ sounds: {} })
sound.manifest.current = { id: 'pet-b', sounds: { done: [[1100, 0]] } }
sound.playPhaseSound('done')
assert.equal(files.length, 3, '切换宠物不沿用上只宠物的上传音频')
assert.equal(frequencies.at(-1), 1100, '切换宠物后改用新宠物的音符')
sound.manifest.current = { sounds: { done: [[0, 0], [440, -1]] } }
sound.playPhaseSound('done')
assert.equal(frequencies.length, 13, '无效频率和负偏移不进入音频设备')
sound.manifest.current = { sounds: {} }
sound.playPhaseSound('done')
assert.equal(frequencies.length, 13, '宠物显式空表代表所有相位无声')
sound.manifest.current = { sounds: null }
sound.playPhaseSound('done')
assert.deepEqual(frequencies.slice(-2), [660, 880], '未声明声音的旧宠物走内置兜底')
sound.manifest.current.lines = { phase: { done: '宠物台词' } }
sound.restoreOverrides({ lines: { phase: { done: '用户台词' } } })
assert.equal(sound.linesNow().phase.done, '用户台词', '气泡显示用户覆盖')
sound.restoreOverrides({ lines: {} })
assert.equal(sound.linesNow().phase.done, '宠物台词', '另一窗口恢复默认后不留旧气泡覆盖')
console.log('PASS: pet sounds, default mute, phase overrides, validation')
