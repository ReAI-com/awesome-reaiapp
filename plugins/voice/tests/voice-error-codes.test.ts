/**
 * 错误码登记表（§6.0 白名单）：导出的码只认登记过的值，不按长相判断；插件源码里抛出 / 识别的码都已登记。
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registeredErrorCode } from "../src/voice-error-codes";
import { hostErrorCode } from "../src/voice-failure-labels";
import { collectErrorFields, diagnosticLogFields, projectDiagnosticLogFields, withOuterCode } from "../src/voice-error-fields";

const SRC = resolve(import.meta.dir, "../src");

test("插件源码里抛出或按码识别的每个大写码都在登记表里（新增码漏登记就变红）", () => {
  const pattern = /(?:code:|code ===|code !==|hasStableCode\([^,]+,|case) "((?:com\.reai\.voice\/)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g;
  const missing = new Set<string>();
  let seen = 0;
  for (const name of readdirSync(SRC).filter((file) => file.endsWith(".ts"))) {
    for (const match of readFileSync(resolve(SRC, name), "utf8").matchAll(pattern)) {
      seen += 1;
      if (!registeredErrorCode(match[1])) missing.add(`${name}: ${match[1]}`);
    }
  }
  expect(seen).toBeGreaterThan(50);
  expect([...missing]).toEqual([]);
});

test("登记过的码原样导出；形似码的凭据、用户说的话、伪造的异常名＋数字码一律不导出", () => {
  for (const code of ["AI_TIMEOUT", "AGENT_ENGINE", "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED", "com.reai.voice/VOICE_BUSY",
    "no_input_target", "NotAllowedError", "MediaError code 3", "BRIDGE_MESSAGE_TOO_LARGE"]) {
    expect(registeredErrorCode(code)).toBe(code);
  }
  for (const value of [("ghp_" + "A".repeat(36)), "PRIVATE_ACCOUNT_DATA", "Authorization:abc123",
    "com.reai.voice/PRIVATE_ACCOUNT_DATA", "MediaError code 9", "SecretName code 3", "Error code 3", "AI_TIMEOUT_SECRET"]) {
    expect(registeredErrorCode(value)).toBeUndefined();
  }
  const fields = collectErrorFields({ name: "SecretName", code: 3, cause: { code: ("ghp_" + "A".repeat(36)) } });
  expect(fields.code).toBeUndefined();
  expect(fields.omittedCodes).toBe(2);
  // 没登记的码只进内存原文（界面展开可见），不进导出字段。
  expect(fields.raw).toContain(("ghp_" + "A".repeat(36)));
});

test("把总结失败包成插件码时保留已采集的上游码、HTTP 状态码、来源与完整字符数，不重新采集", () => {
  const raw = "x".repeat(4500);
  const inner = collectErrorFields({ code: "DSH_ENGINE", cause: { code: "AI_RATE_LIMITED", status: 429, message: raw } });
  expect(inner.rawLength).toBe(4500);
  const wrapped = withOuterCode(inner, "com.reai.voice/DSH_ENGINE");
  expect(wrapped.code).toBe("com.reai.voice/DSH_ENGINE");
  expect(wrapped.upstreamCodes).toEqual(["DSH_ENGINE", "AI_RATE_LIMITED"]);
  expect(wrapped).toMatchObject({ httpStatus: 429, rawLength: 4500, source: inner.source });
  // 外层码没登记：保持原字段，不丢真实码。
  expect(withOuterCode(inner, "com.reai.voice/SOMETHING_NEW")).toBe(inner);
});

test("日志投影：已采集字段原样投影（上游码、来源、HTTP、完整字数、未登记码个数），不重新采集、不带原文", () => {
  const fields = withOuterCode(collectErrorFields({ code: "DSH_ENGINE", cause: { code: "AI_RATE_LIMITED", status: 429,
    message: "x".repeat(4500), cause: { code: ("ghp_" + "A".repeat(36)) } } }), "com.reai.voice/DSH_ENGINE");
  const logged = projectDiagnosticLogFields(fields);
  expect(logged).toEqual({ code: "com.reai.voice/DSH_ENGINE", upstreamCodes: ["DSH_ENGINE", "AI_RATE_LIMITED"], source: fields.source,
    httpStatus: 429, rawLength: fields.rawLength, omittedCodes: 1 });
  expect(fields.rawLength).toBeGreaterThan(4500);
  expect(JSON.stringify(logged)).not.toContain("xxxx");
});

test("日志：外部异常自带「已采集字段」同名字段也照样过接收规则，伪造的码、来源、数值都不外流", () => {
  const forged = {
    code: "PRIVATE_ACCOUNT_DATA",
    upstreamCodes: ["Authorization: Bearer SYNTHETIC_ONLY", "AI_TIMEOUT"],
    source: "phone-13800138000",
    httpStatus: "503",
    rawLength: "4500",
    omittedCodes: "2",
    userMessage: "Host said 13800138000",
  };
  for (const logged of [diagnosticLogFields(forged), projectDiagnosticLogFields(forged as never)]) {
    const text = JSON.stringify(logged);
    for (const leaked of ["PRIVATE_ACCOUNT_DATA", "SYNTHETIC_ONLY", "13800138000", "Host said"]) expect(text).not.toContain(leaked);
    expect(logged.source).toBeUndefined();
    expect(logged.httpStatus).toBeUndefined();
    // 按出身认定：外部对象里哪怕是登记过的上游码（AI_TIMEOUT）也不接着用，只取它自己的码。
    expect(logged.upstreamCodes).toEqual([]);
  }
});

test("交给 Host 弹窗的 errorCode：只带登记过、且合 Host 码形状的码（不合形状整次请求会被拒），不合就不带", () => {
  expect(hostErrorCode("AGENT_ENGINE")).toEqual({ errorCode: "AGENT_ENGINE" });
  expect(hostErrorCode("no_input_target")).toEqual({ errorCode: "no_input_target" });
  expect(hostErrorCode("com.reai.voice/VOICE_BUSY")).toEqual({ errorCode: "com.reai.voice/VOICE_BUSY" });
  expect(hostErrorCode("MediaError code 3")).toEqual({});
  expect(hostErrorCode("PRIVATE_ACCOUNT_DATA")).toEqual({});
  expect(hostErrorCode(undefined)).toEqual({});
});

