/**
 * 诊断里的模型白名单（2.14.3-rc.2；设计规范 §6.0 #waiting-failure-minimum）：登记表只收插件自己的
 * 模型目录 / 常量，整表钉死；登记的 ID 原样进复制诊断，其余一律写「自定义模型」，不写名字或路径。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { setVoiceLocale } from "../src/voice-i18n";
import { DEFAULT_MODEL_ID } from "../src/data";
import { POLISH_MODEL } from "../src/voice-polish";
import { DIGEST_MODEL } from "../src/voice-digest";
import { validCloudOptionId } from "../src/cloud-selection";
import { buildVoiceDiagnosticsText, structuredToken, type VoiceDiagnosticEntry } from "../src/voice-diagnostics";
import {
  diagnosticModelName,
  diagnosticModelToken,
  isKnownVoiceModelId,
  knownVoiceModelIds,
} from "../src/voice-model-registry";

beforeEach(() => setVoiceLocale("zh"));

/** 用户自定义 / 本地导入的模型：自取的名字、含用户名的路径、形似原型键的名字。 */
const CUSTOM_MODEL_NAMES = [
  "alice-private-asr",
  "Users/alice/models/private.onnx",
  "/Users/alice/Models/私人模型.onnx",
  "C:\\Users\\alice\\models\\asr.onnx",
  "constructor",
  "__proto__",
  "toString",
];

describe("登记表：插件自己的模型目录 / 常量，整表钉死", () => {
  test("整表内容（新增内置 / 云端档位必须在这里显式登记）", () => {
    expect(knownVoiceModelIds()).toEqual(["sensevoice-small-int8", "text-default", "transcribe-free", "transcribe-default"]);
  });

  test("与插件常量同步：本地默认模型、润色与总结的云端文本档位都已登记", () => {
    for (const id of [DEFAULT_MODEL_ID, POLISH_MODEL, DIGEST_MODEL]) expect(isKnownVoiceModelId(id)).toBeTrue();
    // 云端转写只登记后台公开的默认选项（合法选项 ID）与旧版保留 ID。
    expect(validCloudOptionId("transcribe-free")).toBeTrue();
    expect(validCloudOptionId("transcribe-default")).toBeFalse();
  });

  test("登记的 ID 都符合结构化值文法：进复制诊断时原样写出", () => {
    for (const id of knownVoiceModelIds()) expect(structuredToken(diagnosticModelToken(id, "cloud"))).toBe(id);
  });
});

describe("复制诊断里的模型值", () => {
  test("已登记 → ID 原样；没有模型 → 「无」", () => {
    expect(structuredToken(diagnosticModelToken("sensevoice-small-int8", "local"))).toBe("sensevoice-small-int8");
    expect(structuredToken(diagnosticModelToken("transcribe-free", "cloud"))).toBe("transcribe-free");
    for (const empty of [undefined, null, ""]) expect(structuredToken(diagnosticModelToken(empty, "local"))).toBe("无");
  });

  test("没登记 → 固定标签「自定义模型」，只附来源类别；中英文都不带名字或路径", () => {
    for (const name of CUSTOM_MODEL_NAMES) {
      expect(isKnownVoiceModelId(name)).toBeFalse();
      setVoiceLocale("zh");
      expect(structuredToken(diagnosticModelToken(name, "local"))).toBe("自定义模型 (local)");
      expect(structuredToken(diagnosticModelToken(name, "cloud"))).toBe("自定义模型 (cloud)");
      expect(structuredToken(diagnosticModelToken(name, "something-else"))).toBe("自定义模型");
      expect(diagnosticModelName(name)).toBe("自定义模型");
      setVoiceLocale("en");
      expect(structuredToken(diagnosticModelToken(name, "local"))).toBe("custom model (local)");
      expect(diagnosticModelName(name)).toBe("custom model");
    }
  });

  test("步骤文案里的模型名：已登记用登记名，不用 Host 给的显示名", () => {
    expect(diagnosticModelName("sensevoice-small-int8")).toBe("SenseVoice Small");
    expect(diagnosticModelName("transcribe-free")).toBe("transcribe-free");
  });

  test("复制全文：自定义模型的名字与路径一个字都不出现，登记模型照常原样出现", () => {
    for (const name of CUSTOM_MODEL_NAMES.filter(item => item.length > 8)) {
      const entry: VoiceDiagnosticEntry = {
        state: "failed",
        step: () => `下载本地语音模型 ${diagnosticModelName(name)}`,
        code: "VOICE_MODEL_DOWNLOAD_FAILED",
        details: [
          { label: () => "模型", value: name, tokens: () => [diagnosticModelToken(name, "local"), "failed"] },
          { label: () => "登记模型", tokens: () => [diagnosticModelToken("sensevoice-small-int8", "local")] },
        ],
      };
      const text = buildVoiceDiagnosticsText(entry, { state: "ready", version: "1.0.0-rc.1" });
      expect(text).not.toContain(name);
      for (const piece of ["alice", "Users", "私人模型", "onnx"]) expect(text).not.toContain(piece);
      expect(text).toContain("当前步骤: 下载本地语音模型 自定义模型");
      expect(text).toContain("  - 模型: 自定义模型 (local) · failed");
      expect(text).toContain("  - 登记模型: sensevoice-small-int8");
    }
  });
});
