import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EmployeeController } from "../src/controller";
import { EmployeeRepository, type StoreLike } from "../src/repository";
import { EmployeeAgent, createDemoAgentAdapter } from "../src/agent";
import { mountEmployee } from "../src/view";
import { SAMPLE_FINANCE_CSV } from "../src/sample-data";
import { FINANCE_PROFILE } from "../src/profiles";
import type { EmployeeHtmlPage } from "../src/domain";
import type { VoicePort, VoiceResult, VoicePhase } from "../src/voice";

const nativeCrypto = globalThis.crypto;
if (typeof document === "undefined") GlobalRegistrator.register();
Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true });
class TestStore implements StoreLike {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async compareAndSet(key: string, expected: unknown, value: unknown) { if (JSON.stringify(this.data.get(key)) !== JSON.stringify(expected)) return false; this.data.set(key, structuredClone(value)); return true; }
  async keys() { return [...this.data.keys()]; }
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); });
async function fixture(profile = FINANCE_PROFILE, voice?: VoicePort) {
  const controller = new EmployeeController(new EmployeeRepository(new TestStore()), { defaultProfile: profile }); await controller.init();
  const agent = new EmployeeAgent(controller, createDemoAgentAdapter());
  const root = document.createElement("div"); document.body.append(root);
  const view = mountEmployee(root, { controller, agent, version: "0.1.0", appId: "com.reai.ai-employee", voice, changelogText: "## 0.1.0\n本地候选：可追溯的 AI 员工范式。" });
  cleanups.push(() => { view.dispose(); agent.dispose(); });
  return { controller, agent, root, view };
}
function click(root: HTMLElement, action: string) { const target = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`); if (!target) throw new Error(`Button absent: ${action}`); target.click(); }
function page(root: HTMLElement, name: string) { root.querySelector<HTMLButtonElement>(`[data-page="${name}"]`)!.click(); }
function recordPage(root: HTMLElement, controller: EmployeeController) { const board = controller.snapshot().pages.find(p => p.bindings.some(b => b.kind === "records")); if (!board) throw new Error("No configured record board"); page(root, board.id); }
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error("UI state did not change"); await new Promise(resolve => setTimeout(resolve, 10)); } }
function input(root: HTMLElement, name: string, value: string) { const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`); if (!el) throw new Error(`Field absent: ${name}`); el.value = value; }

