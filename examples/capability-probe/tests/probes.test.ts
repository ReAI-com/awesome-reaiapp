import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describeError, scrub } from "../src/errors";
import { createPreviewPort, type PreviewOptions } from "../src/preview-port";
import { PING_KEY, PROBES, probeById, runProbe, safeProbes, voiceRequestId } from "../src/probes";
import { buildReport } from "../src/report";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    // 探针会尝试加载脚本和 iframe；测试环境只需要「没加载成功」这个结果，关掉 happy-dom 的真实加载与报错。
    GlobalRegistrator.register({ settings: { disableJavaScriptFileLoading: true, disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true } });
    ownsDom = true;
  }
});
afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

async function run(id: string, options: PreviewOptions = {}) {
  const port = createPreviewPort({ delayMs: 0, ...options });
  const probe = probeById(id);
  if (!probe) throw new Error(`没有探针 ${id}`);
  return runProbe(probe, { port, document, signal: new AbortController().signal });
}

describe("探针清单", () => {
  test("id 唯一；P0 可运行，P1 / P2 都带关闭原因且没有执行步骤", () => {
    expect(new Set(PROBES.map((probe) => probe.id)).size).toBe(PROBES.length);
    for (const probe of PROBES) {
      if (probe.level === "P0") expect(probe.run && !probe.disabledReason).toBeTruthy();
      else expect(probe.disabledReason && !probe.run).toBeTruthy();
    }
  });

  test("「全部测试」不包含会跳页面、弹通知或启动别的插件的探针", () => {
    const ids = safeProbes().map((probe) => probe.id);
    expect(ids).not.toContain("system-task-open");
    expect(ids).not.toContain("notify");
    expect(ids).not.toContain("voice-service");
    expect(ids).toContain("kv-roundtrip");
    expect(ids).toContain("http-health");
  });

  test("关闭的探针说明里不出现内部错误码", () => {
    for (const probe of PROBES.filter((item) => item.disabledReason)) expect(probe.disabledReason).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
});

describe("探针结果（假 Host）", () => {
  test("存储读写成功，且不留测试数据", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const result = await runProbe(probeById("kv-roundtrip")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("ok");
    expect(await port.kv.keys()).toEqual([]);
  });

  test("存储读写中途出错也会删掉测试数据", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    port.kv.compareAndSet = async () => { throw Object.assign(new Error("存储暂时不可用"), { code: "STORAGE_UNAVAILABLE" }); };
    const result = await runProbe(probeById("kv-roundtrip")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("failed");
    expect(await port.kv.keys()).toEqual([]);
  });

  test("同时跑两次存储读写互不干扰", async () => {
    const port = createPreviewPort({ delayMs: 1 });
    const context = { port, document, signal: new AbortController().signal };
    const [a, b] = await Promise.all([runProbe(probeById("kv-roundtrip")!, context), runProbe(probeById("kv-roundtrip")!, context)]);
    expect([a.outcome, b.outcome]).toEqual(["ok", "ok"]);
    expect(await port.kv.keys()).toEqual([]);
  });

  test("超大数据被拒是预期结果", async () => {
    const result = await run("kv-oversize");
    expect(result.outcome).toBe("blocked");
    expect(result.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  test("未声明的存储空间：没被拒时如实标「与预期不同」，被拒时标「被拦下」", async () => {
    expect((await run("kv-undeclared")).outcome).toBe("unexpected");
    const blocked = await run("kv-undeclared", { rejectUndeclaredStore: true });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.code).toBe("STORAGE_NOT_DECLARED");
    expect(blocked.summary).toContain("按预期");
  });

  test("未声明的存储空间：别的存储错误码不能冒充「按预期被拦下」", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    port.kvStore = () => ({
      ...port.kv,
      set: async () => { throw Object.assign(new Error("存储暂时不可用"), { code: "STORAGE_UNAVAILABLE" }); },
    });
    const result = await runProbe(probeById("kv-undeclared")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("failed");
    expect(result.code).toBe("STORAGE_UNAVAILABLE");
  });

  test("反例意外写入后清理失败，不能声称已删除", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const store = port.kvStore("undeclared-probe");
    port.kvStore = () => ({ ...store, delete: async () => { throw Object.assign(new Error("存储暂时不可用"), { code: "STORAGE_UNAVAILABLE" }); } });
    const result = await runProbe(probeById("kv-undeclared")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("unexpected");
    expect(result.summary).toContain("没删掉");
    expect(result.summary).not.toContain("已删除");
  });

  test("http 反例：Driver 返回协议拒绝码时，说明写「只允许 https」", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    port.fetch = async () => { throw Object.assign(new Error("只允许 HTTP(S) URL"), { code: "NETWORK_SCHEME_DENIED" }); };
    const result = await runProbe(probeById("http-insecure")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("blocked");
    expect(result.summary).toBe("按预期被拦下：只允许 https");
  });

  test("按键命令：没触发过时等你操作，触发后显示次数", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const probe = probeById("command-ping")!;
    const context = { port, document, signal: new AbortController().signal };
    expect((await runProbe(probe, context)).outcome).toBe("waiting");
    await port.kv.set(PING_KEY, { at: "2026-10-21T08:00:00.000Z", count: 3 });
    const result = await runProbe(probe, context);
    expect(result.outcome).toBe("ok");
    expect(result.summary).toContain("累计 3 次");
  });

  test("用户没同意权限时是「被拦下」并给出去哪里点允许", async () => {
    const denied = new Set(["account.status@1", "http.fetch@1", "os.notification.post@1"]);
    for (const id of ["account", "http-health", "notify"]) {
      const result = await run(id, { deniedPermissions: denied });
      expect(result.outcome).toBe("blocked");
      expect(result.code?.startsWith("PLUGIN_PERMISSION_")).toBe(true);
      expect(result.summary).toContain("权限");
    }
    expect((await run("account")).outcome).toBe("ok");
    expect((await run("http-health")).outcome).toBe("ok");
  });

  test("网络反例：只有预期的错误码算「按预期被拦下」", async () => {
    const undeclared = await run("http-undeclared");
    expect(undeclared.outcome).toBe("blocked");
    expect(undeclared.summary).toContain("按预期");
    // 与 Driver 一致：清单只收 https，http 地址按「没声明」拦下，说明里不能说成是 https 检查。
    const insecure = await run("http-insecure");
    expect(insecure.outcome).toBe("blocked");
    expect(insecure.code).toBe("NETWORK_ENDPOINT_NOT_DECLARED");
    expect(insecure.summary).toContain("按没声明的地址拦下");
    // 没同意网络权限时，反例其实没测到，不能冒充「按预期被拦下」。
    const notConsented = await run("http-undeclared", { deniedPermissions: new Set(["http.fetch@1"]) });
    expect(notConsented.outcome).toBe("blocked");
    expect(notConsented.summary).toContain("没测到");
  });

  test("网络反例遇到宽松网络档时，提示打开严格网络预览", async () => {
    for (const id of ["http-undeclared", "http-insecure"]) {
      const result = await run(id, { lenientNetwork: true });
      expect(result.outcome).toBe("unexpected");
      expect(result.summary).toContain("严格网络预览");
    }
  });

  test("Voice 请求号符合 Voice 的格式；服务能应答，没装时说清原因", async () => {
    expect(voiceRequestId(1_700_000_000_000)).toMatch(/^1700000000000:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect((await run("voice-service", { voiceInstalled: true })).outcome).toBe("ok");
    const missing = await run("voice-service", { voiceInstalled: false });
    expect(missing.outcome).toBe("blocked");
    expect(missing.code).toBe("SERVICE_PROVIDER_UNAVAILABLE");
  });

  test("Voice 拒绝了测试请求也算服务在线", async () => {
    const port = createPreviewPort({ delayMs: 0, voiceInstalled: true });
    port.callService = async () => { throw Object.assign(new Error("身份缺失"), { code: "VOICE_REQUEST_IDENTITY_REQUIRED" }); };
    const result = await runProbe(probeById("voice-service")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("ok");
  });

  test("Driver 版本查询被限频时等一下重试；别的错误不重试", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    let calls = 0;
    const original = port.versionStatus.bind(port);
    port.versionStatus = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("版本查询过于频繁"), { code: "SYSTEM_TASK_RATE_LIMITED" });
      return original();
    };
    const result = await runProbe(probeById("host-version")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("ok");
    expect(calls).toBe(2);

    let busyCalls = 0;
    port.versionStatus = async () => { busyCalls += 1; throw Object.assign(new Error("固件升级进行中"), { code: "SYSTEM_TASK_BUSY" }); };
    const busy = await runProbe(probeById("host-version")!, { port, document, signal: new AbortController().signal });
    expect(busy.outcome).toBe("failed");
    expect(busyCalls).toBe(1);
  });

  test("关闭的探针不执行，只返回原因", async () => {
    const result = await run("cloud-model");
    expect(result.outcome).toBe("waiting");
    expect(result.summary).toContain("外脑");
  });

  test("页面脚本自检在没有 CSP 的环境里如实标「与预期不同」", async () => {
    const result = await run("csp-eval");
    expect(result.outcome).toBe("unexpected");
    expect(result.summary).toContain("浏览器预览");
  });
});

describe("错误与报告", () => {
  test("统一取出错误码和原文", () => {
    expect(describeError({ code: "X", userMessage: "人话" })).toEqual({ code: "X", message: "人话" });
    expect(describeError({ code: "Y", message: "原文" })).toEqual({ code: "Y", message: "原文" });
    expect(describeError("纯文字")).toEqual({ code: "NO_CODE", message: "纯文字" });
  });

  test("诊断文字里的各种凭据都被隐藏", () => {
    const samples = [
      ["Authorization: Bearer abc.def", "abc.def"],
      ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["Cookie: sid=s3cr3t; theme=dark", "s3cr3t"],
      ["Set-Cookie: session=zz9", "zz9"],
      ["token wno-secret-token", "wno-secret-token"],
      ["https://x/y?refresh_token=r1&a=1", "r1"],
      ["https://x/y?X-Amz-Signature=deadbeef", "deadbeef"],
      ["https://x/cb?code=c0de&state=1", "c0de"],
      ["{\"access_token\":\"at1\",\"ok\":true}", "at1"],
      ["{\"client_secret\": \"cs2\"}", "cs2"],
    ] as const;
    for (const [text, secret] of samples) expect(scrub(text)).not.toContain(secret);
    expect(scrub("https://x/y?a=1&page=2")).toBe("https://x/y?a=1&page=2");
  });

  test("报告不含令牌；错误码只在开发者模式写进报告", () => {
    const results = new Map([["env", { probeId: "env", outcome: "failed" as const, summary: "Bearer abc.def", code: "X_FAILED", detail: "wno-secret-token", startedAt: "2026-10-21T00:00:00.000Z", durationMs: 3 }]]);
    const withDiagnostics = buildReport({ mode: "preview", hostVersion: "1.0.5", developerMode: true, results, now: new Date("2026-10-21T00:00:01.000Z") });
    expect(withDiagnostics).not.toContain("abc.def");
    expect(withDiagnostics).not.toContain("wno-secret-token");
    expect(withDiagnostics).toContain("X_FAILED");
    const parsed = JSON.parse(withDiagnostics) as { plugin: { version: string }; results: unknown[] };
    expect(parsed.plugin.version).toBe("0.1.1");
    expect(parsed.results).toHaveLength(1);
    const plain = buildReport({ mode: "preview", hostVersion: "1.0.5", developerMode: false, results });
    expect(plain).not.toContain("X_FAILED");
  });
});
