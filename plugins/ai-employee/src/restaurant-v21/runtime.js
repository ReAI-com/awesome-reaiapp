/* Restaurant scenario additions. Loaded as text by generator.ts, inlined before v2 init.
   All state remains in the inherited per-role in-memory runtime. No network or persistence. */
function restaurantScopeNote() {
  const r = role();
  return `<div class="note ${r.scopeUncertain ? 'warn' : ''} restaurant-scope">${ic('info')}<span>${esc(r.scopeNote || '全部记录与结论均为虚构样例，用于讨论界面。')}<small class="restaurant-disclaimer"> 候选是预置草案；检查是预置结果；签字和升级仅在本页演示，不产生业务操作。</small></span></div>`;
}

function restaurantHome() {
  return `<div class="restaurant-home-inner"><section class="restaurant-hero"><div class="restaurant-welcome"><div class="restaurant-eyebrow">BANU · EMPLOYEE WORKSPACE</div><h1>让每一个岗位，<br>都有自己的 AI 工作台。</h1><p>从日常待办开始，在看板里核对资料、讨论方案、确认下一步。</p><div class="restaurant-welcome-note">${badge('演示数据','b-warn')}<span>沿用巴奴场景 · 业务记录均为虚构样例</span></div></div><div class="restaurant-summary"><div class="restaurant-summary-head">工作空间概览<span>餐饮 v2.1</span></div><div class="restaurant-stats"><div><b>17</b><span>岗位员工</span></div><div><b>58</b><span>工作主题</span></div><div><b>332</b><span>原有样例记录</span></div></div><div class="restaurant-summary-foot">${ic('shield',14)}18 条需求 · 保留原 83 看板 · 5 个范围待确认岗位</div></div></section>
    <div class="restaurant-today"><span class="restaurant-today-title">${ic('clock',20)}今日工作示例<small>选择岗位，查看虚构待办</small></span>${[['training','课程资源待确认'],['supply','在途到货待核对'],['legal','事务证据待复核']].map(([id,label])=>`<button type="button" data-act="restaurant-role" data-id="${id}"><span class="dot warn"></span><span>${label}<small>${esc(roleById(id).name)}</small></span>${ic('arrow-right',14)}</button>`).join('')}</div>
    <div class="restaurant-directory-head"><div><h2>我的 AI 员工 <small>17</small></h2><p>沿用统一工作范式，保留每个岗位的业务语言。</p></div>${btn('需求与功能缺口','restaurant-gap',{icon:'list',sm:true})}</div>
    <div class="restaurant-home-note">${ic('info',14)}全部虚构 · 仅内存运行，刷新重置。未连接真实模型或业务系统；签字、检查和通知均为演示。</div>
    <div class="restaurant-roles">${ROLES.map(restaurantRoleCard).join('')}</div>
    <div class="restaurant-compare"><a href="/design/paradigm-v2.html" target="_blank" rel="noopener">对比 main v2 范式</a><a href="/showcase.html#/" target="_blank" rel="noopener">对比原 17 岗位看板</a><a href="/preview.html" target="_blank" rel="noopener">查看原始模板</a></div></div>`;
}

function restaurantRoleCard(r) {
  const topicIndex=r.fields.findIndex(f=>f[0]==='topic');
  const counts=r.boards.map(b=>r.rows.filter(row=>b.sections.some(section=>section.topic===row[topicIndex])).length);
  const max=Math.max(1,...counts);
  return `<button type="button" class="restaurant-role" data-act="restaurant-role" data-id="${esc(r.id)}" aria-label="打开${esc(r.name)}工作台"><span class="restaurant-card-top"><span class="restaurant-role-icon">${ic(r.icon,20)}</span>${badge(r.priorities.join(' / '),'b-mute')}</span><span class="top">${esc(r.name)}</span><span class="restaurant-role-dept">${esc(r.department)}</span><p>${esc(r.summary)}</p><span class="restaurant-mini"><span class="restaurant-mini-title">主题记录分布 · 初始样例</span>${r.boards.map((b,i)=>`<span class="restaurant-mini-row"><span>${esc(b.title)}</span><span class="restaurant-mini-track"><i class="level-${Math.ceil(counts[i]/max*5)}"></i></span><small>${counts[i]}</small></span>`).join('')}</span><span class="bottom"><span>${r.scopeUncertain?'范围待确认':r.legacyTasks.length+' 项岗位任务'}</span><span class="arrow">进入工作台 ${ic('arrow-right',14)}</span></span></button>`;
}

