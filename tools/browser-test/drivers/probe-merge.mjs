import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9533
const PROFILE = join(PROFILES, '_merge')
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
const rect = JSON.parse(await ev('(()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)})})()'))
// Register a SYNTHETIC merged expression (glasses + cat paws) as a blob URL and
// ask the engine to play it. If this works, true multi-slot layering is possible.
const merge = `(function(){
  var m = window.__PET_DBG.model;
  var mgr = m.internalModel.motionManager.expressionManager;
  var json = JSON.stringify({ Type: 'Live2D Expression', FadeInTime: 0.2, FadeOutTime: 0.2, Parameters: [
    { Id: 'ParamCheek70', Value: 1, Blend: 'Add' },
    { Id: 'maoshou', Value: 1, Blend: 'Add' }
  ] });
  var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  var name = '__merge_test';
  var at = mgr.getExpressionIndex(name);
  if (at < 0) { mgr.definitions.push({ Name: name, File: url }); at = mgr.definitions.length - 1; }
  window.__mergeUrl = url; window.__mergeAt = at;
  return m.expression(name).then(function(r){ window.__mergeRet = String(r); return String(r) })
})()`
const shot = async (label, settle) => {
  await sleep(settle)
  await ev('window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = function(){ return 0 }')
  await sleep(350)
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
  await ev('window.requestAnimationFrame = window.__raf')
  await sleep(250)
  return { label, data: s.result.data }
}
const shots = []
shots.push(await shot('baseline', 800))
await ev('window.__dshLive2dPet.setExpressions([])')
console.log('merge call -> ' + await ev(merge))
await sleep(2500)
console.log('merge ret: ' + await ev('String(window.__mergeRet)') + '  defs=' + await ev('window.__PET_DBG.model.internalModel.motionManager.expressionManager.definitions.length'))
shots.push(await shot('merged glasses+paws', 500))
writeFileSync(join(SHOTS, '_sheet.json'), JSON.stringify({ rect, shots }))
console.log('cells: ' + shots.map(s => s.label).join(' | '))
ws.close(); edge.kill(); await sleep(300); process.exit(0)