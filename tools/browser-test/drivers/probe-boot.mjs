import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9541
const PROFILE = join(PROFILES, '_boot')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();const logs=[]
ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}return}
  if(m.method==='Runtime.consoleAPICalled')logs.push('['+m.params.type+'] '+(m.params.args||[]).map(a=>String(a.value??a.description??'')).join(' ').slice(0,240))
  if(m.method==='Runtime.exceptionThrown')logs.push('[EXC] '+String(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text).slice(0,400))}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/'})
for (let i=0;i<60;i++){await sleep(500); if(await ev('document.title')==='done') break}
await sleep(5000)
console.log('title: ' + await ev('document.title'))
console.log('petApi: ' + await ev('typeof window.__dshLive2dPet'))
console.log('petRoot: ' + await ev('document.querySelectorAll("[data-dsh-live2d-pet]").length'))
console.log('bodyChildren: ' + await ev('JSON.stringify(Array.from(document.querySelectorAll("#root > *")).map(e=>e.tagName+"["+Array.from(e.attributes).map(a=>a.name).join(",")+"]"))'))
console.log('rootHTML: ' + await ev('(document.getElementById("root")||{}).innerHTML?.slice(0,300)'))
console.log('logs:'); for (const l of logs.slice(-20)) console.log('  '+l)
ws.close(); edge.kill(); await sleep(300); process.exit(0)