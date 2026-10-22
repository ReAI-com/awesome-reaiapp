/**
 * 录音卡第一版 PR6（plans/2026-10-19-recorder-card-v1.md §4.2）：硬件触发的命令调用带 Host 签发的
 * 一次性 `triggerRef`，Voice 开始录音时原样回传给 `voiceInput.start` / `toggle`，Host 据此让发起
 * 设备的麦优先。只在开始录音时回传；结束、软件入口（没有凭证）都不带。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, POLISH_LIGHT_DEFAULT_MIGRATION_KEY } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };

async function harness() {
  document.body.replaceChildren();
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?trigger-ref=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "zh-CN" });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const toggles: Array<Record<string, unknown>> = [];
  wire.handleRequest = async (method, params) => {
    if (method === "voice.toggle") toggles.push({ ...params });
    return await original(method, params);
  };
  await host.installAndEnable();
  return {
    host,
    toggles,
    dispose: async () => { try { await host.disable(); } finally { wire.handleRequest = original; } },
  };
}

test("语音输入：硬件触发的 triggerRef 只在开始录音时原样回传", async () => {
  const h = await harness();
  try {
    const started = await h.host.invokeCommand("com.reai.voice.toggle-input", {}, { triggerRef: "tr-card-1" });
    expect(started.ok).toBeTrue();
    const finished = await h.host.invokeCommand("com.reai.voice.toggle-input", {}, { triggerRef: "tr-card-2" });
    expect(finished.ok).toBeTrue();
    expect(h.toggles.length).toBe(2);
    expect(h.toggles[0]!.triggerRef, "开始录音回传凭证").toBe("tr-card-1");
    expect("triggerRef" in h.toggles[1]!, "结束录音的那次调用不带凭证").toBeFalse();
    expect(
      h.toggles.filter(params => params.triggerRef === "tr-card-2"),
      "结束录音不回传凭证",
    ).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("语音命令：硬件触发的 triggerRef 同样回传；软件入口没有凭证就不带", async () => {
  const h = await harness();
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-command", {}, { triggerRef: "tr-card-3" })).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-command")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect(h.toggles.length).toBe(3);
    expect(h.toggles[0]!.triggerRef, "命令开始录音回传凭证").toBe("tr-card-3");
    expect("triggerRef" in h.toggles[1]!, "结束不带").toBeFalse();
    expect("triggerRef" in h.toggles[2]!, "软件入口没有凭证就不带").toBeFalse();
  } finally {
    await h.dispose();
  }
});

for (const commandId of ["com.reai.voice.toggle-input", "com.reai.voice.toggle-command"]) {
  test(`按住说话（${commandId}）：配对操作开始时回传 triggerRef，松开结束不带`, async () => {
    const h = await harness();
    const bus = h.host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean }> };
    const invoke = async (correlationId: string, phase: "start" | "end", triggerRef: string) => {
      bus.dispatch({
        type: "command.invoke", commandId, correlationId, input: {}, timeoutMs: 3000,
        operation: { id: "hold-card", phase }, triggerRef,
      });
      for (let i = 0; i < 200 && !bus.settlements.has(correlationId); i++) await new Promise(r => setTimeout(r, 5));
      expect(bus.settlements.get(correlationId)?.ok).toBeTrue();
    };
    try {
      await invoke("hold-start", "start", "tr-card-hold");
      await invoke("hold-end", "end", "tr-card-release");
      expect(h.toggles.length).toBe(2);
      expect(h.toggles[0]!.triggerRef, "按下开始录音回传凭证").toBe("tr-card-hold");
      expect("triggerRef" in h.toggles[1]!, "松开结束不带凭证").toBeFalse();
    } finally {
      await h.dispose();
    }
  });
}
