// Capture source designs and the real Browser view without running Host or user sessions.
import {readFile, writeFile, mkdir, readdir, stat, copyFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), repo=resolve(root,'..');
if(!process.env.REAI_DESIGN_ROOT) throw Error('Set REAI_DESIGN_ROOT to the approved design directory.');
const design=resolve(process.env.REAI_DESIGN_ROOT), out=resolve(process.env.REAI_MOTION_OUTPUT||join(repo,'.artifacts/plugin-previews'));
const main=join(design,'VoiceType_UI_Designs.html'), source=await readFile(main,'utf8');
const hashes={};
for(const name of ['VoiceType_UI_Designs.html','global-task-capsule.html','voice-flow-embed.js']) hashes[name]=createHash('sha256').update(await readFile(join(design,name))).digest('hex');
await mkdir(out,{recursive:true});await mkdir(join(root,'assets/previews'),{recursive:true});
let executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if(!executablePath){
 try{await stat(chromium.executablePath());}catch{
  const cache=join(homedir(),'Library/Caches/ms-playwright');
  for(const name of (await readdir(cache)).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort((a,b)=>+b.split('-').at(-1)-+a.split('-').at(-1))){
   const p=join(cache,name,`chrome-headless-shell-mac-${process.arch==='arm64'?'arm64':'x64'}`,'chrome-headless-shell');
   try{await stat(p);executablePath=p;break;}catch{}
  }
 }
}
const selected=process.argv.find(s=>s.startsWith('--only='))?.slice(7);
const proof=process.argv.includes('--proof');
const browser=await chromium.launch({headless:true,executablePath});
const click=(page,selector)=>page.evaluate(s=>{const node=document.querySelector(s);if(!node)throw Error('Missing original control: '+s);node.click();},selector);
async function browserFixture(){
 const dir=join(out,'browser-fixture');await mkdir(dir,{recursive:true});
 execFileSync('bun',['build',join(root,'scripts/motion/browser-preview.ts'),'--target=browser','--outfile='+join(dir,'preview.js')],{stdio:'pipe'});
 const css=await readFile(join(repo,'plugins/browser/src/browser.css'),'utf8');
 const tokens=[...source.matchAll(/body\.aura\.light\{[^}]+\}/g)].map(m=>m[0]).join('\n');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${tokens}\n${css}\nbody{font-family:-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}*{box-sizing:border-box;scrollbar-width:none}::-webkit-scrollbar{display:none}</style><body class="aura light"><div id="app"></div><script src="preview.js"></script></body></html>`;
 await writeFile(join(dir,'index.html'),html);
 for(const name of ['browser-view.ts','browser-i18n.ts','browser.css'])hashes['plugins/browser/src/'+name]=createHash('sha256').update(await readFile(join(repo,'plugins/browser/src',name))).digest('hex');
 return join(dir,'index.html');
}
async function setup(name){
 const capsule=name==='voice';
 const width=capsule?640:name==='browser'?720:1080,height=capsule?400:name==='browser'?450:640;
 const scale=Math.min(1920/width,1200/height);
 const page=await browser.newPage({viewport:{width:name==='terminal'?1280:width,height:name==='terminal'?1100:900},deviceScaleFactor:scale,colorScheme:'light'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:/,r=>r.abort());await page.clock.install({time:0});
 if(capsule){
  await page.goto(pathToFileURL(join(design,'global-task-capsule.html')).href+'?embed=voice');
  await page.waitForFunction(()=>!!window.voiceCapsuleDemo&&!!document.querySelector('#flowInvoke'));
  // Fix only the outer demonstration viewport; preserve the source's desktop and components.
  await page.addStyleTag({content:`.demo-shell{margin:0}.stage{height:${height}px;min-height:0;flex:none}`});
  if(name==='voice')await page.selectOption('#flowMode','input');
  await page.evaluate(()=>{const e=document.querySelector('#flowEditor');e.setSelectionRange(e.value.length,e.value.length);e.blur();});
 }else if(name==='terminal'){
  await page.goto(pathToFileURL(main).href+'#app/terminal');
  await page.addStyleTag({content:'#kbdSim{display:none!important}'});
  // Public sample replacements only: do not export the designer's machine/account paths.
  await page.evaluate(()=>{
   const walk=document.createTreeWalker(document.querySelector('#pageTerminal'),NodeFilter.SHOW_TEXT);
   while(walk.nextNode())walk.currentNode.textContent=walk.currentNode.textContent.replaceAll('kongkang@Mac-Studio-2','demo@computer').replaceAll('~/Developer/ai-vibe-board/driver-v2','~/Projects/demo/tests').replaceAll('~/Developer/ai-vibe-board','~/Projects/demo').replaceAll('~/Library/Logs/ReAI','~/Projects/demo/logs').replaceAll('ai-vibe-board','demo-project');
  });
 }else{
  await page.goto(pathToFileURL(await browserFixture()).href);
 }
 await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);await page.clock.runFor(1000);
 if(name==='terminal'){
  // Wait for the source route to mount before choosing the native initial preset.
  await click(page,'#terminalLayoutTrigger');await click(page,'[data-terminal-layout=cols]');
  await page.clock.runFor(500);
 }
 const selector=capsule?'#stage':name==='terminal'?'.appwin':'#app';
 const box=await page.locator(selector).boundingBox();
 const clip={x:Math.floor(box.x),y:Math.floor(box.y),width,height};
 // Freeze unrelated infinite decoration. Waveforms/progress are advanced by the capture clock below.
 await page.evaluate(()=>document.getAnimations().forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().iterations===Infinity?0:a.effect.getComputedTiming().endTime;a.__fixedTime=a.currentTime;}));
 await page.clock.pauseAt(10000);
 await page.evaluate(()=>{const now=performance.now();for(const a of document.getAnimations()){a.__captureMark=now;a.pause();a.currentTime=a.__fixedTime??0;}});
 const dir=join(out,name);await mkdir(join(dir,'frames'),{recursive:true});
 await page.screenshot({path:join(dir,'reference.png'),clip});
 await page.evaluate(([selector,clip])=>{
  const radius=getComputedStyle(document.querySelector(selector)).borderRadius;
  const cover=document.createElement('div');cover.id='capture-mask';
  Object.assign(cover.style,{position:'fixed',inset:'0',background:'black',zIndex:'2147483647'});
  const shape=document.createElement('div');
  Object.assign(shape.style,{position:'absolute',left:clip.x+'px',top:(clip.y-scrollY)+'px',width:clip.width+'px',height:clip.height+'px',background:'white',borderRadius:radius});
  cover.append(shape);document.body.append(cover);
 },[selector,clip]);
 await page.screenshot({path:join(dir,'mask.png'),clip});
 await page.evaluate(()=>document.querySelector('#capture-mask').remove());
 return {page,clip,dir,scale,errors};
}
async function act(page,name,frame){
 if(name==='voice'){
  if(frame===48)await click(page,'#flowInvoke');
  if(frame===174)await click(page,'#flowInvoke');
  if(frame===480)await page.evaluate(()=>{
   window.voiceCapsuleDemo.reset();const e=document.querySelector('#flowEditor');e.value='会议安排：';e.setSelectionRange(e.value.length,e.value.length);e.blur();
  });
 }else if(name==='terminal'){
  if(frame===120)await click(page,'[data-terminal-tab=release]');
  if(frame===240)await click(page,'[data-terminal-tab=dev]');
  if(frame===300)await click(page,'#terminalLayoutTrigger');
  if(frame===330)await click(page,'[data-terminal-layout=rows]');
  if(frame===450)await click(page,'#terminalLayoutTrigger');
  if(frame===480)await click(page,'[data-terminal-layout=cols]');
 }else{
  await page.evaluate(frame=>{
   const api=window.previewBrowser;
   if(frame>=120&&frame<240)api.opening((frame-120)*1000/60);
   if(frame===240)api.opened();
   if(frame>=330&&frame<390)api.reading((frame-330)*1000/60);
   if(frame===390)api.selected();
   if(frame===480)api.reset();
  },frame);
 }
}
try{
 for(const name of ['voice','browser','terminal'].filter(n=>!selected||n===selected)){
  const {page,clip,dir,scale,errors}=await setup(name);
  const duration=10, total=duration*60;
  const sampleFrames=new Set([0,60,120,174,240,330,390,480,540,600]);
  const frameRecords=[];
  for(let frame=0;frame<=total+6;frame++){
   const dt=frame?Math.round(frame*1000/60)-Math.round((frame-1)*1000/60):0;
   if(dt)await page.clock.runFor(dt);
   await act(page,name,frame);
   await page.evaluate(name=>{
    const now=performance.now();
    for(const animation of document.getAnimations()){
     animation.__captureMark??=now;animation.pause();
     if(name==='terminal'&&animation.effect.getTiming().iterations===Infinity)animation.__fixedTime=0;
     animation.currentTime=animation.__fixedTime??Math.max(0,now-animation.__captureMark);
    }
   },name);
   if(!proof||sampleFrames.has(frame))await page.screenshot({path:join(dir,'frames',String(frame).padStart(5,'0')+'.png'),clip});
   if(sampleFrames.has(frame))frameRecords.push({frame,state:await page.evaluate(()=>({capsule:document.querySelector('#gcap')?.innerText,dock:document.querySelector('#dock')?.innerText,notification:document.querySelector('#osn')?.className,editor:document.querySelector('#flowEditor')?.value,activeTab:document.querySelector('[data-terminal-tab].active')?.dataset.terminalTab}))});
   if(frame%180===0)console.log(`${name} ${frame}/${total}${proof?' proof':''}`);
  }
  const posterFrame=name==='voice'?174:240;
  await copyFile(join(dir,'frames',String(posterFrame).padStart(5,'0')+'.png'),join(dir,'poster.png'));
  await writeFile(join(dir,'capture.json'),JSON.stringify({name,duration,fps:60,total,clip,deviceScaleFactor:scale,errors,sourceSha256:hashes,frameRecords,adaptations:name==='terminal'?['Public sample account and paths replace private designer labels']:name==='browser'?['Real plugin DOM with public sample tab state; original design theme tokens']:['Original embedded desktop demo in a fixed capture viewport; native event simulation']},null,2)+'\n');
  await page.close();
  if(errors.length)throw Error(errors.join('\n'));
  for(const [name,expected] of Object.entries(hashes)){
   const path=name.startsWith('plugins/')?join(repo,name):join(design,name);
   if(createHash('sha256').update(await readFile(path)).digest('hex')!==expected)throw Error('Source changed during capture: '+name);
  }
  if(!proof){
   execFileSync('python3',[join(root,'scripts/verify-plugin-previews.py'),dir],{stdio:'inherit'});
   execFileSync('ffmpeg',['-y','-v','warning','-framerate','60','-i',join(dir,'frames/%05d.png'),'-frames:v',String(total),'-vf','scale=1920:1200:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1200:(ow-iw)/2:(oh-ih)/2:color=0xfafbf8','-c:v','libx264','-preset','slow','-crf','15','-pix_fmt','yuv420p','-movflags','+faststart',join(dir,name+'.mp4')],{stdio:'inherit'});
   await copyFile(join(dir,name+'.mp4'),join(root,'assets/previews',name+'.mp4'));
   await copyFile(join(dir,'poster.png'),join(root,'assets/previews',name+'.png'));
  }
 }
}finally{await browser.close();}
