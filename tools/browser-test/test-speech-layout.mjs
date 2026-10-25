// 直接执行客户端真实的布局 effect；这里只替换 DOM 和 React 生命周期，不复制布局算法。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../../dsh-live2d-pet/lib/client.js', import.meta.url),'utf8');
const start = source.indexOf('    // 一句话只采一次头部锚点');
const end = source.indexOf('    // The controller owns the motion lifecycle', start);
assert.ok(start > 0 && end > start);
let effect, cleanup, samples = 0;
let rect = {left:900,top:450,width:300,height:300};
const listeners = new Map();
const el = {style:{},dataset:{},hasAttribute(name){return name === 'data-placed' && 'placed' in this.dataset},getBoundingClientRect(){return {width:140,height:56}}};
const context = {DEFAULT_SIZE:300,bubble:'让我想想',size:300,pos:{},ready:true,settingsRev:0,yieldToOther:false,
 speechLayoutRef:{current:null},rootRef:{current:{querySelector(){return el},getBoundingClientRect(){return rect}}},
 motion:{current:{headBox(){samples++;return {minX:0,maxX:300,minY:0,maxY:300}},modelToStage(x,y){return {x,y}}}},
 TUNING:{bubbleOffsetX:0,bubbleOffsetY:0},
 window:{innerWidth:1280,innerHeight:800,addEventListener(k,f){listeners.set(k,f)},removeEventListener(k){listeners.delete(k)}},
 ResizeObserver:class {observe(){} disconnect(){}},useEffect(f){effect=f}};
vm.createContext(context);
const helper = source.match(/  function speechScale\(size\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(helper, '尺寸函数存在'); vm.runInContext(helper,context);
const render=()=>{cleanup?.();vm.runInContext(source.slice(start,end),context);cleanup=effect()};
render();
assert.equal(samples,1);assert.equal(el.dataset.side,'left');
assert.ok(parseFloat(el.style.left)+140 < rect.left+36,'气泡主体在头部外侧');
assert.equal(el.style.transition,'none','首次出现不从屏幕中心滑入');
const initial={...el.style};
listeners.get('resize')();
assert.equal(samples,1,'一句话期间不再读取动作几何');
assert.equal(el.style.left,initial.left);assert.equal(el.style.top,initial.top);
rect={...rect,left:700};render();
assert.equal(samples,1,'拖动保留同一句话的锚点');
assert.equal(parseFloat(el.style.left),parseFloat(initial.left)-200,'拖动使用新的视口坐标');
assert.equal(el.style.transition,'','后续移动交由 CSS 缓动');
assert.equal(el.dataset.side,'left','经过屏幕中心仍保持原侧');
rect={...rect,left:0};render();
assert.equal(el.dataset.side,'right','原侧不足时换到有空间的一侧');
assert.ok(parseFloat(el.style.left)>=12);
context.bubble='完成啦';render();assert.equal(samples,2,'新一句话重新确定锚点');
context.bubble=null;render();assert.equal(context.speechLayoutRef.current,null,'气泡消失后清理锚点');
assert.equal(listeners.size,0,'卸载时清理监听器');
const beforeYield = samples;
context.bubble='让位也不画';context.yieldToOther=true;render();
assert.equal(samples,beforeYield,'让位的那一份不采锚点');
assert.equal(context.speechLayoutRef.current,null,'让位时清掉锚点');
assert.equal(listeners.size,0,'让位时不挂监听器');
assert.ok(source.includes('prefers-reduced-motion:reduce'));
console.log('PASS 外侧定位、首次出现、锚点稳定、拖动跟随、方向稳定、边缘换边、新句重置与监听器清理');

const sizes = [160,240,300,360,420,760];
const scales = sizes.map(size => context.speechScale(size));
assert.equal(scales[0]*14,12); assert.equal(scales[2],1); assert.equal(scales.at(-1),1.4);
assert.ok(scales.every((x,i)=>x>=12/14 && x<=1.4 && (i===0 || x>=scales[i-1])));
console.log('PASS 尺寸缩放单调、默认比例与可读上下限')
