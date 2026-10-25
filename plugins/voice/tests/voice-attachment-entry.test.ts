import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createDefaultVoiceViewState } from "../src/data";
import { createVoiceChatDetail } from "../src/voice-chat-detail";
import { setVoiceLocale, voiceLocale } from "../src/voice-i18n";
import type { VoiceTextAttachment } from "../src/voice-attachment-content";
let ownsDom=false;
beforeAll(()=>{if(typeof document==='undefined'){GlobalRegistrator.register();ownsDom=true;}});
afterAll(()=>{if(ownsDom)GlobalRegistrator.unregister();});
let previousLocale: 'zh' | 'en';
beforeEach(()=>{previousLocale=voiceLocale();setVoiceLocale('zh');});
afterEach(()=>setVoiceLocale(previousLocale));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function file(name:string, content:string, read?:()=>Promise<ArrayBuffer>):File {
 const bytes=new TextEncoder().encode(content);
 return {name,type:'text/plain',size:bytes.length,arrayBuffer:read??(async()=>bytes.buffer)} as File;
}
function mount(initialFormats: readonly import("../src/voice-attachment-admission").VoiceAttachmentFormat[] = ["text"], commandId = "voice.command.agent", rejectCache = false){
 let formatReads = 0;
 let supported = initialFormats;
 const root=document.createElement('div');
 const state=createDefaultVoiceViewState({commandHistory:[{id:'synthetic',commandId,transcript:'Synthetic',status:'completed',createdAt:'2026-10-02T00:00:00Z',reply:'Synthetic'}]});
 const sent:{text:string;files:readonly import("../src/voice-attachment-input").PreparedVoiceAttachment[]}[]=[];
 const el=(tag:any,cl:string)=>{const node=document.createElement(tag);node.className=cl;return node;};
 const detail=createVoiceChatDetail({attachmentFormats:()=>{formatReads++; if(rejectCache) throw new Error("synthetic attachment cache unavailable"); return supported;},getState:()=>state,getSelectedId:()=> 'synthetic',setSelectedId(){},isActive:()=>true,render(){root.replaceChildren();detail.mount(root);},actions:{async onSendCommandFollowUp(text,conversation,files=[]){sent.push({text,files});return 'next';},async onDictateDraft(){return{phase:'listening'};},async onDictationResultConsumed(){},async onDictateCancel(){},async onInstallBrowserWebAccessAndRetry(){}},legacyBackButton:()=>null,diagnostics:{block:()=>el('div',''),error:()=>el('div',''),since:()=>({sinceMs:0,sinceObserved:true})},el,textEl(tag,cl,text){const node=el(tag,cl);node.textContent=text;return node;}});
 detail.mount(root);
 return {root,detail,sent,formatReads:()=>formatReads,setCommand(command:string){state.commandHistory[0]!.commandId=command;root.replaceChildren();detail.mount(root);},setFormats(formats: readonly import("../src/voice-attachment-admission").VoiceAttachmentFormat[]){supported=formats;root.replaceChildren();detail.mount(root);},select(files:File[]){const input=root.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{configurable:true,value:files});input.dispatchEvent(new Event('change'));},send(){root.querySelector<HTMLInputElement>('.chat-input')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}};
}
test('plus is enabled and synchronously clicks the multiple-file picker',()=>{
 const h=mount();try{const picker=h.root.querySelector<HTMLInputElement>('input[type=file]')!;let clicks=0;picker.addEventListener('click',()=>clicks++);h.root.querySelector<HTMLButtonElement>('.chat-attach')!.click();expect(clicks).toBe(1);expect(picker.multiple).toBeTrue();}finally{h.detail.reset();}
});
test('pending read blocks dispatch; ready files enter follow-up; cancel selection preserves draft',async()=>{
 const h=mount();try{const input=h.root.querySelector<HTMLInputElement>('.chat-input')!;input.value='summarize';input.dispatchEvent(new Event('input'));h.select([]);expect(input.value).toBe('summarize');let resolve!:(v:ArrayBuffer)=>void;h.select([file('synthetic.txt','MARKER',()=>new Promise(r=>resolve=r))]);expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.disabled).toBeTrue();h.send();expect(h.sent).toHaveLength(0);resolve(new TextEncoder().encode('MARKER').buffer as ArrayBuffer);await tick();expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.disabled).toBeFalse();h.send();await tick();expect(h.sent[0]).toMatchObject({text:'summarize',files:[{name:'synthetic.txt',content:'MARKER'}]});expect(h.root.querySelectorAll('.chat-draft-file')).toHaveLength(0);}finally{h.detail.reset();}
});
test('reset aborts pending preparation and drops late results from the departed conversation',async()=>{
 const h=mount();try{let resolve!:(v:ArrayBuffer)=>void;h.select([file('synthetic.txt','OLD',()=>new Promise(r=>resolve=r))]);h.detail.reset();h.root.replaceChildren();h.detail.mount(h.root);resolve(new TextEncoder().encode('OLD').buffer as ArrayBuffer);await tick();expect(h.root.querySelectorAll('.chat-draft-file')).toHaveLength(0);expect(h.sent).toHaveLength(0);}finally{h.detail.reset();}
});
test('read failure follows locale; removing permits selecting the same file again',async()=>{
 const h=mount();try{h.select([file('retry.txt','data',async()=>{throw new Error('synthetic read failure');})]);await tick();expect(h.root.textContent).toContain('文件读取失败');setVoiceLocale('en');expect(h.root.textContent).toContain('Could not read the file');expect(h.root.querySelector<HTMLButtonElement>('.chat-draft-file-remove')!.getAttribute('aria-label')).toBe('Remove retry.txt');h.root.querySelector<HTMLButtonElement>('.chat-draft-file-remove')!.click();h.select([file('retry.txt','data')]);await tick();expect(h.root.textContent).toContain('Attachment ready to send');}finally{h.detail.reset();}
});
test('five selected files fail before any preparation; no attachment is silently dropped',async()=>{
 const h=mount();try{h.select(Array.from({length:5},(_,i)=>file(`${i}.txt`,'synthetic')));await tick();expect(h.root.textContent).toContain('最多选择四个文件');expect(h.root.querySelectorAll('.chat-draft-file')).toHaveLength(0);expect(h.sent).toHaveLength(0);}finally{h.detail.reset();}
});
test('unknown model capability hides plus and blocks programmatic picker events before reading',async()=>{
 const h=mount([]);try{expect(h.root.querySelector('.chat-attach')).toBeNull();let reads=0;h.select([file('unknown.txt','synthetic',async()=>{reads++;return new ArrayBuffer(9);})]);await tick();expect(reads).toBe(0);expect(h.root.textContent).toContain('尚未确认当前 Agent 模型的附件支持能力');expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.disabled).toBeTrue();h.send();expect(h.sent).toHaveLength(0);}finally{h.detail.reset();}
});
test('synthetic policy revocation while reading cannot produce a ready attachment',async()=>{
 const h=mount(['text']);try{let resolve!:(v:ArrayBuffer)=>void;h.select([file('pending.txt','OLD',()=>new Promise(r=>resolve=r))]);h.setFormats([]);resolve(new TextEncoder().encode('OLD').buffer as ArrayBuffer);await tick();expect(h.root.querySelector('.chat-attach')).toBeNull();expect(h.root.textContent).toContain('尚未确认当前 Agent 模型的附件支持能力');h.send();expect(h.sent).toHaveLength(0);}finally{h.detail.reset();}
});
test('synthetic ready attachment is rejected at send if its format is no longer admitted',async()=>{
 const h=mount(['text']);try{h.select([file('ready.txt','OLD')]);await tick();const input=h.root.querySelector<HTMLInputElement>('.chat-input')!;input.value='summarize';input.dispatchEvent(new Event('input'));h.setFormats([]);h.send();await tick();expect(h.sent).toHaveLength(0);expect(h.root.textContent).toContain('尚未确认当前 Agent 模型的附件支持能力');expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.value).toBe('summarize');}finally{h.detail.reset();}
});
test('synthetic text-only admission cannot use the PDF extraction path',async()=>{
 const h=mount(['text']);try{let reads=0;h.select([file('document.pdf','%PDF-1.7',async()=>{reads++;return new ArrayBuffer(8);})]);await tick();expect(reads).toBe(0);expect(h.root.textContent).toContain('尚未确认当前 Agent 模型的附件支持能力');expect(h.sent).toHaveLength(0);}finally{h.detail.reset();}
});

