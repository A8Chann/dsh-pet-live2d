import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9483
const PROFILE = join(PROFILES, '_face2')
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
const probe = (label, re) => ev(`JSON.stringify((()=>{const im=window.__PET_DBG.model.internalModel;const ids=im.getDrawableIDs();const rx=${re};let a=1e9,b=1e9,c=-1,d=-1,n=0,names=[];for(const id of ids){const s=String(id);if(!rx.test(s))continue;const i=im.getDrawableIndex(s);if(i<0)continue;const bb=im.getDrawableBounds(i,{});if(!isFinite(bb.x)||bb.width<=0)continue;a=Math.min(a,bb.x);b=Math.min(b,bb.y);c=Math.max(c,bb.x+bb.width);d=Math.max(d,bb.y+bb.height);n++;if(names.length<10)names.push(s)}return {label:${JSON.stringify(label)},n,names,box:c<0?null:{x:Math.round(a),y:Math.round(b),w:Math.round(c-a),h:Math.round(d-b)}}})())`)
console.log('face only  :', await probe('face', '/^(face|face_m)/i'))
console.log('eyes       :', await probe('eyes', '/eye/i'))
console.log('mouth+nose :', await probe('mouth', '/(mouth|nose|brow|cheek|tear)/i'))
console.log('face+eyes+mouth union:', await probe('union', '/(face_|^face|eye|mouth|nose|brow|cheek)/i'))
console.log('hair       :', await probe('hair', '/hair|zz_/i'))
ws.close(); edge.kill(); process.exit(0)