describe("employee workbench interaction", () => {
  test("imports fictional CSV, processes it, edits cents and keeps original bytes", async () => {
    const { root, controller } = await fixture(); page(root, "sources"); input(root, "name", "demo-finance"); input(root, "text", SAMPLE_FINANCE_CSV); click(root, "append-text");
    await until(() => controller.snapshot().sources.length === 1 && root.textContent!.includes("文本资料已保存"));
    const source = controller.snapshot().sources[0]!; const original = await controller.getSource(source.id);
    click(root, `process:${source.id}`); await until(() => controller.snapshot().records.length === 5 && root.textContent!.includes("整理完成"));
    recordPage(root, controller); const record = controller.snapshot().records[0]!; click(root, `edit:${record.id}`);
    input(root, "field:amount", "58000.25"); click(root, "save-record");
    await until(() => controller.snapshot().records.find(r => r.id === record.id)?.revision === 2 && root.textContent!.includes("标准记录已保存")).catch(error => { throw new Error(`${error.message}: ${root.querySelector(".ae-dialog-error")?.textContent}; ${root.querySelector(".ae-feedback")?.textContent}`); });
    expect(controller.snapshot().records.find(r => r.id === record.id)?.values.amount).toBe(5_800_025);
    expect((await controller.getSource(source.id)).bytesBase64).toBe(original.bytesBase64);
    expect(root.querySelector("table")?.textContent).toContain("58,000.25");
  });
  test("explicit CSV text format adds the extension and mismatches preserve the draft", async () => {
    const { root, controller } = await fixture(); page(root, "sources");
    input(root, "name", "十月收支"); input(root, "text", SAMPLE_FINANCE_CSV); click(root, "append-text");
    await until(() => controller.snapshot().sources.length === 1 && root.textContent!.includes("文本资料已保存"));
    const source = controller.snapshot().sources[0]!; expect(source.name).toBe("十月收支.csv"); click(root, `process:${source.id}`);
    await until(() => controller.snapshot().records.length === 5 && root.textContent!.includes("整理完成"));
    input(root, "name", "new-data.json"); input(root, "text", SAMPLE_FINANCE_CSV); click(root, "append-text");
    await until(() => root.textContent!.includes("扩展名与所选格式不一致"));
    expect(controller.snapshot().sources).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>('[data-form="text"] [name="name"]')?.value).toBe("new-data.json");
    expect(root.querySelector<HTMLTextAreaElement>('[data-form="text"] [name="text"]')?.value).toBe(SAMPLE_FINANCE_CSV);
  });
  test("shows cleaning errors and keeps invalid source pending", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "invalid.csv", text: "日期,收支,金额,对方\n2026-10-01,收入,bad,示例客户\n" });
    page(root, "sources"); click(root, `process:${source.id}`); await until(() => root.textContent!.includes("资料未生成标准记录"));
    expect(controller.snapshot().records.length).toBe(0); expect(controller.snapshot().sources[0]?.status).toBe("pending");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("金额"); expect(root.textContent).not.toContain("整理完成。");
  });
  test("keyboard form submission shows money validation errors without changing data", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    recordPage(root, controller); const record = controller.snapshot().records[0]!; click(root, `edit:${record.id}`); input(root, "field:amount", "1.005");
    root.querySelector<HTMLFormElement>('[data-form="record"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => root.querySelector(".ae-feedback--error")?.textContent?.includes("最多两位小数") === true);
    expect(controller.snapshot().records.find(r => r.id === record.id)?.revision).toBe(1);
    expect(controller.snapshot().records.find(r => r.id === record.id)?.values.amount).toBe(record.values.amount);
  });
  test("archives and restores a derived record without removing source", async () => {
    const { root, controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    recordPage(root, controller); const record = controller.snapshot().records[0]!; click(root, `archive:${record.id}`); await until(() => root.textContent!.includes("记录已归档"));
    expect(controller.snapshot().sources).toHaveLength(1); expect(controller.snapshot().records.find(r => r.id === record.id)?.archived).toBe(true);
    click(root, `restore:${record.id}`); await until(() => root.textContent!.includes("记录已恢复"));
    expect(controller.snapshot().records.find(r => r.id === record.id)?.archived).toBe(false);
  });
  test("requires password confirmation, rejects wrong password, and changes job profile", async () => {
    const { root, controller } = await fixture(); page(root, "settings");
    input(root, "password", "demo-password-42"); input(root, "confirmPassword", "different-password-42"); click(root, "unlock");
    await until(() => root.textContent!.includes("两次输入的开发者密码不一致")); expect(controller.snapshot().passwordConfigured).toBe(false);
    input(root, "password", "demo-password-42"); input(root, "confirmPassword", "demo-password-42"); click(root, "unlock"); await until(() => root.textContent!.includes("开发模式已解锁。") && !root.textContent!.includes("正在验证"));
    click(root, "lock"); input(root, "password", "wrong-password-42"); click(root, "unlock"); await until(() => root.textContent!.includes("开发者密码不正确"));
    expect(controller.snapshot().developerUnlocked).toBe(false); expect(root.querySelector("[data-profile-json]") === null).toBe(true);
    input(root, "password", "demo-password-42"); click(root, "unlock"); await until(() => root.querySelector("[data-role]") !== null && !root.textContent!.includes("正在验证"));
    const role = root.querySelector<HTMLSelectElement>("[data-role]")!; role.value = "hr"; role.dispatchEvent(new Event("change", { bubbles: true })); await until(() => controller.snapshot().profile.id === "hr" && root.textContent!.includes("岗位已切换"));
    recordPage(root, controller); click(root, "add-record"); expect(root.querySelector(".ae-content")?.textContent).toContain("姓名"); expect(root.querySelector('[name="field:amount"]') === null).toBe(true);
  });
  test("agent supports multiple turns with source citations and saves a report", async () => {
    const { root, controller, agent } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: SAMPLE_FINANCE_CSV }); await controller.processSource(source.id);
    click(root, "agent"); input(root, "chat", "汇总当前记录"); click(root, "send-agent"); await until(() => agent.messages.length === 2 && !agent.busy);
    input(root, "chat", "按类别继续汇总"); click(root, "send-agent"); await until(() => agent.messages.length === 4 && !agent.busy);
    expect(root.querySelectorAll("[data-message-id]")).toHaveLength(4); expect(root.querySelector(".ae-chat-cards")?.textContent).toContain("ledger.csv");
    click(root, "save-analysis"); await until(() => controller.snapshot().reports.length === 1 && root.textContent!.includes("分析已保存"));
    expect(controller.snapshot().reports[0]?.kind).toBe("demo"); expect(controller.snapshot().reports[0]?.sourceIds).toContain(source.id); expect(root.querySelector('[data-action="save-analysis"]') === null).toBe(true);
  });
  test("Agent has no modal trap and Escape closes only from inside its panel", async () => {
    const { root } = await fixture(); const trigger = root.querySelector<HTMLButtonElement>('[data-action="agent"]')!; trigger.click();
    const textarea = root.querySelector<HTMLTextAreaElement>('[data-chat-input]')!; textarea.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }); textarea.dispatchEvent(tab); expect(tab.defaultPrevented).toBe(false);
    const left = root.querySelector<HTMLButtonElement>('[data-page="overview"]')!; left.focus(); left.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector<HTMLElement>(".ae-agent-panel")!.hidden).toBe(false);
    textarea.focus(); textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector<HTMLElement>(".ae-agent-panel")!.hidden).toBe(true); expect(document.activeElement === trigger).toBe(true);
  });
  test("unsafe source names and agent content remain inert text", async () => {
    const { root, controller, agent } = await fixture(); await controller.appendText({ name: '<img onerror="alert(1)">.txt', text: "事实资料" }); page(root, "sources");
    expect(root.querySelector("img") === null).toBe(true); expect(root.textContent).toContain('<img onerror="alert(1)">.txt');
    agent.messages.push({ id: "inert", role: "assistant", text: "<script>window.evil=true</script>", sourceIds: [] }); click(root, "agent");
    expect(root.querySelector("script") === null).toBe(true); expect(root.querySelector("[data-message-id]")?.textContent).toContain("<script>");
  });
  test("job HTML boards bind current data and update after a record edit", async () => {
    const dashboard: EmployeeHtmlPage = { id: "dashboard", title: "客户经营", html: "<section><h2>客户经营</h2><p>收入 {{revenue}}</p><div data-binding=\"rows\"></div></section>", css: "", bindings: [{ id: "revenue", kind: "sum", field: "amount", filters: [{ field: "direction", operator: "eq", value: "收入" }] }, { id: "rows", kind: "records", columns: ["counterparty", "amount"] }] };
    const {root,controller}=await fixture({...FINANCE_PROFILE,ui:{...FINANCE_PROFILE.ui, dashboard, pages:[]}});
    const source=await controller.appendText({name:"finance.csv",text:SAMPLE_FINANCE_CSV});await controller.processSource(source.id);
    expect(root.querySelector("[data-html-page]")?.textContent).toContain("82,000.00");
    const income=controller.snapshot().records.find(r=>r.values.direction==="收入")!;await controller.editRecord(income.id,{amount:(income.values.amount as number)+10000},income.revision);
    expect(root.querySelector("[data-html-page]")?.textContent).toContain("82,100.00");
    expect(root.querySelector("thead")?.textContent).toContain("对方"); expect(root.querySelector("thead")?.textContent).not.toContain("分类");
  });
  test("binary source details disclose missing extraction in the left work area", async () => {
    const { root, controller } = await fixture();
    const source = await controller.importBytes({ name: "source.pdf", bytes: new TextEncoder().encode("%PDF-1.7 fictional"), mimeType: "application/pdf" }); page(root, "sources"); click(root, `source:${source.id}`);
    await until(() => root.querySelector(".ae-source-content") !== null);
    expect(root.querySelector(".ae-source-content")!.textContent).toContain("二进制原件"); expect(root.querySelector(".ae-source-content")!.textContent).toContain("Demo 暂不执行 OCR");
  });
  test("version and about open precise local candidate details", async () => {
    const { root } = await fixture(); page(root, "settings"); click(root, "version"); expect(root.querySelector(".ae-content")?.textContent).toContain("可追溯的 AI 员工范式");
    click(root, "back"); click(root, "about");
    expect(root.querySelector(".ae-content")?.textContent).toContain("本地 Demo 候选");
    expect(root.querySelector<HTMLInputElement>('[aria-label="公开应用详情地址"]')?.value).toBe("https://open.reai.com/apps/com.reai.ai-employee");
  });
});

