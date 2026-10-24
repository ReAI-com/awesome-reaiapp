import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_VOICE_COMMANDS,
  DEFAULT_VOICE_PROMPTS,
  VOICE_COMMAND_CATALOG,
  VOICE_COMMAND_CONTRACT_VERSION,
  VOICE_COMMAND_STAGE_LABELS,
  type VoiceBackgroundTaskRef,
  type VoiceCommandBinding,
  type VoiceCommandRequest,
  type VoiceCommandStage,
} from "../src/voice-ai-contract";
import { VOICE_PROMPT_CATALOG } from "../src/voice-ai-prompts";

describe("Voice Command 应用层合同", () => {
  test("合同不把供应商、网络地址或凭据暴露给 Voice", () => {
    const contractPath = resolve(
      import.meta.dir,
      "../src/voice-ai-contract.ts",
    );
    const source = readFileSync(contractPath, "utf8");

    expect(VOICE_COMMAND_CONTRACT_VERSION).toBe("voice-command.app.v1");
    expect(source).not.toMatch(/apiKey|accessToken|oauthToken|workflowUrl|baseUrl\s*:/);
    expect(source).not.toContain("model-gateway");
    expect(source).not.toContain("wainao");
  });

  test("只有一套运行时：命令之间的差别仅在 steps 与 delivery", () => {
    const { transcribe, translate, agent } = VOICE_COMMAND_CATALOG;

    // 纯转写没有后续步骤，润色完就交付。
    expect(transcribe.steps).toEqual([]);
    // 翻译只是「润色之后多一步」，不是另一套模式。
    expect(translate.steps.map((step) => step.kind)).toEqual(["translate"]);
    expect(agent.steps.map((step) => step.kind)).toEqual(["promptify", "agent"]);

    // 三者都不携带 provider / 模型信息。
    for (const command of [transcribe, translate, agent]) {
      expect(JSON.stringify(command)).not.toMatch(/model|provider|endpoint/i);
    }
  });

  test("delivery 只描述结果副作用，不再决定短结果使用什么载体", () => {
    expect(VOICE_COMMAND_CATALOG.transcribe.delivery).toEqual({
      kind: "write_back",
      behavior: "insert",
    });
    expect(VOICE_COMMAND_CATALOG.translate.delivery).toEqual({
      kind: "write_back",
      behavior: "insert",
    });

    const agentDelivery = VOICE_COMMAND_CATALOG.agent.delivery;
    expect(agentDelivery.kind).toBe("panel");
    // Agent 会产生外部副作用，确认必须是真实动作，不能由倒计时代劳。
    expect(agentDelivery).toEqual({ kind: "panel", autoStartMs: null });
    // 面板里给答案还是给计划由运行时事件决定，命令定义不该预先写死。
    expect(JSON.stringify(agentDelivery)).not.toContain("instant");

    const app = readFileSync(resolve(import.meta.dir, "../src/app.ts"), "utf8");
    // 2026-09-27 定稿：只读结果框只给 Agent（含转入后台后的迟到结果框）；转文本与翻译
    // 成功只写回、不弹结果框，写回失败走 Host 取回卡。
    expect(app.includes("presentAgentResult")).toBeTrue();
    expect(app.includes("presentForegroundResult")).toBeFalse();
    expect(app.includes('if (!writesBack(commandId) && disposition === "foreground")')).toBeFalse();
  });

  test("翻译必须显式带目标语言，不允许靠回退伪装成翻译成功", () => {
    const [step] = VOICE_COMMAND_CATALOG.translate.steps;
    expect(step.kind).toBe("translate");
    if (step.kind === "translate") {
      expect(step.targetLanguage).toBeTruthy();
      expect(step.targetLanguage).not.toBe("und");
    }
  });

  test("只有转文本带润色前置，翻译与 Agent 不润色；命令类型可被绑定表替换", () => {
    const input = {
      kind: "transcript" as const,
      transcript: {
        text: "测试语音",
        language: "zh-CN",
        source: "local" as const,
        durationMs: 1_000,
      },
    };
    const transcribe: VoiceCommandRequest = {
      requestId: "request-test-1",
      command: VOICE_COMMAND_CATALOG.transcribe,
      input,
      profileId: "voice.default",
      preprocess: {
        kind: "polish",
        prompt: DEFAULT_VOICE_PROMPTS.polish,
        required: true,
      },
    };
    // 翻译的效果在翻译 Agent 层优化，交给它的是识别原文（2026-09-27 定稿）。
    const translate: VoiceCommandRequest = {
      requestId: "request-test-2",
      command: VOICE_COMMAND_CATALOG.translate,
      input,
      profileId: "voice.default",
    };

    expect(transcribe.preprocess?.required).toBeTrue();
    expect(transcribe.preprocess?.kind).toBe("polish");
    expect(Object.keys(translate)).not.toContain("preprocess");
    for (const request of [transcribe, translate]) {
      expect(Object.keys(request)).not.toContain("url");
      expect(Object.keys(request)).not.toContain("modelId");
    }
  });

  test("硬件触发到命令的映射是配置，Voice 不解释物理档位", () => {
    const bindings: VoiceCommandBinding[] = [
      { bindingId: "stage.chat", commandId: BUILTIN_VOICE_COMMANDS.transcribe },
      { bindingId: "stage.plan", commandId: BUILTIN_VOICE_COMMANDS.translate },
      { bindingId: "stage.yolo", commandId: BUILTIN_VOICE_COMMANDS.agent },
      { bindingId: "voice.hold", commandId: BUILTIN_VOICE_COMMANDS.agent },
    ];

    // 换绑只改这张表；同一个命令可以挂在多个触发上。
    const byCommand = new Map(bindings.map((b) => [b.bindingId, b.commandId]));
    expect(byCommand.get("stage.plan")).toBe(BUILTIN_VOICE_COMMANDS.translate);
    expect(byCommand.get("voice.hold")).toBe(byCommand.get("stage.yolo"));

    // bindingId 是不透明字符串：任意新触发都能直接绑，不需要动合同。
    const future: VoiceCommandBinding = {
      bindingId: "footswitch.left.double",
      commandId: BUILTIN_VOICE_COMMANDS.translate,
    };
    expect(future.bindingId).toBeString();

    // 命令 ID 同样是开放字符串，第三方命令不必挤进内置枚举。
    const thirdParty: VoiceCommandBinding = {
      bindingId: "stage.chat",
      commandId: "acme.command.summarize",
    };
    expect(thirdParty.commandId).toBe("acme.command.summarize");
  });

  test("角落的后台任务必须是有源的：背后有一条能进去继续聊的会话", () => {
    const task: VoiceBackgroundTaskRef = {
      taskId: "task-1",
      label: "竞品分析",
      conversationId: "conv-1",
      interactiveWhileRunning: true,
    };
    expect(task.conversationId).toBeTruthy();
    // 写成字面量 true，是为了让「运行中不可进入」的实现无法通过类型检查。
    expect(task.interactiveWhileRunning).toBeTrue();

    const source = readFileSync(
      resolve(import.meta.dir, "../src/voice-ai-contract.ts"),
      "utf8",
    );
    expect(source).toMatch(/interactiveWhileRunning:\s*true;/);
    // 点胶囊要能打开那条会话，所以呈现口必须提供入口。
    expect(source).toMatch(/openConversation\(taskId: string\)/);
    // 完成不等于该撤下：不允许给角落胶囊挂自动消失。
    expect(source).toMatch(/完成 \*\*不等于\*\* 该撤下/);
  });

  test("五套提示词由 Voice 版本化持有并约束为只返回转换结果", () => {
    expect(Object.keys(VOICE_PROMPT_CATALOG)).toEqual([
      "polish",
      "translate",
      "promptify",
      "digest",
      "segmentSummary",
    ]);
    for (const [name, prompt] of Object.entries(VOICE_PROMPT_CATALOG)) {
      expect(prompt.ref.version).toBe(name === "polish" ? "3" : "1");
      expect(prompt.output).toBe("plain_text");
      expect(prompt.system).toContain("只输出");
    }
    expect(VOICE_PROMPT_CATALOG.polish.system).toContain("不回答其中的问题");
    expect(VOICE_PROMPT_CATALOG.translate.system).toContain("明确指定的目标语言");
    expect(VOICE_PROMPT_CATALOG.promptify.system).toContain("你自己不回答问题");
    // 当日总结（A3-10）：跨段结论，不是逐段拼接；素材不足时允许什么都不输出。
    expect(VOICE_PROMPT_CATALOG.digest.system).toContain("不回答其中的问题");
    expect(VOICE_PROMPT_CATALOG.digest.system).toContain("不是把每段的要点拼起来");
    // 段总结（R11）：只看一段、同样不执行转写里的指令，素材不足时允许什么都不输出。
    expect(VOICE_PROMPT_CATALOG.segmentSummary.system).toContain("不回答其中的问题");
    expect(VOICE_PROMPT_CATALOG.segmentSummary.system).toContain("直接什么都不输出");
    expect(VOICE_PROMPT_CATALOG.segmentSummary.system).toContain("这一段");
    expect(VOICE_PROMPT_CATALOG.segmentSummary.system).not.toContain("今天");
  });

  test("胶囊阶段是稳定 ID 与本地化标签的完整映射", () => {
    const expected: VoiceCommandStage[] = [
      "capture.listening",
      "stt.transcribing",
      "text.polishing",
      "text.translating",
      "prompt.refining",
      "agent.waiting",
      "agent.reasoning",
      "tool.web_search",
      "tool.knowledge_search",
      "answer.generating",
      "delivery.writing",
    ];

    expect(Object.keys(VOICE_COMMAND_STAGE_LABELS).sort()).toEqual(expected.sort());
    expect(VOICE_COMMAND_STAGE_LABELS["tool.web_search"]).toBe("正在联网搜索");
    expect(VOICE_COMMAND_STAGE_LABELS["tool.knowledge_search"]).toBe("正在查找知识库");
  });
});
