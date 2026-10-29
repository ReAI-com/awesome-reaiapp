// Render the approved HTML design directly. No product UI is redrawn here.
import {readFile,writeFile,mkdir,stat,readdir,copyFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const designRoot=process.env.REAI_DESIGN_ROOT;
if(!designRoot) throw new Error('Set REAI_DESIGN_ROOT to the approved ai-vibe-board/design directory.');
const source=resolve(designRoot,'VoiceType_UI_Designs.html');
const sourceBytes=await readFile(source);
const out=resolve(process.env.REAI_MOTION_OUTPUT || join(root,'../.artifacts/hero-motion'));
await mkdir(join(out,'frames'),{recursive:true});
let executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if(!executablePath){
 try{await stat(chromium.executablePath());}
 catch{
  if(process.platform==='darwin'){
   const cache=join(homedir(),'Library/Caches/ms-playwright');
   const versions=(await readdir(cache)).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort((a,b)=>+b.split('-').at(-1)-+a.split('-').at(-1));
   for(const version of versions){
    const path=join(cache,version,`chrome-headless-shell-mac-${process.arch==='arm64'?'arm64':'x64'}`,'chrome-headless-shell');
    try{await stat(path);executablePath=path;break;}catch{}
   }
  }
 }
}
const browser=await chromium.launch({headless:true,executablePath});
try{
 const scale=1920/1080;
 const page=await browser.newPage({viewport:{width:1280,height:1100},deviceScaleFactor:scale});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // No access to user accounts, audio or application profiles. The original is an offline prototype.
 await page.route(/^https?:/,route=>route.abort());
 await page.clock.install({time:0});
 await page.goto(pathToFileURL(source).href+'#app/voice');
 await page.evaluate(()=>document.fonts.ready);
 // Hide only the reviewer's keyboard toolbar, which otherwise overlaps the app crop.
 await page.addStyleTag({content:'#kbdSim{display:none!important}'});
 await page.locator('#taskTabs [data-filter=input]').click();
 const row=page.locator('.task-item').filter({hasText:'下周的设计评审会议改到周四下午三点'});
 await row.click();
 await page.mouse.move(0,0);
 await page.clock.runFor(1000);
 await page.evaluate(()=>document.getAnimations().filter(a=>a.effect.getTiming().iterations===Infinity).forEach(a=>{a.pause();a.currentTime=0;}));
 const box=await page.locator('.appwin').boundingBox();
 const clip={x:Math.floor(box.x),y:Math.floor(box.y),width:1080,height:640};
 await page.screenshot({path:join(out,'reference.png'),clip});
 await page.screenshot({path:join(out,'still.png'),clip});
 await copyFile(join(out,'still.png'),join(root,'assets/hero-poster.png'));
 const rectangles=await page.evaluate(()=>{
  const frame=document.querySelector('.appwin').getBoundingClientRect();
  return ['.titlebar-breadcrumb','.sidebar > .sb-brand','.sidebar > .sb-nav','.sidebar > #sbDevice','.sidebar > #sbFooter','#inputDetail'].map(selector=>{
   const node=document.querySelector(selector),box=node.getBoundingClientRect();
   return {x:box.x-frame.x,y:box.y-frame.y,width:box.width,height:box.height,radius:0};
  });
 });
 // App surfaces stay fixed. Animate original DOM content, preserving its final design.
 await page.evaluate(()=>{
  const selectors=['.titlebar-breadcrumb','.sidebar > .sb-brand','.sidebar > .sb-nav','.sidebar > #sbDevice','.sidebar > #sbFooter','#inputDetail'];
  const nodes=selectors.map(selector=>document.querySelector(selector));
  const intro=nodes.map((node,index)=>{
   const a=node.animate([{opacity:0,transform:'translateY(10px)',filter:'blur(4px)'},{opacity:1,transform:'none',filter:'blur(0px)'}],{duration:900,delay:index*85,fill:'both',easing:'cubic-bezier(.16,1,.3,1)'});
   a.pause();return a;
  });
  const fade=nodes.map(node=>{
   const a=node.animate([{opacity:1},{opacity:0}],{duration:800,fill:'both',easing:'cubic-bezier(.65,0,.35,1)'});
   a.cancel();return a;
  });
  window.__seek=t=>{
   const time=((t%12)+12)%12;
   intro.forEach(a=>{if(time>=1.5&&time<11.3)a.cancel();else{a.pause();a.currentTime=time>=11.3?0:time*1000;}});
   fade.forEach(a=>{
    if(time>=10.5&&time<11.3){a.pause();a.currentTime=(time-10.5)*1000;}
    else a.cancel();
   });
  };
 });
 await page.clock.pauseAt(10000);
 const count=process.argv.includes('--proof')?1:731;
 const times=[];
 for(let frame=0;frame<count;frame++){
  const milliseconds=Math.round(frame*1000/60),dt=frame?milliseconds-Math.round((frame-1)*1000/60):0;
  if(dt)await page.clock.runFor(dt);
  await page.evaluate(([frame,time])=>{
   if(frame===144)document.querySelector('#inputPlay [data-ipl]').click();
   if(frame===480){const slider=document.querySelector('#inputPlay input[type=range]');slider.value='0';slider.dispatchEvent(new Event('input',{bubbles:true}));}
   window.__seek(time);
  },[frame,milliseconds/1000]);
  times.push(milliseconds/1000);
  await page.screenshot({path:join(out,'frames',String(frame).padStart(5,'0')+'.png'),clip});
  if(frame%120===0)console.log(`Captured official design ${frame}/${count-1}`);
 }
 await writeFile(join(out,'capture.json'),JSON.stringify({duration:12,fps:60,width:1920,height:1138,deviceScaleFactor:scale,geometry:rectangles,times,errors,reference:'Direct render of approved VoiceType_UI_Designs.html; original playback control and demo data',sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')},null,2)+'\n');
 if(errors.length)throw new Error(errors.join('\n'));
 if(!process.argv.includes('--proof')){
  execFileSync('python3',[join(root,'scripts/verify-motion-export.py'),out],{stdio:'inherit'});
  const input=['-y','-v','warning','-framerate','60','-i',join(out,'frames/%05d.png')];
  execFileSync('ffmpeg',[...input,'-frames:v','720','-vf','crop=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-preset','slow','-crf','15','-pix_fmt','yuv420p','-movflags','+faststart',join(out,'reai-home-hero.mp4')],{stdio:'inherit'});
  execFileSync('ffmpeg',[...input,'-filter_complex','trim=end_frame=720,fps=20,scale=800:500:force_original_aspect_ratio=decrease:flags=lanczos,pad=800:500:(ow-iw)/2:(oh-ih)/2:color=0xfafbf8,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle','-loop','0',join(out,'reai-home-hero.gif')],{stdio:'inherit'});
  await copyFile(join(out,'reai-home-hero.mp4'),join(root,'assets/hero-motion.mp4'));
 }
 console.log(`Official hero export: ${out}`);
}finally{await browser.close();}
