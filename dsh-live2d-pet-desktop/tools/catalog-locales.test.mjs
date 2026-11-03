// 宠物语言覆盖层：宿主把 `<pet>/locale/<lang>.json` 原样随 catalog 下发，浏览器半区
// 只拿它换**显示文案**。
//
// 这条盯的是"身份与显示分开"这个契约：`expressionSlots[].options[].label`、`looksByPhase`
// 的值、`pairs` / `requires` 等都是浏览器半区按字符串相等比较（`slotOfLabel()` /
// `relationsOf()`）或写进用户存档的，覆盖层一旦改写它们，老存档会静默失效。
//
//   node --test dsh-live2d-pet-desktop/tools/catalog-locales.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN } from './paths.mjs'

const host = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)

/** 造一只最小可扫描的宠物（只需要 model3.json 点名的文件都在）。 */
function scanFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-locale-'))
  writeFileSync(join(dir, 'model.model3.json'), '{"FileReferences":{"Moc":"model.moc3"}}')
  writeFileSync(join(dir, 'model.moc3'), 'moc3-bytes')
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({ renderer: 'live2d', live2d: { model: 'model.model3.json' } }))
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(dir, relative, '..'), { recursive: true })
    writeFileSync(join(dir, relative), content)
  }
  return host.scanPet(dir, 'fixture-pet')
}

test('随包宠物带英文覆盖层，身份字段仍是清单原文', () => {
  const pet = host.scanPet(join(PLUGIN, 'pets', 'ds-whale-girl'), 'ds-whale-girl')
  assert.ok(pet, '随包宠物要能扫描')
  assert.equal(pet.locales.en.displayName, 'DS Whale Girl')
  assert.equal(pet.locales.en.lines.greet[0], "Hi there! I'm the whale girl~")
  assert.equal(pet.locales.en.slots.glasses.label, 'Glasses')

  // 身份字段不能被覆盖层改写：选项标签、槽位标签、looksByPhase 值都保持清单原文。
  assert.equal(pet.displayName, 'DS鲸鱼娘')
  assert.equal(pet.expressionSlots[0].label, '眼镜')
  assert.equal(pet.expressionSlots[0].options[0].label, '圆眼镜')
  assert.equal(pet.looksByPhase.done.whale, '头顶鲸')
  // 身份引用的列表也保持中文（patReactions 等按动作/表情标签解析）。
  assert.equal(pet.patReactions[0], '重锤出击')
})

test('没有 locale 目录的宠物：locales 是空对象，照常可扫描', () => {
  const pet = scanFixture({})
  assert.ok(pet, '没有覆盖层不该影响扫描')
  assert.deepEqual(pet.locales, {})
})

test('语言文件名只收合法段名；坏 JSON / 非对象被跳过，好文件照常下发', () => {
  const pet = scanFixture({
    'locale/en.json': JSON.stringify({ displayName: 'Fixture' }),
    'locale/fr.json': JSON.stringify({ displayName: 'Fixture FR' }),
    'locale/broken.json': '{not json',
    'locale/array.json': '[1,2,3]',
    'locale/notes.txt': 'ignored',
  })
  assert.ok(pet)
  assert.deepEqual(Object.keys(pet.locales).sort(), ['en', 'fr'])
  assert.equal(pet.locales.fr.displayName, 'Fixture FR')
})
