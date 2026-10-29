import {t, localeFromPath, localizedPath} from '/i18n.js';
import {previews, previewAsset} from '/home-previews.js';

const home=document.querySelector('.home');
if(home){
  const locale=localeFromPath(location.pathname),text=key=>t(key,{},locale);
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const still=new URLSearchParams(location.search).has('still');
  const reduce=()=>media.matches||still;
  home.dataset.enhanced='';
  const menu=document.querySelector('#mobile-menu'),menuToggle=document.querySelector('.menu-toggle');
  menuToggle.addEventListener('click',()=>{menu.showModal();home.classList.add('menu-open');menuToggle.setAttribute('aria-expanded','true');});
  menu.querySelector('.menu-close').addEventListener('click',()=>menu.close());
  menu.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>menu.close()));
  menu.addEventListener('close',()=>{home.classList.remove('menu-open');menuToggle.setAttribute('aria-expanded','false');});
  matchMedia('(min-width: 801px)').addEventListener('change',event=>{if(event.matches&&menu.open)menu.close();});

  if('IntersectionObserver' in window){
    const reveals=[...document.querySelectorAll('[data-reveal]')],words=[...document.querySelectorAll('[data-tagline] h2 span')];
    if(!reduce()){reveals.forEach(n=>{n.dataset.armed='';});document.querySelector('[data-tagline]').dataset.armed='';}
    const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver.unobserve(entry.target);}
    }),{threshold:.12});
    reveals.forEach(n=>revealObserver.observe(n));
    const wordObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(!entry.isIntersecting)return;
      entry.target.style.transitionDelay=`${words.indexOf(entry.target)*85}ms`;entry.target.classList.add('word-visible');wordObserver.unobserve(entry.target);
    }),{rootMargin:'0px 0px -18% 0px',threshold:1});
    words.forEach(n=>wordObserver.observe(n));
    media.addEventListener('change',()=>{if(reduce()){reveals.forEach(n=>delete n.dataset.armed);delete document.querySelector('[data-tagline]').dataset.armed;}});
  }

  const panel=document.querySelector('#preview-panel');
  if(panel){
    const tabs=[...document.querySelectorAll('[data-preview]')],video=document.querySelector('#hero-video'),poster=document.querySelector('#hero-still');
    const pauseButton=document.querySelector('.motion-toggle'),replayButton=document.querySelector('.preview-replay'),status=document.querySelector('#preview-media-status');
    const version=panel.dataset.previewVersion,stepNodes=[...document.querySelectorAll('[data-preview-step]')];
    const available=previews.filter(p=>tabs.some(tab=>tab.dataset.preview===p.id));
    let active=available.find(p=>p.id===panel.dataset.activePreview)||available[0];
    let paused=false,failed=false,loaded=null,generation=0,lastStep=-1;
    const box=video.parentElement.getBoundingClientRect();
    let visible=box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;
    function drawStep(){
      const time=video.currentTime||0;
      const step=reduce()?active.beats.length-1:active.beats.reduce((result,start,index)=>time>=start?index:result,0);
      if(step===lastStep)return;lastStep=step;
      stepNodes.forEach((node,i)=>{if(i===step)node.parentElement.setAttribute('aria-current','step');else node.parentElement.removeAttribute('aria-current');});
    }
    function labels(){
      pauseButton.disabled=reduce()||failed;replayButton.disabled=reduce();
      pauseButton.setAttribute('aria-pressed',String(paused));
      pauseButton.textContent=text(reduce()?'home.motionReduced':paused?'home.motionResume':'home.motionPause');
      video.hidden=reduce()||failed;
      poster.hidden=!video.hidden&&video.readyState>=2&&loaded===active.id;
      drawStep();
    }
    async function synchronizePlayback(){
      labels();
      if(reduce()||paused||failed||!visible||document.hidden){video.pause();return;}
      if(loaded!==active.id){loaded=active.id;video.src=previewAsset(active,'mp4',version);video.load();}
      const token=generation;
      try{await video.play();}
      catch(error){if(token===generation&&error.name==='NotAllowedError'){paused=true;labels();}}
    }
    function select(id,{updateUrl=false,focus=false}={}){
      const next=available.find(p=>p.id===id);if(!next)return;
      generation++;video.pause();video.removeAttribute('src');video.load();
      active=next;loaded=null;failed=false;lastStep=-1;status.textContent='';
      panel.dataset.activePreview=active.id;panel.setAttribute('aria-labelledby',`preview-tab-${active.id}`);
      tabs.forEach(tab=>{const selected=tab.dataset.preview===active.id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();});
      document.querySelector('#preview-title-first').textContent=text(active.key+'.title1');
      document.querySelector('#preview-title-second').textContent=text(active.key+'.title2');
      document.querySelector('#preview-intro').textContent=text(active.key+'.intro');
      document.querySelector('#preview-source').textContent=text(active.key+'.source');
      document.querySelector('#preview-link').href=localizedPath(`/apps/${active.appId}/`,locale);
      stepNodes.forEach((node,i)=>{const item=node.parentElement,within=i<(active.steps||3);item.hidden=!within;if(within)node.textContent=text(active.key+'.step'+i);});
      poster.src=previewAsset(active,'png',version);poster.alt=text(active.key+'.alt');
      video.poster=poster.src;video.setAttribute('aria-label',poster.alt);
      if(updateUrl){
        const url=new URL(location.href);url.searchParams.set('plugin',active.id);history.replaceState(history.state,'',url);
        document.querySelectorAll('[data-language-switch]').forEach(link=>{link.href=localizedPath(url.pathname+url.search+url.hash,link.dataset.languageSwitch);});
      }
      synchronizePlayback();
    }
    tabs.forEach((tab,index)=>{
      tab.addEventListener('click',()=>{if(tab.dataset.preview!==active.id)select(tab.dataset.preview,{updateUrl:true});});
      tab.addEventListener('keydown',event=>{
        let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;
        event.preventDefault();select(tabs[next].dataset.preview,{updateUrl:true,focus:true});
      });
    });
    pauseButton.addEventListener('click',()=>{paused=!paused;synchronizePlayback();});
    replayButton.addEventListener('click',()=>{paused=false;if(failed){loaded=null;failed=false;status.textContent='';}video.currentTime=0;synchronizePlayback();});
    video.addEventListener('loadeddata',labels);video.addEventListener('playing',labels);video.addEventListener('timeupdate',drawStep);
    video.addEventListener('error',()=>{if(!video.getAttribute('src')||!video.error)return;failed=true;status.textContent=text('home.preview.unavailable');labels();});
    media.addEventListener('change',synchronizePlayback);
    document.addEventListener('visibilitychange',synchronizePlayback);
    window.addEventListener('pagehide',()=>video.pause());window.addEventListener('pageshow',synchronizePlayback);
    if('IntersectionObserver' in window)new IntersectionObserver(entries=>{visible=entries[0].intersectionRatio>=.3;synchronizePlayback();},{threshold:[0,.3]}).observe(video.parentElement);
    const requested=new URLSearchParams(location.search).get('plugin');
    select(available.find(p=>p.id===requested||p.appId===requested)?.id||active.id);
  }
}
