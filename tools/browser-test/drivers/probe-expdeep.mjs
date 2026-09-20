import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9515
const PROFILE = join(PROFILES, '_expdeep')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC: '+String(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text).slice(0,160);return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/?variant=DBG'})
for (let i=0;i<240;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(4000)
const SNAP = "JSON.stringify((function(){\n  var em = window.__PET_DBG.model.internalModel.motionManager.expressionManager;\n  var ce = em.currentExpression;\n  var p = window.__PET_DBG.core._model.parameters;\n  var a = Array.from(p.ids);\n  var out = { has: !!ce, pc16: p.values[a.indexOf('ParamCheek16')] };\n  if (ce) { out.n = (ce._parameters || []).length; out.w = ce._fadeWeight; if (ce._parameters && ce._parameters[0]) { out.first = String(ce._parameters[0].parameterId); } }\n  return out;\n})())"
console.log('before: ' + await ev(SNAP))
await ev('window.__dshLive2dPet.setExpressions(["星星眼"])')
for (let i = 0; i < 8; i++) { await sleep(400); console.log('  t=' + (i*400) + 'ms  ' + await ev(SNAP)) }
ws.close(); edge.kill(); await sleep(300); process.exit(0)