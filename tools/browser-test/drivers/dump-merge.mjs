import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPath, PROFILES, SHOTS, BASE } from '../paths.mjs'
import { waitReady } from '../ready.mjs'
const EDGE = browserPath(); const PORT = 9561
const PROFILE = join(PROFILES, '_merge2')
rmSync(PROFILE, { recursive: true, force: true })
const edge = spawn(EDGE, ['--headless=new','--remote-debugging-port='+PORT,'--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check','--disable-extensions','--user-data-dir='+PROFILE,'--window-size=1280,860','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let page; for (let i=0;i<120&&page===undefined;i++){try{page=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(t=>t.type==='page')}catch{} if(page===undefined)await sleep(250)}
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
let nextId=0;const pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id!==undefined){const s=pending.get(m.id);if(s){pending.delete(m.id);s(m)}}}
const send=(a,p={})=>new Promise(r=>{const id=++nextId;pending.set(id,r);ws.send(JSON.stringify({id,method:a,params:p}))})
const ev=async(e)=>{const m=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)return 'EXC: '+String(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text).slice(0,200);return m.result?.result?.value}
await send('Runtime.enable');await send('Page.enable')
await send('Page.navigate',{url:BASE+'/'})
for (let i=0;i<240;i++){await sleep(400); if(await ev('document.title')==='done') break}
await waitReady(ev)
const rect = JSON.parse(await ev('(()=>{const r=document.querySelector("[data-dsh-live2d-pet] [data-stage]").getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)})})()'))
const shots = []
const shot = async (label, names) => {
  await ev('window.__dshLive2dPet.setExpressions(' + JSON.stringify(names) + ')')
  await sleep(1800)
  await ev('window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = function(){ return 0 }')
  await sleep(350)
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })
  shots.push({ label, data: s.result.data })
  await ev('window.requestAnimationFrame = window.__raf')
  await sleep(300)
}
await shot('baseline', [])
await shot('眼镜', ['圆眼镜'])
await shot('贴纸', ['猫猫贴纸'])
await shot('桌布', ['深色桌布'])
await shot('眼镜+贴纸', ['圆眼镜','猫猫贴纸'])
await shot('眼镜+贴纸+桌布', ['圆眼镜','猫猫贴纸','深色桌布'])
await shot('三个+手部', ['圆眼镜','猫猫贴纸','深色桌布','喵喵手'])
await shot('清空', [])
writeFileSync(join(SHOTS, '_sheet.json'), JSON.stringify({ rect, shots }))
console.log('defs:', await ev('window.__dshLive2dPet ? "n/a" : "n/a"'))
console.log('cells: ' + shots.map(s => s.label).join(' | '))
ws.close(); edge.kill(); await sleep(300); process.exit(0)