describe("persistent two pane workspace", () => {
  test("navigation contains only configured boards, with upload and settings at the bottom", async () => {
    const { root } = await fixture();
    expect(root.querySelector('[data-action="to-sources"]') === null).toBe(true);
    expect(root.textContent).not.toContain("从事实到决策");
    expect(root.textContent).not.toContain("三阶段范式");
    expect(root.querySelector('.ae-navigation-foot [data-page="sources"]') !== null).toBe(true);
    expect(root.querySelector('.ae-navigation-foot [data-page="settings"]') !== null).toBe(true);
    expect(root.querySelector('.ae-navigation [data-page="records"]') === null).toBe(true);
    expect(root.querySelector('.ae-navigation [data-page="reports"]') === null).toBe(true);
  });
  test("sidebar plus opens one Agent and fills the exact draft without sending", async () => {
    const { root, agent } = await fixture(); click(root, "add-page");
    expect(root.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.value).toBe("我想要查看侧边栏增加一个……，我的要求是：");
    expect(agent.messages).toHaveLength(0); expect(agent.busy).toBe(false);
    expect(root.querySelector('.ae-agent-panel')?.getAttribute('role')).toBe('region');
  });
  test("left navigation stays interactive while Agent is open", async () => {
    const { root } = await fixture(); click(root, "agent"); page(root, "settings");
    expect(root.querySelector('.ae-agent-panel') !== null).toBe(true);
    expect(root.querySelector('.ae-content')?.textContent).toContain("公司名称");
    expect(root.querySelector('[inert]') === null).toBe(true); expect(root.querySelector('[aria-modal="true"]') === null).toBe(true);
  });
  test("closing and reopening preserves the same conversation and composer draft", async () => {
    const { root, agent } = await fixture(); click(root, "agent");
    input(root, "chat", "汇总当前记录"); click(root, "send-agent"); await until(() => agent.messages.length === 2 && !agent.busy);
    input(root, "chat", "下一项尚未发送的任务"); root.querySelector('[data-chat-input]')!.dispatchEvent(new Event('input', {bubbles:true}));
    click(root, "close-agent"); click(root, "agent");
    expect(agent.messages).toHaveLength(2); expect(root.querySelectorAll('[data-message-id]')).toHaveLength(2);
    expect(root.querySelector<HTMLTextAreaElement>('[data-chat-input]')!.value).toBe("下一项尚未发送的任务");
  });
  test("chat source cards open in the left area without replacing the conversation", async () => {
    const { root, controller, agent } = await fixture(); const source = await controller.appendText({name:'ledger.csv',text:SAMPLE_FINANCE_CSV}); await controller.processSource(source.id);
    click(root, "agent"); input(root, "chat", "汇总当前记录"); click(root, "send-agent"); await until(() => agent.messages.length === 2 && !agent.busy);
    root.querySelector<HTMLButtonElement>(`.ae-agent-panel [data-source="${source.id}"]`)!.click();
    await until(() => root.querySelector('.ae-content .ae-source-content') !== null);
    expect(root.querySelector('.ae-agent-panel')?.textContent).toContain('汇总当前记录');
    expect(root.querySelectorAll('[data-message-id]')).toHaveLength(2);
    expect(root.querySelector('.ae-content')?.textContent).toContain(source.sha256);
  });
});


