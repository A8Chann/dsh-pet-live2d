// Build one installable pet package from a source model pack.
//
// DSH only serves files whose paths pass the manifest validator, so every asset
// the model references is copied under an ASCII slug and the generated
// model3.json points at those slugs. pet.json / catalog.json / voice.json /
// README.md are authored by hand, not generated, and are preserved across a
// rebuild (see below).
//
// Usage:
//   node build-pet.mjs [--src <pack dir>] [--dest <pet dir>]
//
// Defaults to model-packs/DS鼠控版 in this repo, installed into
// %DSH_HOME%/pets/ds-whale-girl. Pass --dest to build somewhere else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');

/** Resolve a CLI flag's value, or undefined. */
const argOf = (flag) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined;
};

// %DSH_HOME% is C:\Users\<user>\.dsh by default on Windows, ~/.dsh elsewhere.
const DSH_HOME = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');

const SRC = path.resolve(argOf('--src') ?? path.join(REPO, 'model-packs', 'DS鼠控版'));
const DEST = path.resolve(argOf('--dest') ?? path.join(DSH_HOME, 'pets', 'ds-whale-girl'));

if (!fs.existsSync(SRC)) {
  console.error('source model pack not found: ' + SRC);
  console.error('It is a third-party asset and is NOT part of this repository.');
  console.error('Pass --src <dir> pointing at your own copy.');
  process.exit(1);
}

// --- ASCII slug tables (Chinese filenames are rejected by the manifest path
// validator, so every referenced asset gets a safe ASCII name) ---
const EXPRESSIONS = [
  // [slug, label, category, sourceFile]
  ['facial-red',      '脸红',        'emotion',   '脸红.exp3.json'],
  ['love-eyes',       '爱心眼',      'emotion',   '爱心眼.exp3.json'],
  ['star-eyes',       '星星眼',      'emotion',   '星星眼.exp3.json'],
  ['sparkle',         '情绪花花',    'emotion',   '情绪花花.exp3.json'],
  ['heartbeat',       '心跳',        'emotion',   '心跳.exp3.json'],
  ['excited',         '开心兴奋',    'emotion',   '开心兴奋.exp3.json'],
  ['sad',             '悲伤',        'emotion',   '悲伤.exp3.json'],
  ['cry',             '大哭',        'emotion',   '哭.exp3.json'],
  ['angry',           '生气',        'emotion',   '生气.exp3.json'],
  ['dizzy',           '晕晕',        'emotion',   '晕晕.exp3.json'],
  ['sweat',           '流汗',        'emotion',   '流汗.exp3.json'],
  ['question',        '问号',        'emotion',   '问号.exp3.json'],
  ['exclaim',         '感叹号',      'emotion',   '感叹号.exp3.json'],
  ['gloomy',          '阴暗',        'emotion',   '阴暗.exp3.json'],
  ['naughty',         '调皮',        'emotion',   '调皮.exp3.json'],
  ['drool',           '闭眼口水',    'emotion',   '闭眼口水.exp3.json'],
  ['soul-out',        '吐魂',        'emotion',   '吐魂.exp3.json'],
  ['tongue-out',      '吐舌',        'emotion',   '吐舌.exp3.json'],
  ['blank-eyes',      '呆呆眼',      'emotion',   '呆呆眼.exp3.json'],
  ['heart-pop',       '冒爱心',      'emotion',   'love.exp3.json'],
  ['glasses-round',   '圆眼镜',      'accessory', '圆眼镜.exp3.json'],
  ['glasses-square',  '方眼镜',      'accessory', '方眼镜.exp3.json'],
  ['glasses-oval',    '椭圆眼镜',    'accessory', '椭圆眼镜.exp3.json'],
  ['sunglasses',      '墨镜',        'accessory', '墨镜.exp3.json'],
  ['headband',        '头箍',        'accessory', '头箍.exp3.json'],
  ['ponytail',        '单边马尾',    'accessory', '单边马尾.exp3.json'],
  ['sticker-bow',     '蝴蝶结贴纸',  'accessory', '蝴蝶结贴纸.exp3.json'],
  ['sticker-cat',     '猫猫贴纸',    'accessory', '猫猫贴纸.exp3.json'],
  ['sticker-rabbit',  '兔兔贴纸',    'accessory', '兔兔贴纸.exp3.json'],
  ['whale',           '头顶鲸',      'prop',      '鲸鱼.exp3.json'],
  ['whale-on-desk',   '鲸鱼放桌上',  'prop',      '鲸鱼放桌上.exp3.json'],
  ['parfait',         '桌面巴菲',    'prop',      '巴菲.exp3.json'],
  ['omurice',         '蛋包饭',      'prop',      '蛋包饭.exp3.json'],
  ['claw',            '桌面粉魔爪',  'prop',      '魔爪.exp3.json'],
  ['claw-recolor',    '魔爪换色',    'prop',      '魔爪换色.exp3.json'],
  ['hands-peace',     '双手比耶',    'prop',      '双手比耶.exp3.json'],
  ['cat-paws',        '喵喵手',      'prop',      '喵喵手~喵~动画.exp3.json'],
  ['phone-recolor',   '手机换色',    'prop',      '手机换色.exp3.json'],
  ['dark-tablecloth', '深色桌布',    'prop',      '深色桌布.exp3.json'],
  ['draw-brush',      '画笔',        'prop',      '画笔.exp3.json'],
  ['draw-eraser',     '橡皮',        'prop',      '橡皮.exp3.json'],
  ['draw-undo',       '撤回',        'prop',      '撤回.exp3.json'],
  ['menu-press',      '点菜按下',    'prop',      '点菜按下.exp3.json'],
  ['ketchup-squeeze', '挤番茄酱',    'prop',      '挤.exp3.json'],
];

