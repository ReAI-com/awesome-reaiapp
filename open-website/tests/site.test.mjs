import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog, safeAsset, cases } from '../scripts/content.mjs';
import { detail, esc } from '../scripts/templates.mjs';
import {normalizePublicCatalog,fetchPublicCatalog,publicDetail} from '../public-catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.REAI_OPEN_OUTPUT ? resolve(process.env.REAI_OPEN_OUTPUT) : join(root, 'dist');
test('legacy app routes preserve IDs without a local plugin checkout', async () => {
  const ids = JSON.parse(await readFile(join(root, 'scripts/legacy-app-ids.json'), 'utf8'));
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const hidden of ['com.reai.pi-agent', 'com.reai.dsh-agent', 'com.reai.codex-app']) {
    assert.ok(!ids.includes(hidden), hidden);
  }
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
    assert.ok((await stat(join(output, 'apps', id, 'index.html'))).isFile());
    assert.ok((await stat(join(output, 'en/apps', id, 'index.html'))).isFile());
  }
  assert.ok(cases.every(c => c.plugins.length > 0));
});
test('version logs reject ambiguous duplicates and empty entries; assets cannot escape plugin', () => {
  assert.deepEqual(parseChangelog('## 1.0.0\n\n实际改进\n\n## 0.9.0\n旧版说明'), [{version:'1.0.0',notes:'实际改进'}, {version:'0.9.0',notes:'旧版说明'}]);
  assert.throws(() => parseChangelog('## 1.0.0\nA\n## 1.0.0\nB'), /Duplicate/);
  assert.throws(() => parseChangelog('## 1.0.0\n'), /Empty/);
  assert.throws(() => safeAsset('/plugins/test', '../secret'), /escapes/);
  assert.throws(() => safeAsset('/plugins/test', 'assets\\icon.png'), /Invalid/);
});
test('plugin content is escaped and exact-version links are encoded', async () => {
  const [plugin] = normalizePublicCatalog({groups:{appStore:{schemaVersion:1,apps:[{appId:'com.example.tool',name:'<script>alert(1)</script>',description:'Public description',reviewStatus:'approved',latestRelease:{version:'1.0.0+local'}}]}}});
  const page = detail(plugin, [plugin]);
  assert.ok(page.includes(esc('<script>alert(1)</script>')));
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('version=1.0.0%2Blocal'));
});
test('built deep routes, local links and assets resolve without SPA fallback', async () => {
  const out = output;
  const pages = [];
  async function walk(path) {
    for (const name of await readdir(path, {withFileTypes:true})) {
      const full = join(path, name.name);
      if (name.isDirectory()) await walk(full);
      else if (name.name.endsWith('.html')) pages.push(full);
    }
  }
  await walk(out);
  const catalog = JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8'));
  for (const p of catalog) {
    assert.ok((await stat(join(out, 'apps', p.appId, 'index.html'))).isFile());
    const log = await readFile(join(out, 'apps', p.appId, 'changelog/index.html'), 'utf8');
    assert.ok(log.includes('id="requested-version"'));
    assert.ok(log.includes('更新日志还在准备中。') || p.changelog.length);
  }
  let checked = 0;
  for (const path of pages) {
    const html = await readFile(path, 'utf8');
    const basePath = html.match(/<base href="([^"]+)"/)?.[1];
    for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
      const url = match[1].replaceAll('&amp;', '&');
      if (/^(https?:|mailto:|data:)/.test(url)) continue;
      const part = decodeURIComponent(url.split(/[?#]/)[0]);
      const local = part.startsWith('/') ? join(out, part) : resolve(basePath ? join(out, basePath) : dirname(path), part);
      let found = false;
      for (const candidate of [local, join(local, 'index.html'), `${local}.html`]) {
        try { if ((await stat(candidate)).isFile()) {found = true; break;} } catch {}
      }
      assert.ok(found, `Broken link ${url} in ${path}`);
      checked++;
    }
  }
  assert.ok(checked > 300);
});

test('public catalog exposes published display fields only, omits credentials and handles failures', async()=>{
  const payload={groups:{appStore:{schemaVersion:1,apps:[{appId:'com.example.tool',name:'公开工具',developerName:'作者',category:'Dev',description:'公开介绍',tagline:'公开文案',reviewStatus:'approved',iconUrl:'https://block2-api.wainao.chat/public/app-store/assets/icon-1',screenshots:[{url:'javascript:alert(1)'}],latestRelease:{version:'1.0.0',downloadUrl:'private-package-field'},publisherId:'internal-identity',permissions:['local-only']},{appId:'com.example.draft',reviewStatus:'pending'}]}}};
  let request;
  const catalog=await fetchPublicCatalog({fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify(payload));}});
  assert.equal(request.options.credentials,'omit');
  assert.equal(request.options.headers.Authorization,undefined);
  assert.equal(catalog.length,1);
  assert.equal(catalog[0].status,'published');
  assert.equal(catalog[0].name,'公开工具');
  assert.ok(!JSON.stringify(catalog).includes('private-package-field'));
  assert.ok(!JSON.stringify(catalog).includes('internal-identity'));
  assert.equal(catalog[0].permissions,undefined);
  assert.equal(catalog[0].screenshots.length,0);
  assert.match(publicDetail(catalog[0]),/公开版本/);
  assert.throws(()=>normalizePublicCatalog({groups:{appStore:{schemaVersion:2,apps:[]}}}));
  await assert.rejects(fetchPublicCatalog({fetchImpl:async()=>new Response('',{status:503})}),/503/);
});
test('documentation return link uses full navigation and page anchors keep their own document',async()=>{
  const html=await readFile(join(output,'docs/plugin-development-v1.html'),'utf8');
  assert.ok(!html.includes('<base'));
  assert.match(html,/<a[^>]*href="\/"[^>]*target="_self"[^>]*class="open-platform-return"/);
  assert.match(html,/href="#_3-最小项目"/);
  const publicSnapshot=JSON.parse(await readFile(join(output,'catalog.json'),'utf8'));
  assert.ok(publicSnapshot.every(p=>p.status==='published' && p.source==='public-catalog'));
});

