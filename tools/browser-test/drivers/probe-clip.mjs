import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES } from '../paths.mjs'
const EDGE = browserPath(); const PORT = 9469
const PROFILE = join(PROFILES, '_hit3')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=700,400','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:'file:///D:/HTML/DSH_Pet_Live2d/tools/browser-test/shots/_hit3.html'})
await sleep(1200)
const click=async(x,y,label)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await sleep(120)}
await click(50,50,  'a-inside-1')
await click(100,100,'a-gap')
await click(150,150,'a-inside-2')
await click(270,50, 'b-inside-1')
await click(320,100,'b-gap')
await click(370,150,'b-inside-2')
console.log('probe order: a1,aGap,a2,b1,bGap,b2'); console.log('targets:', await ev('JSON.stringify(window.hits)'))
console.log('path() supported:', await ev("CSS.supports('clip-path', \"path('M0 0H1V1H0Z')\")"))
ws.close(); edge.kill(); process.exit(0)