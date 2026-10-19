import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EmployeeController } from "../src/controller";
import { EmployeeRepository, type StoreLike } from "../src/repository";
import { createDemoAgentAdapter } from "../src/agent";
import { resolvePageBindings } from "../src/page-renderer";
import { DEFAULT_PROFILE, getDefaultPages } from "../src/profiles";
import { SAMPLE_PATENT_CSV } from "../src/sample-data";
import { jsonBytes, validateHtmlPage, validateProfile } from "../src/domain";

class TestStore implements StoreLike {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async compareAndSet(key: string, expected: unknown, value: unknown) { if (JSON.stringify(this.data.get(key)) !== JSON.stringify(expected)) return false; this.data.set(key, structuredClone(value)); return true; }
  async keys() { return [...this.data.keys()]; }
}
const root = resolve(import.meta.dir, "..");
const WORK_TYPES = ["交底书", "申请文件", "案卷会稿", "著录检索", "专利解读", "对照表", "专利地图", "审查答复", "政策简报"];

async function importedSample() {
  const controller = new EmployeeController(new EmployeeRepository(new TestStore()));
  await controller.init();
  const source = await controller.appendText({ name: "sample-patent.csv", text: SAMPLE_PATENT_CSV });
  const result = await controller.processSource(source.id);
  return { controller, result };
}

// 由本插件再生成其他岗位时，默认岗位不再是专利，专项测试自动跳过。
describe.skipIf(DEFAULT_PROFILE.id !== "patent")("patent assistant role", () => {
  test("default profile is the patent role and stays within template limits", () => {
    const profile = validateProfile(DEFAULT_PROFILE);
    expect(profile.id).toBe("patent");
    expect(profile.fields.find(field => field.key === "work_type")?.options).toEqual(WORK_TYPES);
    expect(profile.agent.skills.map(skill => skill.id)).toEqual(["patent-disclosure", "patent-application", "patent-docket", "patent-search", "patent-reader", "patent-chart", "patent-oa", "patent-exam-policy"]);
    expect(profile.agent.tools).toEqual([]);
    expect(jsonBytes({ prompt: profile.agent.prompt, sop: profile.agent.sop, skills: profile.agent.skills })).toBeLessThan(60 * 1024);
    for (const workType of WORK_TYPES) expect(profile.agent.prompt).toContain(workType);
    const skill = (id: string) => profile.agent.skills.find(entry => entry.id === id)!.content;
    expect(skill("patent-disclosure")).toContain("连出发点都钉不住的，才写「D1=未钉住」");
    expect(skill("patent-disclosure")).toContain("不默认补齐六视图");
    expect(skill("patent-application")).toContain("外观设计单独处理");
    expect(skill("patent-docket")).toContain("记为第 1 轮");
    expect(skill("patent-search")).toContain("你看不到图片原件");
  });

  test("every default board validates against the patent fields", () => {
    const { dashboard, pages } = getDefaultPages(DEFAULT_PROFILE);
    expect(dashboard.title).toBe("专利工作台");
    expect(pages.map(page => page.title)).toEqual(["专利挖掘与交底", "申请文件", "案卷会稿", "审查答复", "检索与解读", "对照表", "专利地图", "政策简报", "自检与待补"]);
    validateHtmlPage(dashboard, DEFAULT_PROFILE, { dashboard: true });
    for (const page of pages) validateHtmlPage(page, DEFAULT_PROFILE);
  });

  test("bundled sample mirrors the asset file and covers all nine work types", () => {
    expect(SAMPLE_PATENT_CSV).toBe(readFileSync(resolve(root, "assets/sample-patent.csv"), "utf8"));
    // 署名与许可全文必须放在会进安装包的 assets/ 下。
    const notice = readFileSync(resolve(root, "assets/NOTICE.md"), "utf8");
    expect(notice).toContain("Copyright (c) 2026 handsomestWei");
    expect(notice).toContain("The above copyright notice and this permission notice shall be included");
    for (const workType of WORK_TYPES) expect(SAMPLE_PATENT_CSV).toContain(`,${workType},`);
  });

  test("fictional sample imports without issues and drives the boards", async () => {
    const { controller, result } = await importedSample();
    expect(result.issues).toEqual([]);
    expect(result.createdCount).toBe(10);
    const state = controller.snapshot();
    const dashboard = resolvePageBindings(state.dashboard, state);
    expect(dashboard.values).toMatchObject({ doing: "3", review: "3", issues: "3", done: "2", cases: "9" });
    expect(dashboard.records.pending?.map(record => record.values.item_id)).toEqual(["PT-DEMO-002", "PT-DEMO-007", "PT-DEMO-009"]);
    const board = (id: string) => resolvePageBindings(state.pages.find(page => page.id === id)!, state);
    expect(board("disclosure-board").values).toMatchObject({ total: "2", issues: "1" });
    expect(board("oa-board").records.items?.[0]?.values).toMatchObject({ item_id: "PT-DEMO-009", deadline: "2026-11-08" });
    expect(board("docket-board").records.items?.[0]?.values).toMatchObject({ round: 2, patent_type: "外观设计" });
    expect(board("check-board").records.unchecked?.length).toBe(4);
    expect(board("map-board").values.read).toBe("1");
  });

  test("blank self-check and unfinished readings are not miscounted", async () => {
    const { controller } = await importedSample();
    const reading = controller.snapshot().records.find(record => record.values.item_id === "PT-DEMO-006")!;
    await controller.editRecord(reading.id, { status: "待开始" }, reading.revision);
    await controller.addRecord({ item_id: "PT-DEMO-011", case_name: "示例新增事项", work_type: "交底书", status: "待开始" });
    const state = controller.snapshot();
    const board = (id: string) => resolvePageBindings(state.pages.find(page => page.id === id)!, state);
    expect(board("map-board").values.read).toBe("0");
    expect(board("check-board").records.blank?.map(record => record.values.item_id)).toEqual(["PT-DEMO-011"]);
  });

  test("demo analysis reports patent work counts without claiming a model", async () => {
    const { controller } = await importedSample();
    const answer = await createDemoAgentAdapter().answer("汇总在办专利事项", controller.snapshot());
    expect(answer.text).toContain("没有调用大模型");
    expect(answer.text).toContain("工作类型：审查答复 1 条");
    expect(answer.text).toContain("状态：待人确认 3 条");
    expect(answer.recordRefs.length).toBe(10);
  });
});
