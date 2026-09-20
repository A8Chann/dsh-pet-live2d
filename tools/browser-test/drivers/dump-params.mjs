import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9497
const PROFILE = join(PROFILES, '_params')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const out = await ev(`(()=>{const p=window.__PET_DBG.core._model.parameters;const ids=Array.from(p.ids);const min=p.minimumValues,max=p.maximumValues,def=p.defaultValues,cur=p.values;const want=['point','danbaofan','phone','phone7','maoshou','bi','pi','chehui','pointZ','mozhua','mozhua2','cc2','jingyu','fangzhuoshang','baleite','ParamCheek38','fx1','shouji','ParamCheek70','ParamCheek71','ParamCheek72','ParamCheek10','ParamCheek81','ParamCheek82','ParamCheek83','ParamCheek15','ParamCheek16','ParamCheek17','ParamCheek20','ParamCheek22','ParamCheek27','ParamCheek76','ParamCheek77','ParamCheek80','ParamCheek21','ParamCheek18','Paramhh3','Paramhh2','ParamCheek74','ParamCheek19','ParamCheek75','ParamCheek26','ParamCheek73','love','pengshui','ji'];const rows=[];for(const id of want){const i=ids.indexOf(id);rows.push(i<0?{id,missing:true}:{id,min:min[i],max:max[i],def:def[i],cur:cur[i]})}return JSON.stringify(rows)})()`)
for (const r of JSON.parse(out)) {
  if (r.missing) { console.log(r.id.padEnd(16) + '  MISSING'); continue }
  console.log(r.id.padEnd(16) + ' min=' + String(r.min).padStart(4) + ' max=' + String(r.max).padStart(4) + ' def=' + String(r.def).padStart(4) + ' cur=' + Number(r.cur).toFixed(2))
}
ws.close(); edge.kill(); await sleep(300); process.exit(0)