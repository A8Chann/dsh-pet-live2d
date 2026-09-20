import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9471
const PROFILE = join(PROFILES, '_hit4')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=700,400','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:'file:///D:/HTML/DSH_Pet_Live2d/tools/browser-test/shots/_hit4.html'})
await sleep(1200)
const click=async(x,y)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await sleep(120)}
await click(50,50)    // inside proxy clip -> proxy
await click(100,100)  // gap -> page
await click(150,150)  // inside proxy clip -> proxy
await click(250,50)   // outside root -> page
console.log('expect proxy,page,proxy,page'); console.log('targets:', await ev('JSON.stringify(window.hits)'))
// elementFromPoint check too
console.log('efp(50,50):', await ev('(document.elementFromPoint(50,50)||{}).id'))
console.log('efp(100,100):', await ev('(document.elementFromPoint(100,100)||{}).id'))
ws.close(); edge.kill(); process.exit(0)