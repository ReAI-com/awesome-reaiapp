/**
 * Agent 功能声明的同源锁（C-AC / Host API 1.23）。
 *
 * 三件事：
 * 1. app.manifest.json 的 contributes.agentFeatures 必须等于 src/agent-features.ts
 *    的投影——改了源码忘了跑 `bun scripts/sync-agent-features.ts` 就红；
 * 2. 四处 createSession 发出的默认提示词必须能用模板 + 参数渲染出来（防「声明
 *    一套、运行时另一套」的漂移；这正是配置页拿模板当默认值的前提）；
 * 3. 模板自洽：声明的参数槽都出现在模板里（manifest 校验也会拦，这里提前报）。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  VOICE_AGENT_FEATURES,
  VOICE_SUMMARY_SYSTEM_PROMPT,
  renderAgentFeaturePrompt,
  voiceAgentFeaturesManifestProjection,
} from "../src/agent-features";
import { BASE_TOOLS, EXECUTION_TOOLS, VOICE_COMMAND_SYSTEM_PROMPT } from "../src/agent-conversation";
import { VOICE_POLISH_LEVEL_DIRECTIVES, VOICE_POLISH_PROMPT, VOICE_TRANSLATE_PROMPT } from "../src/voice-ai-prompts";
import { TRANSLATION_LANGUAGES, translationPrompt, type TranslationTarget } from "../src/voice-translation";

const manifest = JSON.parse(readFileSync(new URL("../app.manifest.json", import.meta.url), "utf8"));

test("manifest 的 agentFeatures 与源码声明一致（防漂移）", () => {
  expect(manifest.contributes.agentFeatures).toEqual(voiceAgentFeaturesManifestProjection());
});

test("翻译：模板渲染与 translationPrompt 逐字节一致（全部目标语言）", () => {
  for (const target of Object.keys(TRANSLATION_LANGUAGES) as TranslationTarget[]) {
    const language = TRANSLATION_LANGUAGES[target];
    const rendered = renderAgentFeaturePrompt("translation", { targetLanguage: language });
    expect(rendered).toBe(translationPrompt(target));
    // 三处插值点都要带上语言名。
    expect(rendered.split(language).length - 1).toBe(3);
    expect(rendered).toContain(VOICE_TRANSLATE_PROMPT.system);
  }
});

test("润色：模板渲染与旧 join 行为逐字节一致（全部档位）", () => {
  for (const [level, directive] of Object.entries(VOICE_POLISH_LEVEL_DIRECTIVES)) {
    const rendered = renderAgentFeaturePrompt("polish", { polishLevelDirective: directive });
    expect(rendered).toBe([VOICE_POLISH_PROMPT.system, directive].join("\n\n"));
  }
});

test("命令与总结：无参数模板即最终提示词；总结不锁定任何引擎（Agent 由 Host 决定）", () => {
  expect(renderAgentFeaturePrompt("command")).toBe(VOICE_COMMAND_SYSTEM_PROMPT);
  expect(renderAgentFeaturePrompt("summary")).toBe(VOICE_SUMMARY_SYSTEM_PROMPT);
  const summary = VOICE_AGENT_FEATURES.find((feature) => feature.id === "summary");
  expect(summary?.runtime).toBeUndefined();
});

test("命令功能的工具基集 = 基础 + 范围执行全集", () => {
  const command = VOICE_AGENT_FEATURES.find((feature) => feature.id === "command");
  expect(command?.toolBase).toEqual([...BASE_TOOLS, ...EXECUTION_TOOLS]);
});

test("模板自洽：声明的参数槽都出现在模板里", () => {
  for (const feature of VOICE_AGENT_FEATURES) {
    for (const param of feature.promptParams ?? []) {
      expect(feature.promptTemplate).toContain(`{${param.name}}`);
    }
  }
});

test("withVoiceFeatureRef 附带 featureParams；声明了参数槽却缺值直接抛错", async () => {
  const { withVoiceFeatureRef, noteHostAgentBackendStatuses, resetFeatureRefSupportForTests } =
    await import("../src/agent-features");
  resetFeatureRefSupportForTests();
  noteHostAgentBackendStatuses([{ backend: "pi", capabilities: { configuration: { featureRef: true } } }] as never);
  const base: Record<string, unknown> = { schemaVersion: 2, systemPrompt: "x" };

  const withParams = await withVoiceFeatureRef({ ...base }, "translation", { targetLanguage: "English" });
  expect(withParams).toEqual({ ...base, featureRef: "translation", featureParams: { targetLanguage: "English" } });
  // 无参数槽的功能（command/summary）不强制参数。
  const bare = await withVoiceFeatureRef({ ...base }, "summary");
  expect(bare).toEqual({ ...base, featureRef: "summary" });
  // 声明了槽位的功能缺参数值：提前抛错（Host 渲染侧也是硬错误，别拖到会话创建）。
  await expect(withVoiceFeatureRef({ ...base }, "translation", {} as Record<string, string>)).rejects.toThrow("targetLanguage");
});

test("缺少参数值时渲染直接抛错，不产出静默空串", () => {
  expect(() => renderAgentFeaturePrompt("translation", {} as { targetLanguage?: string })).toThrow("targetLanguage");
});

test("featureRef 降级：Host 未宣传支持就不带字段，宣传了才带", async () => {
  const { hostSupportsFeatureRef, withVoiceFeatureRef, featureRefIfSupported, noteHostAgentBackendStatuses, resetFeatureRefSupportForTests } =
    await import("../src/agent-features");
  // bun 全量测试共享进程：先复位探测缓存，避免其它用例预热过本用例的「未知态」。
  resetFeatureRefSupportForTests();
  const base: Record<string, unknown> = { schemaVersion: 2, systemPrompt: "x" };

  // 无缓存 + 探测失败（client 抛错）→ 不带。
  const failing = { backends: async () => { throw new Error("bridge down"); } };
  expect(await withVoiceFeatureRef({ ...base }, "translation", failing as never)).toEqual(base);
  // 无缓存 + 没有 client/快照 → 不带（宁缺勿拒）。
  expect(await withVoiceFeatureRef({ ...base }, "translation")).toEqual(base);
  expect(featureRefIfSupported("polish")).toBeUndefined();

  // 宣传 featureRef 的快照 → 带上，且进程内缓存（同步形态也能取到）。
  const statuses = [
    { backend: "pi", capabilities: { configuration: { featureRef: true } } },
  ] as never;
  noteHostAgentBackendStatuses(statuses);
  const withRef = await withVoiceFeatureRef({ ...base }, "translation");
  expect(withRef).toEqual({ ...base, featureRef: "translation" });
  expect(featureRefIfSupported("polish")).toBe("polish");

  // 旧 Host 形态（无 configuration 或 featureRef 缺席）单独探测 → false，
  // 但已缓存为 true 后不回退（Host 版本在进程内不变）。
  const oldHost = [{ backend: "pi", capabilities: {} }] as never;
  expect(await hostSupportsFeatureRef(undefined, oldHost)).toBe(true);
});
