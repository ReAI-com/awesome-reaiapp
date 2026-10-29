import { createHash } from 'node:crypto';
import { localizeHtml, languageSwitcher } from '../i18n.js';
import { readFile, writeFile, mkdir, cp, copyFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './content.mjs';
import { fetchPublicCatalog } from '../public-catalog.js';
import { directory, detail, changelog, showcase, caseDetail, developers, notFound, genericDetail } from './templates.mjs';
import {heroPreview} from './hero-preview.mjs';
import {previews} from '../home-previews.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const assetNames=['index.html','styles.css','pages.css','home.css','home.js','home-previews.js','scripts/hero-preview.mjs','app.js','public-catalog.js','i18n.js',...previews.flatMap(p=>[`assets/previews/${p.id}.mp4`,`assets/previews/${p.id}.png`])];
const assetHash=createHash('sha256');
for (const bytes of await Promise.all(assetNames.map(name=>readFile(join(root,name))))) assetHash.update(bytes);
const assetVersion=assetHash.digest('hex').slice(0,12);
const legacyAppIds = JSON.parse(await readFile(join(root, 'scripts/legacy-app-ids.json'), 'utf8'));
if (!Array.isArray(legacyAppIds) || new Set(legacyAppIds).size !== legacyAppIds.length || legacyAppIds.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id))) throw new Error('The legacy app ID list is invalid.');
const catalog = await fetchPublicCatalog();
const provenance = JSON.parse(await readFile(join(root, 'assets/brand-sources.json'), 'utf8'));
if (JSON.stringify(provenance.approvedCandidates) !== '[1,3]') throw new Error('Approved brand assets missing');

// 使用既有文档构建，保持 docs/ 为唯一内容源。仅匿名只读公共 Catalog，不执行发布。
execFileSync('bun', ['run', 'build'], { cwd: join(repo, 'website'), stdio: 'inherit', timeout: 120000,
  env: { ...process.env, VITE_REAI_OPEN_PLATFORM: '1' } });
const destinations = [process.env.REAI_OPEN_OUTPUT ? resolve(process.env.REAI_OPEN_OUTPUT) : join(root, 'dist')];
const publicCatalog = catalog.map(({ iconSource, ...p }) => p);
const json = JSON.stringify(publicCatalog, null, 2);
const script = `window.REAI_CATALOG = ${json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};\n`;

async function save(output, relative, content) {
  const path = join(output, relative);
  await mkdir(dirname(path), { recursive: true });
  if(relative.endsWith('.html') && !relative.startsWith('docs/')) {
    content=content.replace(/(href|src|poster)="(\/(?:styles\.css|pages\.css|home\.css|home\.js|app\.js|catalog\.js|assets\/hero-motion\.mp4|assets\/hero-poster\.png))[^"]*"/g,(_,attribute,url)=>`${attribute}="${url}?v=${assetVersion}"`);
    const route=relative==='index.html'?'/':`/${relative.replace(/index\.html$/,'')}`;
    content=content.replace('<!--LANGUAGE_SWITCH-->',languageSwitcher(route,'zh'));
    content=content.replace('<meta name="robots" content="noindex,nofollow">','');
    await writeFile(path,content);
    const english=localizeHtml(content,'en').replace(/<a[^>]*data-language-switch[^>]*>.*?<\/a>/,languageSwitcher(route,'en'));
    const enPath=join(output,'en',relative);
    await mkdir(dirname(enPath),{recursive:true});
    await writeFile(enPath,english);
    return;
  }
  await writeFile(path, content);
}
async function integrateDocs(output) {
  const target = join(output, 'docs');
  await cp(join(repo, 'website/dist'), target, { recursive: true });
  for (const relativeDir of ['', 'en/']) {
  const directory=join(target,relativeDir);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.html')) continue;
    let page = await readFile(join(directory, name), 'utf8');
    page = page.replace(/href="(?:\.\/|\/docs\/)README(?=[#"])/g, 'href="/docs/');
    page = page.replace(/href="(?:\.\/|\/docs\/)CHANGELOG(?=[#"])/g, 'href="/docs/changelog');
    await writeFile(join(directory, name), page);
    if (name !== 'index.html' && name !== '404.html') {
      const canonical = `/docs/${relativeDir}${name.slice(0, -5)}`;
      // 旧的尾斜杠入口归一到原生 clean URL；不用 base 改变页内 #anchor 的目标。
      await save(output, `docs/${relativeDir}${name.slice(0, -5)}/index.html`, `<!doctype html><html lang="${relativeDir ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><title>${relativeDir ? 'Opening documentation' : '正在打开文档'}</title><script>location.replace(${JSON.stringify(canonical)}+location.search+location.hash)</script></head><body><a href="${canonical}">${relativeDir ? 'Open documentation' : '打开文档'}</a></body></html>`);
    }
  }
  }
}
for (const output of destinations) {
  await mkdir(output, { recursive: true });
  if (output !== root) {
    for (const name of ['styles.css','pages.css','home.css','home.js','home-previews.js','app.js','public-catalog.js','i18n.js']) {
      let source=await readFile(join(root,name),'utf8');
      if(name.endsWith('.js')) source=source.replace(/(from\s+["']\/(?:public-catalog|i18n|home-previews)\.js)(["'])/g,`$1?v=${assetVersion}$2`);
      await save(output,name,source);
    }
    await save(output,'index.html',(await readFile(join(root,'index.html'),'utf8')).replace('<!--PLUGIN_PREVIEWS-->',heroPreview(catalog,assetVersion)));
    await copyFile(join(root,'legal/THIRD-PARTY-NOTICES.txt'),join(output,'THIRD-PARTY-NOTICES.txt'));
    await cp(join(root, 'assets'), join(output, 'assets'), { recursive: true });
  }
  // 未公开的本地插件不再展示源码快照；旧入口使用公开目录查询。
  for (const appId of legacyAppIds.filter(id=>!catalog.some(a=>a.appId===id))) {
    await save(output, `apps/${appId}/index.html`, genericDetail(appId));
    await save(output, `apps/${appId}/changelog/index.html`, changelog({appId,name:'插件',version:'',changelog:[]}));
  }
  await save(output, 'apps/_detail/index.html', genericDetail());
  await save(output, 'apps/_changelog/index.html', changelog({appId:'',name:'插件',version:'',changelog:[]}));
  await save(output, 'catalog.json', json + '\n');
  await save(output, 'catalog.js', script);
  await save(output, 'apps/index.html', directory());
  for (const p of catalog) {
    await save(output, `apps/${p.appId}/index.html`, detail(p, catalog));
    await save(output, `apps/${p.appId}/changelog/index.html`, changelog(p));
  }
  await save(output, 'showcase/index.html', showcase());
  for (const c of cases) await save(output, `showcase/${c.slug}/index.html`, caseDetail(c, catalog));
  await save(output, 'developers/index.html', developers());
  await save(output, '404.html', notFound());
  await integrateDocs(output);
}
console.log(`ReAI Open built: ${catalog.length} plugins, ${cases.length} scenarios, local VitePress docs; ${destinations.join(', ')}`);
