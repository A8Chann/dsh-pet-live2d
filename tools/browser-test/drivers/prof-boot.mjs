import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, BASE } from '../paths.mjs'
const t0 = Date.now()
const mark = (label) => console.log(String(Date.now() - t0).padStart(6) + 'ms  ' + label)
const EDGE = browserPath(); const PORT = 9551
const PROFILE = join(PROFILES, '_prof')
rmSync(PROFILE, { recursive: true, force: true })
mark('profile dir removed')
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
mark('edge spawned')
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
mark('cdp target available')
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
mark('cdp socket open')
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
mark('domains enabled')
await send('Page.navigate',{url:BASE+'/'})
mark('navigate issued')
for (let i=0;i<240;i++){await sleep(200); if(await ev('document.title')==='done') break}
mark('document.title === done')
await sleep(4000)
mark('after the fixed 4s sleep')
for (let i=0;i<120;i++){ if(await ev('!!(window.__dshLive2dPet && window.__dshLive2dPet.maskInfo().present)')) break; await sleep(150) }
mark('mask actually ready (polled)')
ws.close(); edge.kill()
mark('edge killed')
await sleep(300); process.exit(0)