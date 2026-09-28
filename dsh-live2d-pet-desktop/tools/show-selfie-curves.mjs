// 把原始 `自拍.motion3.json` 里几条 phone 参数的**时间序列**打出来。
//
// 用户的描述：「自拍时右上（右手）要向上位移然后拍照，最后右手放下」。
// 所以"抬手"发生在**自拍这段里**。那就看这几条参数在这段里的走势：哪一条是
// "先升后降"的，哪一条就管手的高度。
import { readFileSync } from 'node:fs'

const file = 'P:/DSH/live2d原始/motions/自拍.motion3.json'
const motion = JSON.parse(readFileSync(file, 'utf8'))
console.log('Duration = ' + motion.Motion?.Duration + ' 秒，Loop = ' + motion.Motion?.Loop)
console.log('')

const wanted = /^phone\d*$/
for (const curve of motion.Curves ?? []) {
  const id = String(curve.Id)
  if (!wanted.test(id)) continue
  // Segments 的格式：每段先是类型，然后点；线性段是 [0, t0, v0, t1, v1, …]。
  const segments = curve.Segments ?? []
  const points = []
  let i = 0
  while (i < segments.length) {
    const type = segments[i]
    if (type === 0) {
      const count = segments[i + 1]
      for (let k = 0; k < count; k += 1) {
        points.push([segments[i + 2 + k * 2], segments[i + 3 + k * 2]])
      }
      i += 2 + count * 2
    } else if (type === 1 || type === 2 || type === 3) {
      const t = segments[i + 1]
      const v = segments[i + 2]
      points.push([t, v])
      i += 3
    } else {
      i += 1
    }
  }
  const times = points.map((p) => p[0])
  const values = points.map((p) => p[1])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const first = values[0]
  const last = values[values.length - 1]
  const peakAt = times[values.indexOf(max)]
  console.log(id.padEnd(8)
    + ' 起点 ' + String(first).padStart(6)
    + '  终点 ' + String(last).padStart(6)
    + '  区间 [' + min + ', ' + max + ']'
    + '  峰值在 t=' + peakAt + 's'
    + '  (' + points.length + ' 个点)')
  // 采样打印，看走势（只打 phone2/phone5 这种候选）
  if (id === 'phone2' || id === 'phone5' || id === 'phone4') {
    const shown = []
    for (let t = 0; t <= (motion.Motion?.Duration ?? 3); t += 0.25) {
      // 线性插值取该时刻的值（够看走势了）
      let value = values[0]
      for (let k = 1; k < points.length; k += 1) {
        if (times[k] >= t) {
          const t0 = times[k - 1]
          const t1 = times[k]
          const v0 = values[k - 1]
          const v1 = values[k]
          value = t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
          break
        }
        value = values[k]
      }
      shown.push(t.toFixed(2) + 's=' + Number(value).toFixed(2))
    }
    console.log('    ' + shown.join('  '))
  }
}
