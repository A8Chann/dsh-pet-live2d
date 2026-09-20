import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
const EDGE = browserPath(); const PORT = 9565
const PROFILE = join(PROFILES, '_ui')
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
for (let i=0;i<240;i++){await sleep(400); if(await ev('document.title')==='done') break}
await waitReady(ev)
await sleep(600)
// A point on the character, for hovering and right-clicking.
const body = JSON.parse(await ev(`(()=>{const c=window.__dshLive2dPet;const r=document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect();for(let iy=20;iy<44;iy++)for(let ix=0;ix<64;ix++){const lx=r.width*(ix+0.5)/64,ly=r.height*(iy+0.5)/64;if(c.hitsMask(lx,ly,r.width,r.height))return JSON.stringify({x:r.x+lx,y:r.y+ly,rect:{x:r.x,y:r.y,w:r.width,h:r.height}})}return 'null'})()`))
const full = async (label) => {
  await sleep(500)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  return { label, data: s.result.data }
}
const shots = []
// 1. untouched
await ev('document.body.dispatchEvent(new MouseEvent("mousemove",{clientX:5,clientY:5,bubbles:true}))')
shots.push(await full('idle'))
// 2. genuinely hovering the character
for (let i=0;i<6;i++){ await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:body.x-8+i*2,y:body.y-4+i}); await sleep(120) }
await sleep(700)
shots.push(await full('hovering the pet'))
console.log('panels while hovering: ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel]").length'))
console.log('bars while hovering:   ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-bar]").length'))
// 3. a REAL right-click on the character
await send('Input.dispatchMouseEvent',{type:'mousePressed',x:body.x,y:body.y,button:'right',buttons:2,clickCount:1})
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:body.x,y:body.y,button:'right',buttons:0,clickCount:1})
await sleep(900)
console.log('panels after right-click: ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel]").length'))
shots.push(await full('after right-click'))
// 4. the 动作 tab contents render
console.log('tabs: ' + await ev('JSON.stringify(Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-tabs] button")).map(b=>b.textContent))'))
console.log('motion chips: ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] [data-chips] button").length'))
// 5. Escape closes it
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
await sleep(600)
console.log('panels after Esc: ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet] [data-panel]").length'))
shots.push(await full('after Esc'))
writeFileSync(join(SHOTS, '_sheet.json'), JSON.stringify({ rect: body.rect, shots }))
console.log('cells: ' + shots.map(s => s.label).join(' | '))
ws.close(); edge.kill(); await sleep(300); process.exit(0)