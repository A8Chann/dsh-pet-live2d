import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9511
const PROFILE = join(PROFILES, '_expnet')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();const net=[]
ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}return}
  if(m.method==='Network.responseReceived'){const u=m.params.response.url;if(/\.exp3\.json/.test(u))net.push(m.params.response.status+' '+u.replace(/^https?:\/\/[^/]+/,''))}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC: '+String(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text).slice(0,160);return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable'); await send('Network.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const q = async (l, e) => console.log(l.padEnd(38) + await ev(e))
await q('exp3 requests seen', 'String(' + JSON.stringify(net.length) + ')')
await q('model3.json expr paths', 'JSON.stringify((window.__PET_DBG.model.internalModel.motionManager.settings.expressions||[]).slice(0,3))')
// Set an expression and inspect what got loaded.
await q('set via manager', 'JSON.stringify((()=>{const em=window.__PET_DBG.model.internalModel.motionManager.expressionManager;em.setExpression("星星眼");return "ok"})())')
await sleep(1500)
await q('currentExpression keys', 'JSON.stringify(Object.keys(window.__PET_DBG.model.internalModel.motionManager.expressionManager.currentExpression||{}))')
await q('currentExpression params len', 'JSON.stringify((window.__PET_DBG.model.internalModel.motionManager.expressionManager.currentExpression?.parameters||[]).length)')
await q('first param', 'JSON.stringify((window.__PET_DBG.model.internalModel.motionManager.expressionManager.currentExpression?.parameters||[])[0]||null)')
await q('ParamCheek16', '(()=>{const p=window.__PET_DBG.core._model.parameters;const a=Array.from(p.ids);return p.values[a.indexOf("ParamCheek16")]})()')
console.log('exp3 network:'); for (const n of net.slice(0,6)) console.log('   '+n)
ws.close(); edge.kill(); await sleep(300); process.exit(0)