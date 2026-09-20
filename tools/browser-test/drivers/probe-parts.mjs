import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9527
const PROFILE = join(PROFILES, '_parts')
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
const S = "JSON.stringify((function(){\n  var c = window.__PET_DBG.core;\n  var p = c._model.parameters; var pa = Array.from(p.ids);\n  var parts = c._model.parts; var ids = Array.from(parts.ids);\n  var op = Array.from(parts.opacities);\n  var out = { pc70: p.values[pa.indexOf('ParamCheek70')], glasses: null, maoshou: p.values[pa.indexOf('maoshou')] };\n  var gi = ids.indexOf('Part');\n  if (gi >= 0) out.glasses = Number(op[gi].toFixed(3));\n  // Any part whose opacity is non-1 is a switch candidate.\n  var odd = []; for (var i = 0; i < ids.length; i++) { if (Math.abs(op[i] - 1) > 0.01) odd.push(ids[i] + '=' + op[i].toFixed(2)); }\n  out.nonOpaque = odd.slice(0, 12);\n  out.partCount = ids.length;\n  return out;\n})())"
console.log('baseline : ' + await ev(S))
await ev('window.__dshLive2dPet.setExpressions(["圆眼镜"])')
await sleep(1200)
console.log('+圆眼镜  : ' + await ev(S))
await ev('window.__dshLive2dPet.setExpressions(["喵喵手"])')
await sleep(1200)
console.log('+喵喵手  : ' + await ev(S))
ws.close(); edge.kill(); await sleep(300); process.exit(0)