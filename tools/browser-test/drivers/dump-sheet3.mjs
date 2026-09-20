import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9519
const PROFILE = join(PROFILES, '_sheet3')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const rect = JSON.parse(await ev('(()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)})})()'))
const cells = [
  ['none', []],
  ['cat-paws', ['喵喵手']],
  ['peace', ['双手比耶']],
  ['cat THEN peace', ['喵喵手','双手比耶']],
  ['peace THEN cat', ['双手比耶','喵喵手']],
  ['round glasses', ['圆眼镜']],
  ['round THEN square', ['圆眼镜','方眼镜']],
  ['star THEN love', ['星星眼','爱心眼']],
]
const shots = []
for (const [label, names] of cells) {
  await ev('window.__dshLive2dPet.setExpressions(' + JSON.stringify(names) + ')')
  await sleep(1000)
  // Freeze AFTER the expression has been written and painted, so the canvas
  // keeps the last rendered frame and every cell is comparable.
  await ev('window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = function(){ return 0 }')
  await sleep(300)
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
  shots.push({ label, data: shot.result.data })
  await ev('window.requestAnimationFrame = window.__raf')
  await sleep(250)
}
writeFileSync(join(SHOTS, '_sheet.json'), JSON.stringify({ rect, shots }))
console.log('cells: ' + cells.map(c => c[0]).join(' | '))
ws.close(); edge.kill(); await sleep(300); process.exit(0)