describe("generated boards and linked output", () => {
  test("confirms an Agent page without developer mode and reads live records", async () => {
    const { root, controller, agent } = await fixture();
    const source = await controller.appendText({name:"ledger.csv",text:SAMPLE_FINANCE_CSV}); await controller.processSource(source.id);
    click(root,"add-page"); input(root,"chat","我想要查看侧边栏增加一个……，我的要求是：新增一个待补票页面，显示缺少发票的支出，列出对方和金额"); click(root,"send-agent");
    await until(() => !agent.busy && agent.messages.some(m => !!m.pageProposal));
    const proposalMessage = agent.messages.find(m => m.pageProposal)!;
    expect(controller.snapshot().pages).toHaveLength(3); expect(controller.snapshot().developerUnlocked).toBe(false);
    expect(root.querySelector(".ae-page-proposal")?.textContent).toContain("待补票页面");
    click(root,`confirm-page:${proposalMessage.id}`);
    await until(() => controller.snapshot().pages.length === 4 && root.textContent!.includes("看板已添加"));
    const savedId = proposalMessage.pageId!;
    expect(root.querySelector('[aria-current="page"]')?.getAttribute("data-page")).toBe(savedId);
    expect(root.querySelector(".ae-content table")?.textContent).toContain("示例供应商");
    expect(root.querySelector(".ae-content table")?.textContent).not.toContain("示例办公室");
    expect(root.querySelector<HTMLElement>(".ae-agent-panel")!.hidden).toBe(false);
    const record = controller.snapshot().records.find(r => r.values.counterparty === "示例供应商")!;
    await controller.editRecord(record.id,{amount:370000},record.revision);
    expect(root.querySelector(".ae-content table")?.textContent).toContain("3,700.00");
    page(root,"overview"); click(root,`open-page:${savedId}`);
    expect(root.querySelector('[aria-current="page"]')?.getAttribute("data-page")).toBe(savedId);
    expect(agent.messages).toHaveLength(2);
  });
  test("saved report cards open left and preserve the current draft", async () => {
    const { root, controller, agent } = await fixture(); const source=await controller.appendText({name:"ledger.csv",text:SAMPLE_FINANCE_CSV}); await controller.processSource(source.id);
    click(root,"agent"); input(root,"chat","生成收支汇总"); click(root,"send-agent"); await until(() => agent.messages.length===2 && !agent.busy);
    click(root,"save-analysis"); await until(() => controller.snapshot().reports.length===1 && agent.messages.some(m => !!m.reportIds?.length));
    input(root,"chat","后续任务尚未发送"); root.querySelector("[data-chat-input]")!.dispatchEvent(new Event("input",{bubbles:true}));
    const report=controller.snapshot().reports[0]!;
    root.querySelector<HTMLButtonElement>(`.ae-agent-panel [data-action="report:${report.id}"]`)!.click();
    expect(root.querySelector(".ae-content")?.textContent).toContain(report.body);
    expect(root.querySelector<HTMLElement>(".ae-agent-panel")!.hidden).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>("[data-chat-input]")!.value).toBe("后续任务尚未发送");
    expect(agent.messages).toHaveLength(2);
  });
  test("arbitrary job configuration controls navigation, columns and dashboard", async () => {
    const dashboard:EmployeeHtmlPage={id:"dashboard",title:"客服总览",html:"<h2>{{role}}</h2><p>待办 {{openCount}}</p>",css:"",bindings:[{id:"openCount",kind:"count",filters:[{field:"state",operator:"eq",value:"待处理"}]}]};
    const board:EmployeeHtmlPage={id:"service-queue",title:"服务事项",html:'<h2>当前事项</h2><div data-binding="queue"></div>',css:"",bindings:[{id:"queue",kind:"records",columns:["subject","state"]}]};
    const {root,controller}=await fixture({...FINANCE_PROFILE,id:"support-demo",name:"客服工作台",jobTitle:"客服专员",fields:[{key:"subject",label:"事项",type:"text",required:true,aliases:[]},{key:"state",label:"进度",type:"select",required:true,aliases:[],options:["待处理","完成"]}],ui:{...FINANCE_PROFILE.ui,logoText:"CS",dashboard,pages:[board]}});
    await controller.addRecord({subject:"示例咨询",state:"待处理"});
    expect(root.querySelector("[data-html-page]")?.textContent).toContain("待办 1");
    expect(root.querySelector(".ae-brand-logo")?.textContent).toBe("CS");
    expect(root.querySelector('[data-page="service-queue"]')?.textContent).toContain("服务事项");
    expect(root.querySelector('[data-page="income-board"]') === null).toBe(true);
    page(root,"service-queue"); expect(root.querySelector("thead")?.textContent).toContain("事项"); expect(root.querySelector("thead")?.textContent).not.toContain("金额");
    const record=controller.snapshot().records[0]!; click(root,`edit:${record.id}`); input(root,"field:state","完成"); click(root,"save-record");
    await until(() => controller.snapshot().records[0]?.values.state === "完成"); page(root,"overview");
    expect(root.querySelector("[data-html-page]")?.textContent).toContain("待办 0");
  });
});

