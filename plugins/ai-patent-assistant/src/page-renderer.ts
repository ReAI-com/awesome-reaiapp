import { formatMoney, validateHtmlPage, type EmployeeHtmlPage, type EmployeeRecord, type EmployeeReport, type EmployeeSnapshot, type RecordValue } from './domain';
import { applyScopedCss, renderSafeTemplate } from './template';

export interface PageComponents {
  records?(target:HTMLElement,records:EmployeeRecord[],columns:string[]):void;
  reports?(target:HTMLElement,reports:EmployeeReport[]):void;
}
export interface PageData { values:Record<string,string>; records:Record<string,EmployeeRecord[]>; reports:Record<string,EmployeeReport[]> }

/** Resolve declared bindings against current records. Page HTML cannot select a different job. */
export function resolvePageBindings(page:EmployeeHtmlPage,state:EmployeeSnapshot):PageData {
  const records=state.records.filter(record=>record.profileId===state.profile.id&&!record.archived);
  const reports=state.reports.filter(report=>report.profileId===state.profile.id);
  const updated=records.map(record=>record.updatedAt).filter(Boolean).sort().at(-1);
  const data:PageData={values:{company:state.company.name,role:state.profile.name,jobTitle:state.profile.jobTitle,recordCount:String(records.length),sourceCount:String(state.sources.length),reportCount:String(reports.length),updatedAt:updated?new Date(updated).toLocaleString('zh-CN',{hour12:false}):'—'},records:{},reports:{}};
  const totals=new Map<string,{value:number;money:boolean;safe:boolean}>();
  const display=(value:number,money:boolean)=>!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER?'合计超出安全范围':money?formatMoney(value,state.company.currency):new Intl.NumberFormat('zh-CN',{maximumFractionDigits:8}).format(value);
  for(const binding of page.bindings) {
    if(binding.kind==='difference')continue;
    if(binding.kind==='reports'){data.reports[binding.id]=reports;continue;}
    const matching=records.filter(record=>(binding.filters??[]).every(filter=>{
      const actual=record.values[filter.field];const expected=filter.value;
      switch(filter.operator){
        case 'empty':return actual===null||actual===undefined||actual==='';
        case 'eq':return actual===expected;
        case 'contains':return typeof actual==='string'&&typeof expected==='string'&&actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
        case 'gte':return typeof actual==='number'&&typeof expected==='number'?actual>=expected:typeof actual==='string'&&typeof expected==='string'&&actual>=expected;
        case 'lte':return typeof actual==='number'&&typeof expected==='number'?actual<=expected:typeof actual==='string'&&typeof expected==='string'&&actual<=expected;
      }
    }));
    if(binding.kind==='records'){data.records[binding.id]=matching;continue;}
    const field=state.profile.fields.find(field=>field.key===binding.field);let value=0;let safe=true;
    if(binding.kind==='count')value=matching.length;
    else if(binding.kind==='distinct')value=new Set(matching.map(record=>record.values[binding.field!]).filter(value=>value!==undefined&&value!==null&&value!=='')).size;
    else for(const record of matching){value+=typeof record.values[binding.field!]==='number'?record.values[binding.field!] as number:0;safe=safe&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER;}
    const money=binding.kind==='sum'&&field?.type==='money';totals.set(binding.id,{value,money,safe});data.values[binding.id]=safe?display(value,money):'合计超出安全范围';
  }
  for(const binding of page.bindings.filter(binding=>binding.kind==='difference')) {
    const left=totals.get(binding.left!);const right=totals.get(binding.right!);
    if(!left||!right||left.money!==right.money)throw new Error('差额绑定需要单位一致的数值');
    data.values[binding.id]=left.safe&&right.safe?display(left.value-right.value,left.money):'合计超出安全范围';
  }
  return data;
}

function textTable(target:HTMLElement,rows:EmployeeRecord[],columns:string[],state:EmployeeSnapshot):void {
  const table=document.createElement('table');const head=document.createElement('thead');const titles=document.createElement('tr');
  for(const key of columns){const th=document.createElement('th');th.textContent=state.profile.fields.find(field=>field.key===key)?.label??key;titles.append(th);}head.append(titles);
  const body=document.createElement('tbody');
  for(const record of rows){const tr=document.createElement('tr');for(const key of columns){const td=document.createElement('td');const value:RecordValue|undefined=record.values[key];const field=state.profile.fields.find(field=>field.key===key);td.textContent=field?.type==='money'&&typeof value==='number'?formatMoney(value,state.company.currency):String(value??'—');tr.append(td);}body.append(tr);}
  table.append(head,body);target.replaceChildren(table);
}

/** Trusted list components supply fixed actions. Generated HTML supplies only the layout. */
export function renderEmployeePage(container:HTMLElement,input:EmployeeHtmlPage,state:EmployeeSnapshot,components:PageComponents={}):()=>void {
  const page=validateHtmlPage(input,state.profile,{dashboard:input.id==='dashboard'||input.id==='overview'});
  const data=resolvePageBindings(page,state);
  const listIds=page.bindings.filter(binding=>binding.kind==='records'||binding.kind==='reports').map(binding=>binding.id);
  renderSafeTemplate(container,page.html,data.values,{listIds});
  for(const binding of page.bindings){
    if(!listIds.includes(binding.id))continue;
    const target=Array.from(container.querySelectorAll<HTMLElement>('[data-binding]')).find(node=>node.dataset.binding===binding.id);
    if(!target)throw new Error('页面缺少已声明的数据插槽');
    if(binding.kind==='records'){
      const rows=data.records[binding.id]??[];const columns=binding.columns??state.profile.fields.map(field=>field.key);
      if(components.records)components.records(target,rows,columns);else textTable(target,rows,columns,state);
    }else{
      const reports=data.reports[binding.id]??[];
      if(components.reports)components.reports(target,reports);else for(const report of reports){const item=document.createElement('p');item.textContent=report.title;target.append(item);}
    }
  }
  return applyScopedCss(container,page.css);
}