for(const command of ["voice.command.translate","polish","summary","unknown"]){
 test(`non-task ${command} has no plus or picker and never requests attachment capabilities`,()=>{
  const h=mount(["text","pdf","xlsx","xls"],command,true);try{expect(h.root.querySelector(".chat-attach")).toBeNull();expect(h.root.querySelector('input[type=file]')).toBeNull();expect(h.formatReads()).toBe(0);const input=h.root.querySelector<HTMLInputElement>(".chat-input")!;expect(input.disabled).toBeFalse();input.value="plain translation text";input.dispatchEvent(new Event("input"));h.send();expect(h.sent[0]).toMatchObject({text:"plain translation text",files:[]});}finally{h.detail.reset();}
 });
}
test("task to translation cancels pending file read, removes chooser/card/handler and ignores old chooser events",async()=>{
 const h=mount(["text"]);try{let resolve!:(v:ArrayBuffer)=>void;let lateReads=0;const oldPicker=h.root.querySelector<HTMLInputElement>('input[type=file]')!;h.select([file("pending.txt","TASK_ONLY",()=>new Promise(r=>resolve=r))]);h.setCommand("voice.command.translate");expect(h.root.querySelector(".chat-attach")).toBeNull();expect(h.root.querySelector('input[type=file]')).toBeNull();expect(h.root.querySelectorAll(".chat-draft-file")).toHaveLength(0);Object.defineProperty(oldPicker,"files",{configurable:true,value:[file("late.txt","LATE",async()=>{lateReads++;return new ArrayBuffer(4);})]});oldPicker.dispatchEvent(new Event("change"));resolve(new TextEncoder().encode("TASK_ONLY").buffer as ArrayBuffer);await tick();expect(lateReads).toBe(0);expect(h.root.querySelectorAll(".chat-draft-file")).toHaveLength(0);const input=h.root.querySelector<HTMLInputElement>(".chat-input")!;expect(input.disabled).toBeFalse();input.value="translate only";input.dispatchEvent(new Event("input"));h.send();expect(h.sent[0]).toMatchObject({text:"translate only",files:[]});}finally{h.detail.reset();}
});

