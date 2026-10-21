import { describe, expect, test } from "bun:test";
import type { AgentBackendStatus } from "@reai/app-sdk/v1";
import type { VoiceCommandHistoryItem } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";
import {
  availableConversationBackends,
  canChangeConversation,
  continuationPrompt,
  createVoiceCommandSessionConfig,
  scopeUnavailableMessage,
  visibleConversationContext,
} from "../src/agent-conversation";

const item = (overrides: Partial<VoiceCommandHistoryItem> = {}): VoiceCommandHistoryItem => ({
  id: "task-1", transcript: "查看项目", reply: "已经读到说明", status: "completed",
  createdAt: "2026-09-20T09:00:00.000Z", agentSessionId: "pi-session", ...overrides,
});

describe("Voice 的当前对话工作范围与 Agent", () => {
  test("范围错误使用本地组件更新文案，平台限制与空详情使用多语后备文案", () => {
    const status: AgentBackendStatus = {
      backend: "dsh", available: true, detail: "Update this runtime to use files and commands",
      capabilities: { hostTools: true, fileTools: false, turnModes: [], modelSelection: "host-settings", commandExecution: false },
    };
    setVoiceLocale("zh");
    expect(scopeUnavailableMessage(status, "Localized fallback")).toBe("需要更新 DSH 运行组件后才能使用文件和命令：工作范围支持缺失、不兼容或已损坏。不会自动换用其他 Agent。");
    expect(scopeUnavailableMessage({ ...status, detail: "  " }, "Localized fallback")).toBe("Localized fallback");
    expect(scopeUnavailableMessage({ ...status, capabilities: { ...status.capabilities!, fileTools: true } }, "平台暂不支持")).toBe("平台暂不支持");
    expect(scopeUnavailableMessage({ ...status, available: false }, "Localized fallback")).toBe("Localized fallback");
    expect(scopeUnavailableMessage({ ...status, downloadRequired: true }, "Localized fallback")).toBe("Localized fallback");
    expect(scopeUnavailableMessage(undefined, "Localized fallback")).toBe("Localized fallback");
  });

  test("英文界面不会直接显示 Host 中文诊断，切换语言仍保留组件更新原因和所选 Agent", () => {
    const status: AgentBackendStatus = {
      backend: "pi", available: true, downloadRequired: false,
      detail: "运行组件需要更新后才能使用文件和命令",
      capabilities: { hostTools: true, fileTools: false, turnModes: [], modelSelection: "host-settings", commandExecution: false },
    };
    const before = structuredClone(status);
    try {
      setVoiceLocale("en");
      expect(scopeUnavailableMessage(status, "Localized fallback")).toBe("Update the Pi runtime to use files and commands: its workspace support is missing, incompatible, or damaged. No other Agent will be selected automatically.");
      expect(scopeUnavailableMessage(status, "Localized fallback")).not.toMatch(/[一-鿿]/);
      setVoiceLocale("zh");
      expect(scopeUnavailableMessage(status, "本地后备文案")).toContain("需要更新 Pi 运行组件后才能使用文件和命令");
      expect(status).toEqual(before);
    } finally { setVoiceLocale("zh"); }
  });

  test("普通命令沿用默认 Agent，范围执行时明确授权 17 个工具并显式 yolo", () => {
    const config = createVoiceCommandSessionConfig({ scopedExecution: true });
    expect(config.schemaVersion).toBe(2);
    expect(config.runtime).toBe("auto");
    expect(config.workspace).toEqual({ kind: "app-private" });
    expect(config.mode).toBe("yolo");
    expect(config.memory).toBe("session");
    const tools = config.tools ?? [];
    expect(tools).toHaveLength(17);
    expect(new Set(tools.map(tool => tool.ref)).size).toBe(17);
    expect(tools.map(tool => tool.ref)).toEqual(expect.arrayContaining([
      "web_search", "web_fetch", "read", "write", "edit", "list", "glob", "grep", "command",
    ]));
    // 没有范围执行：只有 10 个 Host 工具，不显式提权到 yolo。
    const plain = createVoiceCommandSessionConfig();
    expect(plain.tools).toHaveLength(10);
    expect(plain.mode).toBeUndefined();
  });

  test("明确选择的目录使用 direct，不偷偷改成镜像或改变全局默认", () => {
    const options = { backend: "dsh" as const, workspace: { kind: "direct" as const, path: "/Users/example/Project" }, scopedExecution: true };
    const config = createVoiceCommandSessionConfig(options);
    expect(config.runtime).toBe("dsh");
    expect(config.workspace).toEqual(options.workspace);
    expect(createVoiceCommandSessionConfig().runtime).toBe("auto");
    expect(createVoiceCommandSessionConfig().workspace).toEqual({ kind: "app-private" });
  });

  test("菜单只含 Host 明确表示可用的 Agent，不展示未安装或尚未授权的选项", () => {
    const statuses: AgentBackendStatus[] = [
      { backend: "pi", available: true, downloadRequired: false, detail: "ready", capabilities: { hostTools: true, fileTools: true, turnModes: ["yolo"], modelSelection: "host-settings", scopedExecutionVersion: 1, commandExecution: true } },
      { backend: "dsh", available: false, downloadRequired: true, detail: "missing" },
      { backend: "codex", available: true, downloadRequired: true, detail: "permission required" },
    ];
    expect(availableConversationBackends(statuses)).toEqual([statuses[0]]);
    expect(statuses).toHaveLength(3);
  });

  test("新工作范围菜单排除当前平台未实现执行边界的 runtime", () => {
    const statuses: AgentBackendStatus[] = [
      { backend: "pi", available: true, detail: "legacy" },
      { backend: "dsh", available: true, detail: "not on this platform", capabilities: { hostTools: true, fileTools: true, turnModes: ["yolo"], modelSelection: "host-settings", commandExecution: false } },
      { backend: "codex", available: true, detail: "command missing", capabilities: { hostTools: true, fileTools: true, turnModes: ["yolo"], modelSelection: "host-settings", scopedExecutionVersion: 1, commandExecution: false } },
    ];
    expect(availableConversationBackends(statuses)).toEqual([]);
  });

  test("必须等当前对话真实结束或取消，不能凭点击了停止就切换", () => {
    const completed = item();
    const running = item({ id: "task-2", status: "running", reply: undefined });
    expect(canChangeConversation([completed, running])).toBeFalse();
    expect(canChangeConversation([completed, { ...running, status: "failed" }])).toBeTrue();
    expect(canChangeConversation([completed])).toBeTrue();
  });

  test("切换只携带可见 user/assistant 正文，不迁移工具、用量、附件或隐藏状态", () => {
    const original = item({ messages: [
      { from: "user", text: "查看项目", at: "2026-09-20T09:00:00.000Z" },
      { from: "ai", text: "隐藏工具结果", at: "2026-09-20T09:00:01.000Z", card: { kind: "tool", tool: "web_search", status: "completed", label: "search" } as never },
      { from: "ai", text: "已经读到说明", at: "2026-09-20T09:00:02.000Z", runtime: "pi", usage: { complete: true, totalTokens: 17 }, attachments: [{ kind: "file", name: "not-a-path-grant.txt" }] as never },
    ] });
    const before = structuredClone(original);
    const result = visibleConversationContext([original]);
    expect(result).toEqual([
      { role: "user", text: "查看项目" },
      { role: "assistant", text: "已经读到说明" },
    ]);
    expect(original).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("usage");
    expect(JSON.stringify(result)).not.toContain("attachments");
    expect(JSON.stringify(result)).not.toContain("runtime");
  });

  test("旧记录只从可见原话和回答补上下文，失败诊断不冒充模型回答", () => {
    expect(visibleConversationContext([
      item(),
      item({ id: "task-2", status: "failed", transcript: "再试一次", reply: undefined, userMessage: "后端内部错误", errorCode: "INTERNAL" }),
    ])).toEqual([
      { role: "user", text: "查看项目" },
      { role: "assistant", text: "已经读到说明" },
      { role: "user", text: "再试一次" },
    ]);
  });

  test("续接提示词有界，且明确不重放已执行动作；超长输入拒绝", () => {
    const prompt = continuationPrompt([{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }], "新输入");
    expect(prompt).toContain("不重放已执行动作");
    expect(prompt).toContain("旧回答");
    expect(prompt.endsWith("新输入")).toBeTrue();
    expect(continuationPrompt([], "只有新输入")).toBe("只有新输入");
    const huge = Array.from({ length: 30 }, (_, i) => ({ role: "assistant" as const, text: "x".repeat(2000) + i }));
    expect(continuationPrompt(huge, "新输入").length).toBeLessThanOrEqual(24000);
    expect(() => continuationPrompt([], "y".repeat(24001))).toThrow(RangeError);
  });
});
