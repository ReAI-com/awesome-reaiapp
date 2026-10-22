/**
 * §6.0 #waiting-failure-minimum 白名单结构的回归（2026-09-27 主线改做法）：复制出去的诊断与浮层只由
 * 结构化安全字段组成，上游原文不清洗、不复制、不进浮层。这里不测「清洗得干不干净」，而是测结构：
 * ① 复制文本只含白名单字段键；② 任意用户原文 / 手机号 / 授权串 / 编码串 / 组合字符喂进错误的
 * 任何字段（原文、码、异常名、对象状态值、Host 版本），复制文本与浮层文本都不含它的任何片段。
 */
import { beforeEach, expect, test } from "bun:test";
import { setVoiceLocale } from "../src/voice-i18n";
import { collectErrorFields, diagnosticLogFields } from "../src/voice-error-fields";
import { taskFailureLabel, withCode } from "../src/voice-failure-labels";
import {
  buildVoiceDiagnosticsText,
  entryFromErrorDetail,
  errorDetailFrom,
  safeOverlayDiagnostics,
  type VoiceHostVersion,
} from "../src/voice-diagnostics";

beforeEach(() => setVoiceLocale("zh"));

const TRANSCRIPT = "请把第三季度报告发给财务部的王经理";
const escapeU = (text: string) => Array.from(text).map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const entity = (text: string) => Array.from(text).map((char) => `&#x${char.codePointAt(0)!.toString(16)};`).join("");
const PAYLOADS = [
  TRANSCRIPT,
  "13800138000",
  "Authorization: Bearer abc.def.ghi",
  "Basic dXNlcjpwYXNz",
  "Digest username=\"alice\", response=\"6629fae49393a053\"",
  encodeURIComponent(TRANSCRIPT),
  encodeURIComponent(encodeURIComponent(TRANSCRIPT)),
  escapeU(TRANSCRIPT),
  entity(TRANSCRIPT),
  "café résumé private note",
  JSON.stringify({ prompt: TRANSCRIPT, token: "t-1234567" }),
  // 形似错误码的凭据与用户内容：码只认登记表，按长相放行不了。
  ("ghp_" + "A".repeat(36)),
  "PRIVATE_ACCOUNT_DATA",
  "Authorization:abc123",
];

/** 片段：6 个字符（按码位）以上的任意连续子串都不许出现。 */
function fragments(payload: string, size = 6): string[] {
  const chars = Array.from(payload);
  if (chars.length <= size) return [payload];
  return chars.slice(0, chars.length - size + 1).map((_, index) => chars.slice(index, index + size).join(""));
}

function expectNoFragment(text: string, payload: string): void {
  for (const piece of fragments(payload)) {
    if (text.includes(piece)) throw new Error(`泄露片段「${piece}」（来自 ${JSON.stringify(payload)}）：\n${text}`);
  }
}

const HOST: VoiceHostVersion = { state: "ready", version: "1.0.0-rc.1" };
const ALLOWED_KEYS = new Set([
  "插件版本", "App 版本", "Host API", "状态", "当前步骤", "说明", "错误码", "上游错误码", "未登记的错误码", "错误来源",
  "HTTP 状态码", "原因（按错误码）", "原始原因", "发生时间", "发现中断时间", "对象状态", "日志位置", "生成时间",
  // 2.14.2：Agent 引擎失败的 Host 阶段、退出码、方括号上游码（登记表值与整数）。
  "Agent 阶段", "引擎退出码", "引擎上报的上游码",
]);

function causeCarrying(payload: string): unknown {
  return {
    code: payload,
    name: payload,
    message: `upstream said: ${payload}`,
    userMessage: payload,
    diagnostic: payload,
    kind: payload,
    stderr_tail: payload,
    cause: { code: "AI_INVALID_REQUEST", status: 400, message: payload, cause: payload },
  };
}

test("复制文本只含白名单字段键（首行标题、逐行「键: 值」、对象状态缩进项）", () => {
  const cause = causeCarrying(TRANSCRIPT);
  const entry = entryFromErrorDetail(errorDetailFrom("recognize", cause, { sinceMs: 0 }), {
    noteKey: "diagnostics.digestFailed",
    details: [{ label: () => "录音 id", tokens: () => ["rec-1"] }],
  });
  const staged = entryFromErrorDetail(errorDetailFrom("agent", { code: "AGENT_ENGINE",
    cause: { kind: "engine", stderr_tail: `DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: ${TRANSCRIPT}` } }));
  const stagedText = buildVoiceDiagnosticsText(staged, HOST);
  expect(stagedText).toContain("引擎上报的上游码: AI_RATE_LIMITED");
  for (const text of [buildVoiceDiagnosticsText(entry, HOST), stagedText]) {
    const lines = text.split("\n");
    expect(lines[0]).toBe("ReAI Board Voice 诊断信息");
    for (const line of lines.slice(1)) {
      if (line.startsWith("  - ")) continue;
      const key = line.slice(0, line.indexOf(":"));
      expect(ALLOWED_KEYS.has(key)).toBeTrue();
    }
    expectNoFragment(text, TRANSCRIPT);
  }
});

for (const payload of PAYLOADS) {
  test(`喂进错误各字段也不外流：${JSON.stringify(payload).slice(0, 40)}`, () => {
    const cause = causeCarrying(payload);
    const fields = collectErrorFields(cause);
    // 原文确实被采到了（只在内存，给界面主动展开）——证明这条用例不是空转。
    expect(fields.raw).toContain(payload);
    const entry = entryFromErrorDetail(errorDetailFrom("recognize", cause), {
      // 显示值可以是任意文本（只在界面）；复制只取 tokens（ID / 枚举 / 数字）。
      details: [{ label: () => "模型", value: payload, tokens: () => ["whisper-small", 42] }],
    });
    const hosts: VoiceHostVersion[] = [HOST, { state: "rejected", code: payload }, { state: "ready", version: payload }];
    for (const host of hosts) {
      const copied = buildVoiceDiagnosticsText(entry, host);
      const overlay = safeOverlayDiagnostics(entry, host);
      expectNoFragment(copied, payload);
      expectNoFragment(overlay, payload);
    }
    expectNoFragment(withCode(taskFailureLabel(cause), fields.code), payload);
    // 日志（Host 会把插件 console 转进日志）同样只有结构化投影。
    expectNoFragment(JSON.stringify(diagnosticLogFields(cause)), payload);
    // 结构化的上游码与 HTTP 状态码照常保留。
    expect(buildVoiceDiagnosticsText(entry, HOST)).toContain("HTTP 状态码: 400");
  });
}
