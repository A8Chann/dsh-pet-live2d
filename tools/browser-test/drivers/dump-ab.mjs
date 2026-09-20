import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9529
const PROFILE = join(PROFILES, '_ab')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC';return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const rect = JSON.parse(await ev('(()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)})})()'))
const shots = []
// IMPORTANT: the layer pass runs from loadParameters, so free/restore must not
// fight it; we freeze rAF to hold the last painted frame for a fair compare.
const shot = async (label, setup, settle) => {
  await setup()
  await sleep(settle)
  await ev('window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = function(){ return 0 }')
  await sleep(350)
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
  shots.push({ label, data: s.result.data })
  await ev('window.requestAnimationFrame = window.__raf')
  await sleep(300)
}
const clear = () => ev('window.__dshLive2dPet.setExpressions([])')
const layer = (n) => () => ev('window.__dshLive2dPet.setExpressions([' + JSON.stringify(n) + '])')
const engine = (n) => () => ev('(function(){var m=window.__PET_DBG.model; window.__dshLive2dPet.setExpressions([]); return m.expression(' + JSON.stringify(n) + ').then(function(r){ window.__engineRet = String(r) })})()')
await shot('baseline', clear, 900)
await shot('layer 圆眼镜 (1s)', layer('圆眼镜'), 1000)
await shot('layer 圆眼镜 (3s)', layer('圆眼镜'), 3000)
await shot('engine 圆眼镜 (3s)', engine('圆眼镜'), 3000)
await shot('engine ret', async () => {}, 100)
await shot('layer 喵喵手', layer('喵喵手'), 2000)
await shot('layer 双手比耶', layer('双手比耶'), 2000)
await shot('layer 深色桌布', layer('深色桌布'), 2000)
writeFileSync(join(SHOTS, '_sheet.json'), JSON.stringify({ rect, shots }))
console.log('engine returned: ' + await ev('String(window.__engineRet)'))
console.log('cells: ' + shots.map(s => s.label).join(' | '))
ws.close(); edge.kill(); await sleep(300); process.exit(0)