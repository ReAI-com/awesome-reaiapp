import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { scaffoldPlugin } from "../scripts/scaffold";
import { prepareAgentCandidate } from "../scripts/prepare-agent";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-employee-scaffold-"));
  roots.push(root);
  const template = join(root, "plugins", "template");
  mkdirSync(join(template, "src", "profiles"), { recursive: true });
  const profile = {
    schemaVersion: 1, id: "support", name: "客户支持工作台", jobTitle: "AI 客户支持专员", description: "整理工单并提出处理建议。",
    fields: [{ key: "ticket", label: "工单号", type: "text", required: true, aliases: ["工单"] }],
    agent: { prompt: "说明依据并标记未确认内容。", skills: [{ id: "triage", title: "工单分流", content: "先按影响范围排序。" }], sop: "收集证据，提出建议，等待确认。", tools: [] },
    ui: { accentColor: "#6554C0", logoText: "客", css: "", html: "" },
  };
  const manifest = {
    appId: "com.example.template", publisherId: "11111111-1111-4111-8111-111111111111", name: "模板", version: "0.1.0-dev.1",
    hostApi: { range: ">=1.2.0 <2.0.0" }, requires: { hostCapabilities: ["surface.main@1"], hardwareServices: [], appIntents: [] }, permissions: [],
    contributes: { surfaces: [{ id: "main", title: "模板" }], sidebarItems: [{ id: "employee", label: "模板" }], commands: [{ id: "com.example.template.open" }] },
  };
  writeFileSync(join(template, "app.manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(template, "package.json"), JSON.stringify({ name: "reai-template", version: manifest.version, scripts: { pack: "bun scripts/sync-release-notes.ts && reai-app pack . --out template-0.1.0-dev.1.reaiapp" }, devDependencies: { "@reai/app-sdk": "file:../../packages/sdk" }, overrides: { "@reai/app-sdk": "file:../../packages/sdk" } }));
  writeFileSync(join(template, "src", "app.ts"), 'export const appId = "com.example.template";\n');
  writeFileSync(join(template, "src", "profiles", "default-profile.json"), JSON.stringify({ ...profile, id: "old" }));
  mkdirSync(join(template, "assets"));
  writeFileSync(join(template, "assets", "sample-finance.csv"), "date,amount\n2026-10-08,1.00\n");
  writeFileSync(join(template, "assets", "uploaded-invoices.json"), "company data");
  writeFileSync(join(template, "tsconfig.json"), JSON.stringify({ compilerOptions: { resolveJsonModule: true } }));
  writeFileSync(join(template, "preview.html"), "<!doctype html><title>模板</title>");
  writeFileSync(join(template, "bun.lock"), "template lock path must not survive relocation");
  for (const dir of ["node_modules", "private", ".artifacts", "dist"]) {
    mkdirSync(join(template, dir));
    writeFileSync(join(template, dir, "company-secret.json"), "private data");
  }
  writeFileSync(join(template, "submission.identity.json"), "private identity");
  writeFileSync(join(template, ".env"), "PRIVATE_KEY=test");
  const profilePath = join(root, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  return { root, template, profile, profilePath, out: join(root, "generated", "support") };
}

describe("public plugin scaffold", () => {
  test("replaces identity and default profile, while copying static public sources", async () => {
    const f = fixture();
    await scaffoldPlugin({ templateDir: f.template, profilePath: f.profilePath, appId: "com.example.support", name: "客户支持", publisherId: "22222222-2222-4222-8222-222222222222", outDir: f.out });
    const manifest = JSON.parse(readFileSync(join(f.out, "app.manifest.json"), "utf8"));
    expect(manifest.appId).toBe("com.example.support");
    expect(manifest.publisherId).toBe("22222222-2222-4222-8222-222222222222");
    expect(manifest.name).toBe("客户支持");
    expect(manifest.contributes.commands[0].id).toBe("com.example.support.open");
    expect(manifest.contributes.sidebarItems[0].label).toBe("客户支持");
    expect(readFileSync(join(f.out, "src", "app.ts"), "utf8")).toContain("com.example.support");
    expect(readFileSync(join(f.out, "preview.html"), "utf8")).toContain("<title>客户支持 · Demo</title>");
    expect(JSON.parse(readFileSync(join(f.out, "src", "profiles", "default-profile.json"), "utf8"))).toEqual(f.profile);
    const packageJson = JSON.parse(readFileSync(join(f.out, "package.json"), "utf8"));
    const expected = `file:${relative(f.out, resolve(f.template, "../../packages/sdk"))}`;
    expect(packageJson.devDependencies["@reai/app-sdk"]).toBe(expected);
    expect(packageJson.overrides["@reai/app-sdk"]).toBe(expected);
    expect(packageJson.scripts.pack).toContain("support-0.1.0-dev.1.reaiapp");
    expect(packageJson.scripts.pack).toStartWith("bun scripts/sync-release-notes.ts &&");
    expect(existsSync(join(f.out, "assets", "sample-finance.csv"))).toBe(true);
    expect(existsSync(join(f.out, "assets", "uploaded-invoices.json"))).toBe(false);
    for (const name of ["node_modules", "private", ".artifacts", "dist", "submission.identity.json", ".env", "bun.lock"]) expect(existsSync(join(f.out, name))).toBe(false);
  });

  test("refuses an existing destination before changing its contents", async () => {
    const f = fixture();
    mkdirSync(f.out, { recursive: true });
    writeFileSync(join(f.out, "keep.txt"), "keep");
    await expect(scaffoldPlugin({ templateDir: f.template, profilePath: f.profilePath, appId: "com.example.support", name: "客户支持", publisherId: "22222222-2222-4222-8222-222222222222", outDir: f.out })).rejects.toThrow("already exists");
    expect(readFileSync(join(f.out, "keep.txt"), "utf8")).toBe("keep");
  });

  test("refuses non-profile data and identity reuse", async () => {
    const f = fixture();
    writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, password: "not-public" }));
    await expect(scaffoldPlugin({ templateDir: f.template, profilePath: f.profilePath, appId: "com.example.support", name: "客户支持", publisherId: "22222222-2222-4222-8222-222222222222", outDir: f.out })).rejects.toThrow();
    expect(existsSync(f.out)).toBe(false);
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    await expect(scaffoldPlugin({ templateDir: f.template, profilePath: f.profilePath, appId: "com.example.template", name: "客户支持", publisherId: "22222222-2222-4222-8222-222222222222", outDir: f.out })).rejects.toThrow("new app ID");
  });

  test("a generated default profile drives the real controller, table and Agent config", async () => {
    const f = fixture();
    f.profile.ui.html = "<section><h3>{{company}} 客户支持</h3><p>记录 {{recordCount}}</p></section>";
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    const templateDir = resolve(import.meta.dir, "..");
    const appId = `${JSON.parse(readFileSync(join(templateDir, "app.manifest.json"), "utf8")).appId}.scaffold-test`;
    await scaffoldPlugin({ templateDir, profilePath: f.profilePath, appId, name: "客户支持", publisherId: "22222222-2222-4222-8222-222222222222", outDir: f.out });
    const nativeCrypto = globalThis.crypto;
    if (typeof document === "undefined") GlobalRegistrator.register();
    Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true });
    const { EmployeeController } = await import(pathToFileURL(join(f.out, "src/controller.ts")).href);
    const { EmployeeRepository } = await import(pathToFileURL(join(f.out, "src/repository.ts")).href);
    const { EmployeeAgent, createDemoAgentAdapter, createHostAgentAdapter } = await import(pathToFileURL(join(f.out, "src/agent.ts")).href);
    const { mountEmployee } = await import(pathToFileURL(join(f.out, "src/view.ts")).href);
    const data = new Map<string, unknown>();
    const store = {
      async get(key: string) { return structuredClone(data.get(key)); },
      async set(key: string, value: unknown) { data.set(key, structuredClone(value)); },
      async compareAndSet(key: string, expected: unknown, value: unknown) { if (JSON.stringify(data.get(key)) !== JSON.stringify(expected)) return false; data.set(key, structuredClone(value)); return true; },
      async keys() { return [...data.keys()]; },
    };
    const controller = new EmployeeController(new EmployeeRepository(store)); await controller.init();
    expect(controller.snapshot().profile).toEqual(f.profile);
    const source = await controller.appendText({ name: "tickets.csv", text: "工单号\nT-001\n" });
    expect((await controller.processSource(source.id)).createdCount).toBe(1);
    const agent = new EmployeeAgent(controller, createDemoAgentAdapter());
    const root = document.createElement("div"); document.body.append(root);
    const view = mountEmployee(root, { controller, agent, appId, version: "0.1.0" });
    try {
      expect(root.querySelector(".ae-sidebar")?.textContent).toContain("客户支持工作台");
      expect(root.querySelector("[data-html-page]")?.textContent).toContain("记录 1");
      root.querySelector<HTMLButtonElement>('[data-page="work-board"]')!.click();
      expect(root.querySelector("table")?.textContent).toContain("工单号");
      expect(root.querySelector("table")?.textContent).toContain("T-001");
      root.querySelector<HTMLButtonElement>('[data-page="sources"]')!.click();
      expect(root.querySelector('[data-action="import-sample"]')).toBeNull();
      expect(root.querySelector('[data-action="download-csv-template"]')).not.toBeNull();
      let config: any;
      const host = createHostAgentAdapter({
        backends: async () => ({ backends: [{ available: true, capabilities: { configuration: { schemaVersions: [2] } } }] }),
        createSession: async (input: unknown) => { config = input; return { sessionId: "s1" }; },
        reportConversationOpened: async () => {},
        startTurn: async () => ({ sessionId: "s1", turnId: "t1", expired: false, result: { status: "completed", text: "工单草稿", content: [] } }),
      });
      await host.answer("生成工单回复", controller.snapshot());
      expect(config.systemPrompt).toContain(f.profile.agent.prompt);
      expect(config.systemPrompt).toContain(f.profile.agent.sop);
      expect(config.skills[0].content).toBe(f.profile.agent.skills[0]!.content);
    } finally { view.dispose(); agent.dispose(); root.remove(); }
  });
});

describe("Agent candidate", () => {
  test("writes to the ignored artifact directory and declares both grants", async () => {
    const f = fixture();
    const candidate = await prepareAgentCandidate({ templateDir: f.template, outputName: "agent-candidate" });
    expect(candidate).toBe(join(f.template, ".artifacts", "agent-candidate"));
    const manifest = JSON.parse(readFileSync(join(candidate, "app.manifest.json"), "utf8"));
    expect(manifest.hostApi.range).toBe(">=1.21.0 <2.0.0");
    expect(manifest.requires.hostCapabilities).toContain("agent.session@2");
    expect(manifest.requires.hostCapabilities).toContain("cloud.model.invoke@1");
    expect(manifest.permissions.map((p: { id: string }) => p.id)).toEqual(["agent.session@2", "cloud.model.invoke@1"]);
    expect(existsSync(join(candidate, "private"))).toBe(false);
    expect(existsSync(join(candidate, "submission.identity.json"))).toBe(false);
    expect(readFileSync(join(f.template, "app.manifest.json"), "utf8")).not.toContain("agent.session@2");
  });
});