function restaurantThemeRecords(b, records = recList()) {
  if (!b.sections) return applyF(records, b.filter);
  const topics = new Set(b.sections.map(s => s.topic));
  return records.filter(x => topics.has(x.values.topic));
}

function restaurantSectionViews(b, o = {}) {
  const records = o.recs || recList();
  const rows = restaurantThemeRecords(b, records);
  const metrics = b.type === 'B' ? metricsHtml(b, rows) : '';
  const sections = b.sections.map(section => {
    const list = records.filter(x => x.values.topic === section.topic);
    return restaurantSectionTable(section.title, section.cols, section.labels, list, b, o.preview);
  }).join('');
  const primary = role().boards.find(x => x.type === 'B');
  const reflows = b.id === primary.id ? records.filter(x => x.values.topic === '交付回流') : [];
  return metrics + sections + (reflows.length ? restaurantSectionTable('签字交付回流 · 待后续使用', ['item','content','state'], ['交付内容','规范草案快照','状态'], reflows,b,o.preview) : '');
}

function restaurantSectionTable(title, cols, labels, rows, b, preview) {
  const labelOf = (key, i) => Array.isArray(labels) ? labels[i] : labels && labels[key] || (fieldOf(key) || {label:key}).label;
  return `<section class="section restaurant-section"><div class="sec-head"><h2>${ic('list')}${esc(title)}</h2><span class="sub">${rows.length} 条 · ${preview ? '只读预览' : '实时读取本岗记录'}</span></div><div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((key,i) => `<th>${esc(labelOf(key,i))}</th>`).join('')}<th>来源</th>${isDev() ? '<th>版本</th>' : ''}</tr></thead><tbody>${rows.length ? rows.map(x => `<tr>${cols.map(key => key === 'item' ? `<td class="cell-title"><button type="button" class="link" ${openRecAttrs(x,preview,b)}>${esc(x.values[key])}</button></td>` : `<td>${esc(x.values[key] == null ? '' : x.values[key])}</td>`).join('')}<td>${originBadge(x.origin)}</td>${isDev() ? `<td>v${x.v}</td>` : ''}</tr>`).join('') : `<tr><td colspan="${cols.length + (isDev()?2:1)}" class="muted">该业务分区暂无记录。资料确认入库后在这里显示。</td></tr>`}</tbody></table></div></section>`;
}

function restaurantCandidateBody(task, candidate, rs) {
  const preset = (task.cands.find(c => c[0] === candidate.title) || task.cands[0])[1];
  const input = task.inputs.map(i => rs.records[i]).filter(Boolean).map(x => {
    const values = role().fields.filter(f => x.values[f[0]] !== '' && x.values[f[0]] != null).map(f => `${f[1]}：${x.values[f[0]]}`).join('；');
    return `${recTitle(x)}（第 ${x.v} 版）\n${values}`;
  }).join('\n\n');
  return `【预置业务草案 · 未调用模型或求解器】\n${preset}\n\n【当前输入摘要 · 需人工核对】\n${input}`;
}

// A reflow is canonical candidate content, never a copy of the input's cost/quantity.
reflowRow = function(r, rs, receipt, title) {
  const st = rs.c[receipt.task], candidate = st && st.versions[receipt.cand];
  return r.fields.map(f => f[0] === 'item' ? `${title}（回流）` : f[0] === 'state' ? '回流待复核' : f[0] === 'topic' ? '交付回流' : f[0] === 'content' ? candidate.body : '');
};