test('Chinese and English resources cover the same keys and interpolation contracts', async()=>{
  const {messages,t,localizedPath,localeFromPath,localizeHtml}=await import('../i18n.js');
  assert.deepEqual(Object.keys(messages.zh).sort(),Object.keys(messages.en).sort());
  for(const key of Object.keys(messages.zh)) {
    assert.ok(messages.zh[key] && messages.en[key],key);
    assert.deepEqual([...messages.zh[key].matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),[...messages.en[key].matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),key);
  }
  assert.equal(t('discovery.count',{count:2,kind:'plugins',state:'Updated'},'en'),'Showing 2 plugins · Updated');
  assert.equal(localizedPath('/apps/com.reai.terminal/?q=hello&category=developer#info','en'),'/en/apps/com.reai.terminal/?q=hello&category=developer#info');
  assert.equal(localizedPath('/docs/en/plugin-development-v1#capability-reuse','zh'),'/docs/plugin-development-v1#capability-reuse');
  assert.equal(localizedPath('/assets/reai-logo.svg','en'),'/assets/reai-logo.svg');
  assert.equal(localeFromPath('/en/apps/'),'en');
  assert.equal(localeFromPath('/docs/en/plugin-development-v1'),'en');
  const rendered=localizeHtml('<h2>关于这个插件</h2><p data-source-text>关于这个插件</p><a href="/apps/">插件</a>','en');
  assert.match(rendered,/<h2>About this plugin<\/h2>/);
  assert.match(rendered,/<p data-source-text>关于这个插件<\/p>/);
  assert.match(rendered,/href="\/en\/apps\/"/);
});
test('English routes have localized UI, locale-specific download links and matching language routes',async()=>{
  const out=output;
  const en=await readFile(join(out,'en/index.html'),'utf8');
  const zh=await readFile(join(out,'index.html'),'utf8');
  assert.match(en,/<html lang="en"/);
  assert.match(en,/Say your idea\./);
  assert.match(en,/Hand off the rest\./);
  const authoredEnglish = en.replace(/<a[^>]*data-language-switch[^>]*>.*?<\/a>/g, '');
  assert.ok(!/[\u3400-\u9fff]/.test(authoredEnglish), 'English homepage must translate authored copy except the Chinese switch');
  assert.match(en,/href="https:\/\/ai-board.reai.com\/en\/download"/);
  assert.match(zh,/href="https:\/\/ai-board.reai.com\/zh\/download"/);
  assert.match(en,/data-language-switch="zh" href="\/"/);
  assert.match(zh,/data-language-switch="en" href="\/en\/"/);
  assert.ok(!en.includes('本地站点预览'));
  const docs=await readFile(join(out,'docs/en/plugin-development-v1.html'),'utf8');
  assert.match(docs,/<html lang="en"/);
  assert.match(docs,/English reading guide/);
  assert.match(docs,/Back to ReAI Open/);
  assert.match(docs,/href="\/en\/"[^>]*target="_self"/);
  const catalog=JSON.parse(await readFile(join(out,'catalog.json'),'utf8'));
  for(const p of catalog) {
    const page=await readFile(join(out,'en/apps',p.appId,'index.html'),'utf8');
    assert.match(page,/About this plugin/);
    assert.match(page,/Published version/);
    assert.ok(page.includes(esc(p.longDescription)),p.appId);
    assert.ok(page.includes(`data-public-app="${p.appId}"`));
  }
});

test('preview selector only includes supported apps present in the public catalog',async()=>{
  const {heroPreview}=await import('../scripts/hero-preview.mjs');
  const {previews}=await import('../home-previews.js');
  const rendered=heroPreview([{appId:'com.reai.voice',name:'Typezero'},{appId:'com.example.other',name:'Unrelated'}],'test123');
  assert.match(rendered,/data-active-preview="voice"/);
  assert.match(rendered,/data-preview="voice"/);
  assert.ok(!rendered.includes('data-preview="codex"'));
  assert.ok(!rendered.includes('Unrelated'));
  assert.ok(!rendered.includes('src="/assets/previews/voice.mp4'));
  assert.match(rendered,/voice.png\?v=test123/);
  assert.ok(!heroPreview([],'test123').includes('<video'));
  const {messages}=await import('../i18n.js');
  for(const p of previews)for(const suffix of ['title1','title2','intro','source','alt',...Array.from({length:p.steps||3},(_,i)=>'step'+i)]){
    assert.ok(messages.zh[p.key+'.'+suffix],p.key+'.'+suffix);
    assert.ok(messages.en[p.key+'.'+suffix],p.key+'.'+suffix);
  }
  assert.match(rendered,/data-preview-step="3"/);
});
