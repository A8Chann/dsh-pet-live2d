import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9481
const PROFILE = join(PROFILES, '_face')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1400,900','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:'http://127.0.0.1:8793/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(400); if(await ev('document.title')==='done') break}
await sleep(4000)
const expr = `JSON.stringify((()=>{const im=window.__PET_DBG.model.internalModel;const ids=im.getDrawableIDs();const face=/face|eye|mouth|brow|nose|tear|cheek|hair|head|kao/i;let minX=1e9,minY=1e9,maxX=-1,maxY=-1,hit=[];for(let k=0;k<ids.length;k++){const id=String(ids[k]);if(!face.test(id))continue;const i=im.getDrawableIndex(id);if(i<0)continue;const b=im.getDrawableBounds(i,{});if(!isFinite(b.x)||b.width<=0)continue;minX=Math.min(minX,b.x);minY=Math.min(minY,b.y);maxX=Math.max(maxX,b.x+b.width);maxY=Math.max(maxY,b.y+b.height);hit.push(id)}return {count:hit.length,sample:hit.slice(0,12),box:maxX<0?null:{x:minX,y:minY,w:maxX-minX,h:maxY-minY},orig:[im.originalWidth,im.originalHeight]}})())`
console.log('face union:', await ev(expr))
// And the full model bounds for reference.
const all = `JSON.stringify((()=>{const im=window.__PET_DBG.model.internalModel;const ids=im.getDrawableIDs();let a=1e9,b=1e9,c=-1,d=-1;for(const id of ids){const i=im.getDrawableIndex(id);if(i<0)continue;const bb=im.getDrawableBounds(i,{});if(!isFinite(bb.x)||bb.width<=0)continue;a=Math.min(a,bb.x);b=Math.min(b,bb.y);c=Math.max(c,bb.x+bb.width);d=Math.max(d,bb.y+bb.height)}return {x:a,y:b,w:c-a,h:d-b}})())`
console.log('all-drawables union:', await ev(all))
ws.close(); edge.kill(); process.exit(0)