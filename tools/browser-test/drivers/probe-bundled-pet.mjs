// 验证：全新的 DSH_HOME（一个宠物都没有）下，随包分发的宠物会被自动装好。
import { buildCatalog, petsRoot } from '../../../dsh-live2d-pet/lib/index.js'
import { existsSync, writeFileSync } from 'node:fs'
console.log('DSH_HOME = ' + process.env.DSH_HOME)
console.log('petsRoot = ' + petsRoot())
const pets = buildCatalog()
console.log('catalog  = ' + JSON.stringify(pets.map((p) => p.id)))
console.log('已复制   = ' + existsSync(petsRoot() + '/ds-whale-girl/pet.json'))
const first = pets[0]
if (first !== undefined) {
  console.log('内容     = 动作 ' + (first.motions ?? []).length + ' / 表情 ' + (first.expressions ?? []).length
    + ' / 槽位 ' + (first.expressionSlots ?? []).length)
}
// 幂等：再调一次不能重复装，也不能动用户改过的文件
writeFileSync(petsRoot() + '/ds-whale-girl/用户改过.txt', 'x')
const again = buildCatalog()
console.log('幂等     = ' + (again.length === pets.length) + '，用户文件还在 = ' + existsSync(petsRoot() + '/ds-whale-girl/用户改过.txt'))