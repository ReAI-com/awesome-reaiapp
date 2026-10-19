import { describe, expect, test } from "bun:test";
import type { VoiceInputClient, VoicePermissionInfo, VoicePermissionState } from "@reai/app-sdk/v1";
import { DEFAULT_SETTINGS } from "../src/data";
import { prepareVoiceRequest } from "../src/voice-request-permission";
import { VoiceRequestAdmission } from "../src/voice-request-admission";
import { VoiceRequestTextProvider } from "../src/voice-request-text";

const messages = { cancelled: "cancelled", upgrade: "update Driver", microphone: "allow microphone" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness(info: VoicePermissionInfo) {
  const calls: string[] = [];
  const voice: Pick<VoiceInputClient, "configure" | "checkPermissions"> & { requestPermission(kind: string): Promise<VoicePermissionState> } = {
    async configure() { calls.push("configure"); },
    async checkPermissions() { calls.push("check"); return info; },
    // 准备链不该碰它：留着只为断言「从未请求」。
    async requestPermission(kind) { calls.push(kind); return "granted"; },
  };
  const controller = new AbortController();
  const prepare = (signal = controller.signal, report = () => { calls.push("waiting"); }) =>
    prepareVoiceRequest(voice, DEFAULT_SETTINGS, signal, report, messages);
  return { calls, voice, controller, prepare };
}

describe("request-text uses Host route permission requirements", () => {
  for (const microphone of ["denied", "not_determined", "granted"] as VoicePermissionState[]) {
    test(`native Board route skips microphone authorization (${microphone})`, async () => {
      const h = harness({ microphone, accessibility: "granted", microphoneRequired: false });
      await h.prepare();
      expect(h.calls).toEqual(["configure", "check"]);
    });
  }
  test("old Host missing the requirement fails closed even with a microphone grant", async () => {
    const h = harness({ microphone: "granted", accessibility: "granted" });
    await expect(h.prepare()).rejects.toMatchObject({ code: "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED", userMessage: messages.upgrade });
    expect(h.calls).toEqual(["configure", "check"]);
  });
  test("required microphone already granted does not prompt again", async () => {
    const h = harness({ microphone: "granted", accessibility: "granted", microphoneRequired: true });
    await h.prepare();
    expect(h.calls).toEqual(["configure", "check"]);
  });
  for (const microphone of ["denied", "not_determined"] as VoicePermissionState[]) {
    test(`Host-required microphone never prompts while starting a recording: ${microphone}`, async () => {
      // 2026-10-11：录音开始链路只检查不请求，未授权直接失败、去 Voice 设置里授权。
      const h = harness({ microphone, accessibility: "granted", microphoneRequired: true });
      await expect(h.prepare()).rejects.toMatchObject({ code: "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED", userMessage: messages.microphone });
      expect(h.calls).toEqual(["configure", "check"]);
    });
  }
  test("cancellation during permission read never prompts", async () => {
    const h = harness({ microphone: "denied", accessibility: "granted", microphoneRequired: true });
    const read = h.voice.checkPermissions;
    h.voice.checkPermissions = async () => { const result = await read(); h.controller.abort(); return result; };
    await expect(h.prepare()).rejects.toMatchObject({ code: "SERVICE_CANCELLED" });
    expect(h.calls).toEqual(["configure", "check"]);
  });
  test("a provider request with an unauthorized required microphone fails without prompting and frees the slot", async () => {
    const h = harness({ microphone: "denied", accessibility: "granted", microphoneRequired: true });
    const admission = await VoiceRequestAdmission.open({ read: async () => undefined, write: async () => undefined });
    let busy = false;
    const provider = new VoiceRequestTextProvider(admission, {
      reserve() { if (busy) return; busy = true; return () => { busy = false; }; },
      prepare: h.prepare,
      async isAccountCurrent() { return true; },
      async start() { h.calls.push("start"); return { phase: "listening", sessionId: "new" }; },
      async finish() { return { phase: "idle" }; },
      async cancelPendingStart() {}, async cancel() {}, async acknowledge() {},
      async readStatus() { return { phase: "listening" }; },
      async process() { return { text: "text", kind: "processed" }; },
    }, { pollMs: 100_000 });
    const caller = { appId: "consumer", surfaceMountId: "surface", runtimeSessionId: "runtime", accountGeneration: "epoch" };
    const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
    try {
      const error = await provider.request({ caller, input, signal: h.controller.signal }).catch((cause) => cause);
      expect(error).toMatchObject({ code: "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED" });
      expect(h.calls).not.toContain("microphone");
      expect(h.calls).not.toContain("waiting");
      expect(h.calls).not.toContain("start");
      expect(busy).toBe(false);
    } finally { provider.dispose(); }
  });
});