// Actual user input is preserved only in bounded memory. No preset business yields.
addSource = function(name, o) {
  const r = role(), rs = RS();
  const bytes = o.bytes && o.bytes.length <= READ_LIMIT ? o.bytes.slice() : null;
  const basis = bytes ? 'bytes' : 'meta';
  const print = bytes ? fpBytes(bytes) : fp(`meta|${name}|${o.size}|${o.lastModified || 0}`);
  const dup = bytes && rs.sources.find(s => s.fpBasis === 'bytes' && s.fp === print && s.bytes && s.bytes.length === bytes.length && s.bytes.every((value,i) => value === bytes[i]));
  if (dup) { rs.highlight = dup.id; toast('内容相同的原件已在本岗内存中保留，未重复添加'); return dup; }
  let text = '';
  const textLike = TEXTY.test(name) || o.origin === 'paste';
  if (bytes && textLike && bytes.length <= TEXT_LIMIT) { try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch(e) { /* undecodable data remains bytes */ } }
  const why = !bytes ? '超过 8 MiB，仅登记元信息，未保存文件内容' : textLike && bytes.length > TEXT_LIMIT ? '超过 512 KiB 文本预览上限；原始字节已保留在内存' : '未提供对应整理器，待人工整理';
  const s = {id:`A-${r.id}-${nextId('upload')}`,name,kind:textLike?'txt':'bin',st:'unsup',unsupWhy:why,preview:text ? text.slice(0,1200) + (text.length > 1200 ? '\n（预览截断；完整文本仍在本页内存）' : '') : `（${why}）`,text,bytes,origin:o.origin || 'upload',issues:[],yields:[],fp:print,fpBasis:basis,at:nowStr(),size:o.size,refs:[],by:r.user};
  rs.sources.push(s); rs.highlight=s.id;
  toast(bytes ? '原件已保留在本页内存；未整理入库，刷新后清空' : '只登记了文件信息；超过读取上限，未保存原件内容');
  return s;
};

const restaurantDrawerParts = drawerParts;
drawerParts = function(sp) {
  if (sp.kind === 'restaurant-gap') {
    const r = role(), group = RESTAURANT_THEMES.find(x => x.roleId === r.id);
    return {title:'需求覆盖与功能缺口',sub:'餐饮 v2.1 · 独立交互原型',body:`<div class="note warn">${ic('info')}<span>UI/UX 讨论版本；所有业务记录、候选、规则结果均为虚构预置。真实业务能力仍待实现。</span></div><div class="dr-sec"><h3>这次整合了什么</h3><ul class="restaurant-gap-list"><li>沿用 main v2 的资料复核、交付候选、签字回流、检查与 Agent 确认。</li><li>把 17 岗位原 83 看板归入 58 主题，保留 332 条原记录的字段、单位和来源。</li><li>增加输入变动复验、字段值历史与冻结快照；回流只存签字内容，不复制业务数量。</li><li>原页面、旧浏览器数据与插件版本均保留。新页只在内存运行，刷新重置。</li></ul></div><div class="dr-sec"><h3>${esc(r.name)} · 原看板去向</h3>${kv(group.themes.map(t => [t.title,esc(RESTAURANT_COVERAGE.filter(x => x.themeId === t.id && x.roleId === r.id).map(x=>x.oldTitle).join('、'))]))}</div><div class="dr-sec"><h3>仍需产品与业务确认</h3><ul class="restaurant-gap-list"><li>CAD：仅展示材料范围与审查问题，不出 CAD 图。</li><li>四位高层：职责、人设授权和资料权限待确认，不预设分管、不代言本人。</li><li>采购、库存、绩效、审批、招聘和法务采用演示口径，不做真实执行或自动决策。</li><li>未接模型、OCR、视频/称重识别、正式文件导出、Host、云流程或跨岗授权；没有真实通知与下单。</li><li>真实上传/粘贴只保留有界内存原件，不套用预置业务整理结果。</li><li>部门负责人/管理员/开发者是界面视角模拟，不能作为真实授权依据。</li></ul></div><div class="restaurant-compare"><a href="/design/paradigm-v2.html" target="_blank" rel="noopener">main v2</a><a href="/showcase.html#/" target="_blank" rel="noopener">原 17 岗位版</a><a href="/preview.html" target="_blank" rel="noopener">原始模板</a></div>`};
  }
  if (sp.kind === 'changelog') return {title:'原型说明与插件版本',sub:`场景原型 v2.1 · 插件包 ${PLUGIN.version}`,body:'<p class="small">餐饮 v2.1 是新增独立页面，整合 17 个岗位及原 83 个看板，沿用 main v2 的交互骨架。此编号是原型场景编号；插件包仍为 0.2.0，未升级、未送审。</p><p class="tiny">旧 v1、main v2 和原 17 岗位页面保持原样。</p>'};
  const result = restaurantDrawerParts(sp);
  if (sp.kind === 'rec') {
    const rec = recById(sp.id);
    if (rec) result.body += `<div class="dr-sec"><h3>历史字段快照</h3>${rec.history.map(h => `<details><summary>第 ${h.v} 版 · ${esc(h.note)}</summary>${h.values ? kv(role().fields.filter(f => h.values[f[0]] !== '' && h.values[f[0]] != null).map(f => [f[1],esc(h.values[f[0]])])) : '<p class="tiny">该版本没有字段快照。</p>'}</details>`).join('')}</div>`;
  }
  if (sp.kind === 'dres') {
    const [bid,resId] = sp.id.split('|'), d = RS().d[bid];
    if (d) {
      const run = d.runs.find(run => run.results.some(result => result.id === resId));
      const evidence = run && run.results.find(result => result.id === resId);
      const values = evidence && run.read.values[evidence.evid];
      result.body += `<div class="dr-sec"><h3>检查时字段快照</h3><p class="tiny">检查启动时冻结本岗整表；记录增加、删除或修订都会使旧结论过期。以下为当时证据记录的值。</p>${values ? kv(role().fields.filter(f => values[f[0]] !== '' && values[f[0]] != null).map(f => [f[1],esc(values[f[0]])])) : '<p class="tiny">证据不足或外部对象受限，没有可读取的字段快照。</p>'}</div>`;
    }
  }
  if (sp.kind === 'paste') result.sub = '仅保存在本页内存，不自动整理；刷新后清空';
  if (sp.kind === 'more') result.body = `<div class="btns">${btn('AI 员工首页','go',{id:'restaurant-home',icon:'grid'})}${btn('需求与缺口','restaurant-gap',{icon:'list'})}</div>` + result.body;
  if (sp.kind === 'src') {
    const source = srcById(sp.id);
    if (source && source.fpBasis === 'meta') result.body = '<div class="note warn">超过读取上限：仅登记元信息，未保存文件内容。</div>' + result.body.replace('这类文件只保存原件，暂不支持自动整理。','文件内容未读取；只登记了名称、大小等信息。');
    if (source && source.st === 'unsup' && source.bytes) result.body = '<div class="note">原始字节已保留在本页内存；未提供对应整理器，待人工整理。刷新后清空。</div>' + result.body;
  }
  return result;
};

