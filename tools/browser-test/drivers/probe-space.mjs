import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9485
const PROFILE = join(PROFILES, '_space')
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
// Map the face drawable box into STAGE coordinates via the model transform.
const mapped = await ev(`JSON.stringify((()=>{const m=window.__PET_DBG.model;const im=m.internalModel;const ids=im.getDrawableIDs();const rx=/(face_|^face|eye|mouth|nose|brow|cheek)/i;let a=1e9,b=1e9,c=-1,d=-1;for(const id of ids){const s=String(id);if(!rx.test(s))continue;const i=im.getDrawableIndex(s);if(i<0)continue;const bb=im.getDrawableBounds(i,{});if(!isFinite(bb.x)||bb.width<=0)continue;a=Math.min(a,bb.x);b=Math.min(b,bb.y);c=Math.max(c,bb.x+bb.width);d=Math.max(d,bb.y+bb.height)}
  const P = window.__dshLive2dPetVendor.Point;
  const corners = [new P(a,b), new P(c,b), new P(a,d), new P(c,d)];
  const xs=[], ys=[];
  for (const p of corners) { const w = m.toGlobal(p); xs.push(w.x); ys.push(w.y) }
  return { faceModel:{x:a,y:b,w:c-a,h:d-b}, faceStage:{x1:Math.min(...xs),x2:Math.max(...xs),y1:Math.min(...ys),y2:Math.max(...ys)}, modelStage:(()=>{const g=m.getBounds();return {x:g.x,y:g.y,w:g.width,h:g.height}})() }})())`)
console.log('mapped:', mapped)
ws.close(); edge.kill(); process.exit(0)