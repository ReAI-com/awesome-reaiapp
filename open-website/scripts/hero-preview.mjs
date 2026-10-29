import {previews,previewAsset} from '../home-previews.js';
import {t} from '../i18n.js';
import {esc} from './templates.mjs';

export function heroPreview(catalog,version) {
  const available=previews.filter(p=>catalog.some(app=>app.appId===p.appId));
  if(!available.length) return `<div class="hero-copy"><h1>让好工具，<br><span>接住每一个想法。</span></h1><a class="home-button" href="/apps/">探索插件 <span aria-hidden="true">↗</span></a></div>`;
  const active=available[0],text=s=>esc(t(s,{},'zh'));
  return `<div class="preview-picker"><p>${text('home.preview.pick')}</p><div class="preview-tabs" role="tablist" aria-label="${text('home.preview.choose')}">${available.map((p,index)=>{
    const app=catalog.find(app=>app.appId===p.appId);
    return `<button type="button" role="tab" class="preview-tab" id="preview-tab-${p.id}" data-preview="${p.id}" aria-controls="preview-panel" aria-selected="${index===0}" tabindex="${index===0?'0':'-1'}"><span>${esc(app.name)}</span></button>`;
  }).join('')}</div></div>
  <div class="preview-panel" id="preview-panel" role="tabpanel" aria-labelledby="preview-tab-${active.id}" tabindex="0" data-active-preview="${active.id}" data-preview-version="${version}">
    <div class="hero-copy">
      <p class="home-eyebrow"><span class="status-dot" aria-hidden="true"></span> ${text('home.preview.eyebrow')}</p>
      <h1 id="hero-title"><span id="preview-title-first">${text(active.key+'.title1')}</span><br><span id="preview-title-second">${text(active.key+'.title2')}</span></h1>
      <p class="home-intro" id="preview-intro">${text(active.key+'.intro')}</p>
      <a class="home-button" id="preview-link" href="/apps/${active.appId}/">${text('home.preview.detail')} <span aria-hidden="true">↗</span></a>
      <ol class="preview-steps" aria-label="${text('home.preview.steps')}">${[0,1,2].map(i=>`<li${i===0?' aria-current="step"':''}><span class="preview-step-number" aria-hidden="true">0${i+1}</span><span data-preview-step="${i}">${text(active.key+'.step'+i)}</span></li>`).join('')}</ol>
    </div>
    <figure class="hero-preview">
      <div class="product-preview">
        <img id="hero-still" src="${previewAsset(active,'png',version)}" alt="${text(active.key+'.alt')}" width="1920" height="1200">
        <video id="hero-video" muted playsinline loop preload="none" poster="${previewAsset(active,'png',version)}" aria-label="${text(active.key+'.alt')}"></video>
      </div>
      <figcaption><span id="preview-source">${text(active.key+'.source')}</span><button type="button" class="preview-replay">${text('home.preview.replay')}</button><button type="button" class="motion-toggle" aria-pressed="false">${text('home.motionPause')}</button></figcaption>
      <p class="preview-media-status" id="preview-media-status" role="status"></p>
    </figure>
  </div>`;
}
