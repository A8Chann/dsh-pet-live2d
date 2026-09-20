import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9507
const PROFILE = join(PROFILES, '_imkeys')
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
const q = async (l, e) => console.log(l.padEnd(28) + await ev(e))
await q('internalModel own keys', 'JSON.stringify(Object.keys(window.__PET_DBG.model.internalModel))')
await q('internalModel proto', 'JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(window.__PET_DBG.model.internalModel)))')
await q('has expressionManager?', 'String("expressionManager" in window.__PET_DBG.model.internalModel)')
await q('settings expressions', 'JSON.stringify((window.__PET_DBG.model.internalModel.settings?.expressions||[]).length)')
// Does model.expression(name) resolve at all?
await q('expression(星星眼) ret', 'String(await window.__PET_DBG.model.expression("星星眼"))')
await q('ParamCheek16 now', '(()=>{const p=window.__PET_DBG.core._model.parameters;const a=Array.from(p.ids);return p.values[a.indexOf("ParamCheek16")]})()')
ws.close(); edge.kill(); await sleep(300); process.exit(0)