const restaurantDashboard = pageDashboard;
pageDashboard = function() {
  const r = role();
  const tasks = r.legacyTasks || [];
  return `<div class="btns section">${btn('所有 AI 员工','go',{id:'restaurant-home',icon:'grid',sm:true})}${btn('本岗需求与缺口','restaurant-gap',{icon:'list',sm:true})}</div>` + restaurantScopeNote() + restaurantDashboard() + `<details class="restaurant-evidence section"><summary>需求任务与主题对应 · ${tasks.length} 项</summary><div class="restaurant-task-links">${tasks.map(t => btn(t.task,'go',{id:'board:'+t.themeId,kind:'btn-2',sm:true})).join('')}</div></details>`;
};

const restaurantIpo = pageIpo;
pageIpo = function() { return `<div class="note warn">${ic('info')}<span>拟议交接示意 · 尚未接通。连线是界面讨论假设，待处理数为演示值；四位高层不预设分工，部门角色范围仅供视角演示。</span></div>` + restaurantIpo(); };
const restaurantMyFlow = myFlow;
myFlow = function() { return ['chairman','ceo','vp1','vp2'].includes(S.roleId) ? emptyBox('network','职责与交接关系待确认','需要先确认本人授权、岗位职责与资料边界；本原型不预设分管或运行中的交接。') : restaurantMyFlow(); };

const restaurantSourceStatus = srcStatusCell;
srcStatusCell = function(s, detail) { return s.fpBasis === 'meta' ? '<span class="tiny">仅登记信息 · 原件未保存</span>' : restaurantSourceStatus(s,detail); };

ACT['restaurant-gap'] = (id,t) => openDrawer({kind:'restaurant-gap'},t);
ACT['restaurant-role'] = id => { switchRole(id); if (!isMobile()) S.agentOpen = true; go('dashboard'); };

const restaurantRenderContent = renderContent;
renderContent = function(reset) { document.documentElement.dataset.restaurantHome=String(S.route.page==='restaurant-home'); restaurantRenderContent(reset); };