class FakeVoice implements VoicePort {
  available=true; phase:VoicePhase="idle"; error?:string; cancelCount=0;
  private listeners=new Set<()=>void>(); private resolve?: (value:VoiceResult)=>void;
  subscribe(fn:()=>void){this.listeners.add(fn);fn();return()=>this.listeners.delete(fn);}
  private emit(){for(const fn of this.listeners)fn();}
  start():Promise<VoiceResult>{this.phase="listening";this.emit();return new Promise(resolve=>{this.resolve=resolve;});}
  async finish(){this.phase="processing";this.emit();}
  async cancel(){++this.cancelCount;this.phase="cancelled";this.emit();}
  complete(text:string){this.phase="completed";this.emit();this.resolve?.({requestId:"fixture-voice",text,kind:"raw"});}
  dispose(){this.listeners.clear();}
}

describe("Voice composer integration", () => {
  test("voice intent opens the same Agent and fills an unsent draft", async () => {
    const voice=new FakeVoice(); const {root,view,agent}=await fixture(FINANCE_PROFILE,voice);
    const main=root.querySelector(".ae-main-body"); const pending=view.startVoice();
    await until(() => voice.phase === "listening"); expect(root.querySelector('[data-action="finish-voice"]') !== null).toBe(true);
    page(root,"settings"); expect(root.querySelector(".ae-content")?.textContent).toContain("公司名称");
    click(root,"finish-voice"); await until(() => voice.phase === "processing");
    voice.complete("语音识别后的未发送任务"); await pending;
    expect(root.querySelector(".ae-main-body")).toBe(main);
    expect(root.querySelector<HTMLTextAreaElement>("[data-chat-input]")!.value).toBe("语音识别后的未发送任务");
    expect(agent.messages).toHaveLength(0); expect(root.querySelectorAll("[data-message-id]")).toHaveLength(0);
  });
  test("closing cancels voice and ignores a late result after reopening", async () => {
    const voice=new FakeVoice(); const {root,view,agent}=await fixture(FINANCE_PROFILE,voice); click(root,"agent");
    input(root,"chat","需要保留的草稿"); root.querySelector("[data-chat-input]")!.dispatchEvent(new Event("input",{bubbles:true}));
    const pending=view.startVoice(); await until(() => voice.phase === "listening"); click(root,"close-agent"); expect(voice.cancelCount).toBe(1);
    click(root,"agent"); voice.complete("已经关闭的录音结果"); await pending;
    expect(root.querySelector<HTMLTextAreaElement>("[data-chat-input]")!.value).toBe("需要保留的草稿"); expect(agent.messages).toHaveLength(0);
  });
  test("unavailable voice has a disabled button and does not simulate recognition", async () => {
    const voice=new FakeVoice(); voice.available=false; voice.error="浏览器未连接 Voice 服务";
    const {root,view,agent}=await fixture(FINANCE_PROFILE,voice); click(root,"agent");
    expect(root.querySelector(".ae-agent-panel [role=alert]") === null).toBe(true);
    const microphone=root.querySelector<HTMLButtonElement>('[data-action="start-voice"]')!;
    expect(microphone.disabled).toBe(true); expect(microphone.title).toContain("应用中");
    await view.startVoice(); expect(root.querySelector(".ae-agent-panel [role=alert]")?.textContent).toContain("未连接 Voice"); expect(agent.messages).toHaveLength(0);
  });
});
