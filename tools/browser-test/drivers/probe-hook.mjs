import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9525
const PROFILE = join(PROFILES, '_hook')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC: '+String(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text).slice(0,220);return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const q = async (l,e) => console.log(l.padEnd(32) + await ev(e))
// Is the controller's wrapper on the live core's update?
await q('core.update source head', 'window.__PET_DBG.core.update.toString().slice(0,90)')
// Count calls and sample the value inside the frame.
await ev('(function(){var c=window.__PET_DBG.core; window.__upd=0; window.__seen=[]; var prev=c.update; c.update=function(){ window.__upd++; var r=prev.apply(this,arguments); var p=c._model.parameters; var a=Array.from(p.ids); window.__seen.push(Number(p.values[a.indexOf("ParamCheek70")].toFixed(2))); return r; }; return true})()')
await sleep(600)
await q('update calls in 600ms', 'window.__upd')
await q('seen values', 'JSON.stringify(window.__seen.slice(0,6))')
await ev('window.__dshLive2dPet.setExpressions(["圆眼镜"])')
await sleep(1500)
await q('layerCount', 'window.__dshLive2dPet.expressionLayerCount()')
await q('update calls after', 'window.__upd')
await q('seen values after', 'JSON.stringify(window.__seen.slice(-6))')
ws.close(); edge.kill(); await sleep(300); process.exit(0)