const MOTIONS = [
  // [group, slug, label, sourceRel]
  ['Idle',        'idle',          '待机',       'motions/idle.motion3.json'],
  ['Hammer',      'hammer',        '重锤出击',   'aidale.motion3.json'],
  ['BubbleGum',   'bubble-gum',    '吹泡泡糖',   'motions/chuipaopao.motion3.json'],
  ['SprayWater',  'spray-water',   '鲸鱼喷水',   'motions/喷水.motion3.json'],
  ['OpenCase',    'open-case',     '掏出手机',   'motions/开盖.motion3.json'],
  ['Selfie',      'selfie',        '自拍动画',   'motions/自拍.motion3.json'],
  ['SelfieQuick', 'selfie-quick',  '快速自拍',   'motions/自拍简单.motion3.json'],
  ['Ketchup',     'ketchup',       '挤番茄酱',   'motions/番茄酱.motion3.json'],
];

const TEXTURES = ['c_0120.2048/texture_00.png', 'c_0120.2048/texture_01.png'];

// --- 1. fresh destination ---
// pet.json / catalog.json / README.md / voice.json are authored by hand and are
// NOT build outputs, so they are carried across the wipe instead of being
// destroyed by it — re-running the builder must be a safe, idempotent step.
const HAND_WRITTEN = ['pet.json', 'catalog.json', 'README.md', 'voice.json'];
const preserved = {};
for (const name of HAND_WRITTEN) {
  const file = path.join(DEST, name);
  if (fs.existsSync(file)) preserved[name] = fs.readFileSync(file);
}
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.join(DEST, 'motions'), { recursive: true });
fs.mkdirSync(path.join(DEST, 'expressions'), { recursive: true });
fs.mkdirSync(path.join(DEST, 'textures'), { recursive: true });
fs.mkdirSync(path.join(DEST, 'previews'), { recursive: true });
fs.mkdirSync(path.join(DEST, 'model'), { recursive: true });

// --- 2. core model files (renamed to safe ASCII segments) ---
const copy = (rel, out) => fs.copyFileSync(path.join(SRC, rel), path.join(DEST, out));
copy('c_0120.moc3', 'model/c_0120.moc3');
copy('c_0120.physics3.json', 'model/c_0120.physics3.json');
copy('c_0120.cdi3.json', 'model/c_0120.cdi3.json');
TEXTURES.forEach((t, i) => copy(t, 'textures/texture_0' + i + '.png'));

// --- 3. motions + expressions, slugged ---
for (const [, slug, , rel] of MOTIONS) copy(rel, 'motions/' + slug + '.motion3.json');
for (const [slug, , , rel] of EXPRESSIONS) copy(rel, 'expressions/' + slug + '.exp3.json');

// --- 4. model3.json with the full Motion/Expression closure ---
const model3 = {
  Version: 3,
  FileReferences: {
    Moc: 'model/c_0120.moc3',
    Textures: ['textures/texture_00.png', 'textures/texture_01.png'],
    Physics: 'model/c_0120.physics3.json',
    DisplayInfo: 'model/c_0120.cdi3.json',
    Motions: Object.fromEntries(MOTIONS.map(([group, slug]) => [group, [{ File: 'motions/' + slug + '.motion3.json' }]])),
    Expressions: EXPRESSIONS.map(([slug, label]) => ({ Name: label, File: 'expressions/' + slug + '.exp3.json' })),
  },
  Groups: [
    { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
    { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
  ],
  // NOTE: no HitAreas. The source model (DS鼠控版/c_0120.model3.json) declares
  // none, and inventing them makes Cubism hit-testing look configured when the
  // underlying drawable indices do not exist — every hitTest then returns [].
  // The plugin derives the clickable silhouette from the rendered alpha
  // instead, which works for any model.
};
fs.writeFileSync(path.join(DEST, 'c_0120.model3.json'), JSON.stringify(model3, null, 2) + '\n', 'utf8');

// --- 5. restore the hand-authored files ---
for (const [name, buf] of Object.entries(preserved)) fs.writeFileSync(path.join(DEST, name), buf);

// --- 6. preview ---
fs.copyFileSync(path.join(SRC, 'icon.png'), path.join(DEST, 'previews/idle.png'));

fs.writeFileSync(path.join(TOOLS, '_pet-tables.json'), JSON.stringify({ EXPRESSIONS, MOTIONS }, null, 1), 'utf8');
console.log('source pack : ' + SRC);
console.log('built pet   : ' + DEST);
console.log('files:', fs.readdirSync(DEST).join(', '));