function preparedHarness(){
 const root=document.createElement('div');const state=createDefaultVoiceViewState({commandHistory:[{id:'prepared',commandId:'voice.command.agent',transcript:'synthetic',status:'completed',createdAt:'2026-10-03T00:00:00Z',agentSessionId:'agent2-synthetic'}]});
 const target=(revision=1)=>({sessionId:'agent2-synthetic',ownerKey:'synthetic-owner',admission:{schemaVersion:1 as const,opaqueBinding:'a'.repeat(64),revision,modes:[]},formats:['text'] as const});
 let prepare=async()=>target();let send=async()=> 'next';let calls=0;const sent:import('../src/voice-attachment-input').PreparedVoiceAttachment[][]=[];
 const el=(tag:any,cl:string)=>{const node=document.createElement(tag);node.className=cl;return node;};
 const detail=createVoiceChatDetail({getState:()=>state,getSelectedId:()=> 'prepared',setSelectedId(){},isActive:()=>true,render(){root.replaceChildren();detail.mount(root);},actions:{onPrepareAttachments:()=>{calls++;return prepare();},async onSendCommandFollowUp(text,conversation,files=[]){sent.push([...files]);return send();},async onDictateDraft(){return{phase:'listening'};},async onDictationResultConsumed(){},async onDictateCancel(){},async onInstallBrowserWebAccessAndRetry(){}},legacyBackButton:()=>null,diagnostics:{block:()=>el('div',''),error:()=>el('div',''),since:()=>({sinceMs:0,sinceObserved:true})},el,textEl(tag,cl,text){const node=el(tag,cl);node.textContent=text;return node;}});
 detail.mount(root);
 return {root,detail,state,target,sent,calls:()=>calls,setPrepare(fn:typeof prepare){prepare=fn;},setSend(fn:typeof send){send=fn;},remount(){root.replaceChildren();detail.mount(root);},select(files:File[]){const input=root.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{configurable:true,value:files});input.dispatchEvent(new Event('change'));},send(){const input=root.querySelector<HTMLInputElement>('.chat-input')!;input.value='synthetic question';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}};
}
test('local admission is confirmed before showing plus without blocking ordinary text',async()=>{
 const h=preparedHarness();try{expect(h.root.querySelector('.chat-attach')).toBeNull();expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.disabled).toBeFalse();await tick();expect(h.root.querySelector('.chat-attach')).not.toBeNull();expect(h.calls()).toBe(1);}finally{h.detail.reset();}
});
test('departing and reopening same item invalidates a pending preparation before byte read',async()=>{
 const h=preparedHarness();try{await tick();let resolve!:(v:ReturnType<typeof h.target>)=>void;h.setPrepare(()=>new Promise(r=>resolve=r));let reads=0;h.select([file('late.txt','OLD',async()=>{reads++;return new TextEncoder().encode('OLD').buffer as ArrayBuffer;})]);h.detail.reset();h.remount();resolve(h.target());await tick();expect(reads).toBe(0);expect(h.root.querySelectorAll('.chat-draft-file')).toHaveLength(0);}finally{h.detail.reset();}
});
test('pending text cannot acquire the next model revision from another selection',async()=>{
 const h=preparedHarness();try{await tick();let resolve!:(v:ArrayBuffer)=>void;h.select([file('first.txt','OLD',()=>new Promise(r=>resolve=r))]);await tick();h.setPrepare(async()=>h.target(2));h.select([file('second.txt','NEW')]);await tick();resolve(new TextEncoder().encode('OLD').buffer as ArrayBuffer);await tick();expect(h.root.textContent).toContain('尚未确认当前 Agent 模型的附件支持能力');h.send();await tick();expect(h.sent).toHaveLength(1);expect(h.sent[0]).toHaveLength(1);expect(h.sent[0]![0]!.target?.admission.revision).toBe(1);expect(h.sent[0]![0]!.name).toBe('first.txt');}finally{h.detail.reset();}
});
test('failed send restores attachments only to the original project owner',async()=>{
 const h=preparedHarness();try{await tick();h.select([file('project-a.txt','OLD_SCOPE')]);await tick();let reject!:(v:unknown)=>void;h.setSend(()=>new Promise((_,r)=>reject=r));h.send();expect(h.sent).toHaveLength(1);h.state.conversationOptions={'agent2-synthetic':{workspace:{kind:'direct',path:'/synthetic/project-b'}}};h.remount();reject(new Error('synthetic failed admission'));await tick();expect(h.root.querySelectorAll('.chat-draft-file')).toHaveLength(0);expect(h.root.querySelector<HTMLInputElement>('.chat-input')!.value).not.toBe('synthetic question');}finally{h.detail.reset();}
});
