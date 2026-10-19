import { expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
if(typeof document==='undefined')GlobalRegistrator.register();
import { renderEmployeePage, resolvePageBindings } from '../src/page-renderer';
import { FINANCE_PROFILE, DEFAULT_COMPANY, getDefaultPages } from '../src/profiles';
import type { EmployeeSnapshot } from '../src/domain';
const page={id:'expenses',title:'支出看板',html:'<section class="summary"><h3>合计</h3><p>{{total}}</p><p>{{company}}</p></section><div data-binding="rows"></div>',css:'.summary p { font-weight: 600; }',bindings:[{id:'total',kind:'sum',field:'amount',filters:[{field:'direction',operator:'eq',value:'支出'}]},{id:'rows',kind:'records',columns:['date','counterparty','amount'],filters:[{field:'direction',operator:'eq',value:'支出'}]}]} as any;
const snapshot=()=>({profile:FINANCE_PROFILE,company:{...DEFAULT_COMPANY,name:'<img src=x>'},records:[
  {id:'one',profileId:'finance',values:{date:'2026-10-08',direction:'支出',counterparty:'<script>source</script>',amount:1250},revision:1,archived:false},
  {id:'two',profileId:'finance',values:{date:'2026-10-08',direction:'收入',counterparty:'客户',amount:5000},revision:1,archived:false},
  {id:'other',profileId:'hr',values:{direction:'支出',amount:99999},revision:1,archived:false},
  {id:'archived',profileId:'finance',values:{direction:'支出',amount:99999},revision:1,archived:true},
],sources:[],reports:[]} as unknown as EmployeeSnapshot);
test('HTML boards read current role data and trusted slots receive only matching records',()=>{
  const s=snapshot();const root=document.createElement('div');let ids:string[]=[];
  const stop=renderEmployeePage(root,page,s,{records:(target,rows)=>{ids=rows.map(r=>r.id);target.textContent=String(rows[0]?.values.counterparty);}});
  expect(root.textContent).toContain('¥12.50');expect(root.querySelector('img,script')).toBeNull();expect(ids).toEqual(['one']);
  expect(root.querySelector<HTMLElement>('p')?.style.fontWeight).toBe('600');stop();
  s.records[0]!.values.amount=1300;renderEmployeePage(root,page,s);expect(root.textContent).toContain('¥13.00');
});
test('generic count, distinct and difference bindings do not require a finance page',()=>{
  const s=snapshot();const definition={...page,id:'any-role',bindings:[{id:'total',kind:'count'},{id:'parties',kind:'distinct',field:'counterparty'},{id:'in',kind:'sum',field:'amount',filters:[{field:'direction',operator:'eq',value:'收入'}]},{id:'out',kind:'sum',field:'amount',filters:[{field:'direction',operator:'eq',value:'支出'}]},{id:'net',kind:'difference',left:'in',right:'out'}],html:'<p>{{total}} / {{parties}} / {{net}}</p>'};
  const data=resolvePageBindings(definition,s);expect(data.values.total).toBe('2');expect(data.values.parties).toBe('2');expect(data.values.net).toBe('¥37.50');
});
test('date and text filters use declared values and archived or other-role reports are excluded',()=>{
  const s=snapshot();s.reports=[{id:'mine',profileId:'finance',title:'mine'},{id:'other',profileId:'hr',title:'other'}] as any;
  const definition={...page,html:'<div data-binding="rows"></div><div data-binding="outputs"></div>',bindings:[{id:'rows',kind:'records',filters:[{field:'date',operator:'gte',value:'2026-10-09'}]},{id:'outputs',kind:'reports'}]};
  const data=resolvePageBindings(definition,s);expect(data.records.rows).toEqual([]);expect(data.reports.outputs?.map(r=>r.id)).toEqual(['mine']);
});
test('a custom job binds only its declared fields without a finance branch',()=>{
  const state=snapshot();
  state.profile={...FINANCE_PROFILE,id:'support',name:'客户支持',fields:[{key:'ticket',label:'工单',type:'text',required:true,aliases:[]}],ui:{accentColor:'#6554C0',logoText:'客',html:'',css:''}};
  state.records=[{id:'support-record',profileId:'support',values:{ticket:'T-001'},revision:1,archived:false,createdAt:'',updatedAt:''}];
  const root=document.createElement('div');const pages=getDefaultPages(state.profile);
  renderEmployeePage(root,pages.dashboard,state);
  expect(root.textContent).toContain('客户支持');expect(root.textContent).toContain('T-001');expect(root.textContent).not.toContain('收入');
});
test('a difference cannot turn an unsafe subtotal into a precise-looking number',()=>{
  const state=snapshot();state.profile={...FINANCE_PROFILE,fields:[{key:'number',label:'数量',type:'number',required:true,aliases:[]},{key:'group',label:'组别',type:'text',required:true,aliases:[]}]};
  state.records=[...['left','left','right'].map((group,index)=>({id:String(index),profileId:'finance',values:{group,number:index===1?2:Number.MAX_SAFE_INTEGER},revision:1,archived:false,createdAt:'',updatedAt:''}))];
  const definition={...page,html:'<p>{{delta}}</p>',bindings:[{id:'left',kind:'sum',field:'number',filters:[{field:'group',operator:'eq',value:'left'}]},{id:'right',kind:'sum',field:'number',filters:[{field:'group',operator:'eq',value:'right'}]},{id:'delta',kind:'difference',left:'left',right:'right'}]};
  const values=resolvePageBindings(definition,state).values;
  expect(values.left).toBe('合计超出安全范围');expect(values.delta).toBe('合计超出安全范围');
});
test('negative rows cannot hide precision loss in an intermediate subtotal',()=>{
  const state=snapshot();state.profile={...FINANCE_PROFILE,fields:[{key:'number',label:'数量',type:'number',required:true,aliases:[]}]};
  state.records=[Number.MAX_SAFE_INTEGER,2,-Number.MAX_SAFE_INTEGER].map((number,index)=>({id:String(index),profileId:'finance',values:{number},revision:1,archived:false,createdAt:'',updatedAt:''}));
  const values=resolvePageBindings({...page,html:'<p>{{total}}</p>',bindings:[{id:'total',kind:'sum',field:'number'}]},state).values;
  expect(values.total).toBe('合计超出安全范围');
});
