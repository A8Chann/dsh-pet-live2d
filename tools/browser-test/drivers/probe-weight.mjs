import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9521
const PROFILE = join(PROFILES, '_weight')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC: '+String(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text).slice(0,200);return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const S = "JSON.stringify((function(){\n  var em = window.__PET_DBG.model.internalModel.motionManager.expressionManager;\n  var ce = em.currentExpression;\n  if (!ce) return { none: true };\n  return { w: ce._weight, fadeIn: ce._fadeInSeconds, fadeOut: ce._fadeOutSeconds, params: (ce._parameters && ce._parameters.getSize) ? ce._parameters.getSize() : 'n/a', started: ce.isStarted ? ce.isStarted() : null };\n})())"
console.log('before: ' + await ev(S))
await ev('window.__dshLive2dPet.setExpressions(["圆眼镜"])')
for (let i=0;i<6;i++){ await sleep(600); console.log('  t=' + (i*600) + 'ms  ' + await ev(S)) }
// Force the weight and see whether the glasses appear.
await ev('(function(){var ce=window.__PET_DBG.model.internalModel.motionManager.expressionManager.currentExpression; if(ce){ce._weight=1; ce._fadeInSeconds=0; ce._fadeOutSeconds=0;} return true})()')
await sleep(1200)
console.log('after forcing weight: ' + await ev(S))
ws.close(); edge.kill(); await sleep(300); process.exit(0)