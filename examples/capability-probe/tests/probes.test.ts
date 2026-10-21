import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describeError, scrub } from "../src/errors";
import { createPreviewPort, type PreviewOptions } from "../src/preview-port";
import { PING_KEY, PROBES, probeById, runProbe, safeProbes } from "../src/probes";
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

  test("「全部测试」不包含会跳页面或弹通知的探针", () => {
    const ids = safeProbes().map((probe) => probe.id);
    expect(ids).not.toContain("system-task-open");
    expect(ids).not.toContain("notify");
    expect(ids).toContain("kv-roundtrip");
    expect(ids).toContain("http-health");
  });
});

describe("探针结果（假 Host）", () => {
  test("存储读写成功，且不留测试数据", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const result = await runProbe(probeById("kv-roundtrip")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("ok");
    expect(await port.kv.keys()).toEqual([]);
  });

  test("超大数据被拒是预期结果", async () => {
    expect((await run("kv-oversize")).outcome).toBe("blocked");
  });

  test("未声明的存储空间：没被拒时如实标「与预期不同」，被拒时标「被拦下」", async () => {
    expect((await run("kv-undeclared")).outcome).toBe("unexpected");
    expect((await run("kv-undeclared", { rejectUndeclaredStore: true })).outcome).toBe("blocked");
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

  test("网络反例被拦下", async () => {
    expect((await run("http-undeclared")).outcome).toBe("blocked");
    expect((await run("http-insecure")).outcome).toBe("blocked");
  });

  test("Voice 没装时说清原因", async () => {
    const missing = await run("voice-service", { voiceInstalled: false });
    expect(missing.outcome).toBe("blocked");
    expect((await run("voice-service", { voiceInstalled: true })).outcome).toBe("ok");
  });

  test("Driver 版本查询被限频时等一下重试", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    let calls = 0;
    const original = port.versionStatus.bind(port);
    port.versionStatus = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("版本查询过于频繁"), { code: "SYSTEM_TASK_BUSY" });
      return original();
    };
    const result = await runProbe(probeById("host-version")!, { port, document, signal: new AbortController().signal });
    expect(result.outcome).toBe("ok");
    expect(calls).toBe(2);
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

  test("报告和诊断里不出现令牌", () => {
    const text = "Authorization: Bearer abc.def wno-secret-token https://x/y?token=zzz&a=1";
    const cleaned = scrub(text);
    expect(cleaned).not.toContain("abc.def");
    expect(cleaned).not.toContain("wno-secret-token");
    expect(cleaned).not.toContain("zzz");
    const report = buildReport({
      mode: "preview",
      hostVersion: "1.0.5",
      developerMode: true,
      results: new Map([["env", { probeId: "env", outcome: "failed", summary: "Bearer abc.def", detail: text, startedAt: "2026-10-21T00:00:00.000Z", durationMs: 3 }]]),
      now: new Date("2026-10-21T00:00:01.000Z"),
    });
    expect(report).not.toContain("abc.def");
    expect(report).not.toContain("wno-secret-token");
    const parsed = JSON.parse(report) as { plugin: { version: string }; results: unknown[] };
    expect(parsed.plugin.version).toBe("0.1.0");
    expect(parsed.results).toHaveLength(1);
  });
});
