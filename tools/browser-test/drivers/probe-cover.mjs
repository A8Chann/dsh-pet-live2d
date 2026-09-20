import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9489
const PROFILE = join(PROFILES, '_cover')
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
await sleep(3500)
console.log('maskInfo:', await ev('JSON.stringify(window.__dshLive2dPet.maskInfo())'))
console.log('headBox :', await ev('JSON.stringify(window.__dshLive2dPet.headBox())'))
const info = await ev(`(()=>{const r=document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect();const p=document.querySelector('[data-dsh-live2d-pet] [data-hit]');const d=p.style.clipPath||'';const nums=(d.match(/-?[0-9.]+/g)||[]).map(Number);return JSON.stringify({rect:{x:r.x,y:r.y,w:r.width,h:r.height},firstNums:nums.slice(0,8),clipLen:d.length,cs:getComputedStyle(p).clipPath.slice(0,80)})})()`)
console.log('proxy:', info)
const sweep = await ev(`(()=>{const c=window.__dshLive2dPet;const r=document.querySelector('[data-dsh-live2d-pet] [data-stage]').getBoundingClientRect();const rows=[];for(let iy=0;iy<16;iy++){let s='';for(let ix=0;ix<16;ix++){const lx=r.width*(ix+0.5)/16,ly=r.height*(iy+0.5)/16;const m=c.hitsMask(lx,ly,r.width,r.height);const el=document.elementFromPoint(r.x+lx,r.y+ly);const isHit=!!(el&&el.hasAttribute&&el.hasAttribute('data-hit'));s+= m?(isHit?'#':'m'):(isHit?'h':'.')}rows.push(s)}return JSON.stringify(rows)})()`)
console.log('coverage: # = mask AND hit-proxy, m = mask only, h = proxy only, . = neither')
for (const r of JSON.parse(sweep)) console.log('  '+r)
ws.close(); edge.kill(); process.exit(0)