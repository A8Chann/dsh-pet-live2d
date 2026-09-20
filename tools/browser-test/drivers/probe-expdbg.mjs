import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9503
const PROFILE = join(PROFILES, '_expdbg')
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
const q = async (l, e) => console.log(l.padEnd(34) + await ev(e))
await q('typeof setExpressions', 'typeof window.__dshLive2dPet.setExpressions')
await q('model.expressions defs', 'window.__PET_DBG.model.internalModel.expressionManager.definitions.length')
await q('getExpressionIndex(喵喵手)', 'window.__PET_DBG.model.internalModel.expressionManager.getExpressionIndex("喵喵手")')
await q('expression() return', 'String(await window.__PET_DBG.model.expression("喵喵手"))')
await sleep(1200)
await q('maoshou after model.expression', '(()=>{const p=window.__PET_DBG.core._model.parameters;const a=Array.from(p.ids);return p.values[a.indexOf("maoshou")]})()')
await q('currentExpression idx', 'window.__PET_DBG.model.internalModel.expressionManager.currentExpression ? 1 : 0')
await q('--- now via setExpressions ---', '""')
await ev('window.__dshLive2dPet.setExpressions(["喵喵手","星星眼"])')
await sleep(200)
await q('pinned after setExpressions', 'JSON.stringify(window.__dshLive2dPet.expressions())')
await sleep(1500)
await q('maoshou', '(()=>{const p=window.__PET_DBG.core._model.parameters;const a=Array.from(p.ids);return p.values[a.indexOf("maoshou")]})()')
await q('ParamCheek16', '(()=>{const p=window.__PET_DBG.core._model.parameters;const a=Array.from(p.ids);return p.values[a.indexOf("ParamCheek16")]})()')
ws.close(); edge.kill(); await sleep(300); process.exit(0)