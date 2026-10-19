import { describe, expect, test } from "bun:test";
import { RequestMethod } from "@reai/app-sdk/v1";
import { MockHost } from "../src/v1/index";

const manifest = {
  appId: "com.example.voice-probe",
  requires: { hostCapabilities: ["voice.deliver@1"] },
  permissions: [{ id: "voice.deliver@1", purpose: "写回识别结果" }],
};

describe("voice.deliver.commit Mock Host（Host API 1.22 失败原因）", () => {
  test("可注入 not_editable / not_received，用完即复位", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    for (const reason of ["not_editable", "not_received"] as const) {
      host.setNextVoiceDeliverCommitReason(reason);
      await expect(
        host.bridge.request(RequestMethod.VoiceDeliverCommit, { targetId: "dt-x", text: "你好" }),
      ).resolves.toEqual({ committed: false, reason });
    }
    // 复位后回到既有的 targetId 分支（不匹配 → denied）。
    await expect(
      host.bridge.request(RequestMethod.VoiceDeliverCommit, { targetId: "dt-x", text: "你好" }),
    ).resolves.toEqual({ committed: false, reason: "denied" });
  });
});

describe("取回卡与结果面板的诊断字段（Host API 1.22 同版本并入，与 Host 同规则）", () => {
  const base = { title: "文字没有写入成功", reason: "原因", text: "你好" };
  const answer = { runId: "run-1", title: "t", text: "x", originalText: "o", status: "failed" };

  test("合规的 errorCode / detail 通过，缺省与旧行为一致", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    for (const extra of [{}, { errorCode: "com.reai.voice/VOICE_START_TIMEOUT", detail: "HTTP 504" }, { errorCode: "not_received" }]) {
      await expect(
        host.bridge.request(RequestMethod.VoiceDeliverPresentTakeback, { ...base, ...extra }),
      ).resolves.toEqual({ presented: true });
      await expect(
        host.bridge.request(RequestMethod.VoiceCommandPresentAnswer, { ...answer, ...extra }),
      ).resolves.toBeUndefined();
    }
  });

  test("越界与非法字符被拒，码与 Host 一致", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    const bad = [
      { errorCode: "带空格 CODE" },
      { errorCode: "/workspace/private" },
      { errorCode: "a:b" },
      { errorCode: "A".repeat(101) },
      { errorCode: 42 },
      { detail: "长".repeat(501) },
      { detail: { nested: true } },
    ];
    for (const extra of bad) {
      await expect(
        host.bridge.request(RequestMethod.VoiceDeliverPresentTakeback, { ...base, ...extra }),
      ).rejects.toMatchObject({ code: "VOICE_DELIVER_INVALID_REQUEST" });
      await expect(
        host.bridge.request(RequestMethod.VoiceCommandPresentAnswer, { ...answer, ...extra }),
      ).rejects.toMatchObject({ code: "BRIDGE_BAD_PARAMS" });
    }
  });
});

describe("识别与插入解耦（Host API 1.22 consumedBy / command 会话可写回）", () => {
  test("Tab 层消费的会话带 consumedBy、不插入，随后 commit 返回 expired", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    const started = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false }) as {
      deliveryTarget: { id: string };
    };
    host.consumeNextVoiceResultByTabLayer();
    const done = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" }) as {
      consumedBy?: string;
      inserted?: boolean;
    };
    expect(done.consumedBy).toBe("tab_layer");
    expect(done.inserted).toBe(false);
    await expect(
      host.bridge.request(RequestMethod.VoiceDeliverCommit, { targetId: started.deliveryTarget.id, text: "发布说明" }),
    ).resolves.toEqual({ committed: false, reason: "expired" });

    // 用完即复位：下一段不再被消费。
    const next = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false }) as {
      deliveryTarget: { id: string };
    };
    const nextDone = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" }) as { consumedBy?: string };
    expect(nextDone.consumedBy).toBeUndefined();
    await expect(
      host.bridge.request(RequestMethod.VoiceDeliverCommit, { targetId: next.deliveryTarget.id, text: "你好" }),
    ).resolves.toEqual({ committed: true });
  });

  test("Host 判定没有内容：transcript 为空、不带 audio、带 noSpeechReason，用完即复位（#1291）", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false, retainAudio: true });
    host.setNextVoiceNoSpeech("silence");
    const done = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" }) as Record<string, unknown>;
    expect(done.transcript).toBe("");
    expect(done.audio).toBeUndefined();
    expect(done.noSpeechReason).toBe("silence");
    expect(done.warningCode).toBe("no_speech");
    expect(done.inserted).toBe(false);

    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    const next = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" }) as Record<string, unknown>;
    expect(next.noSpeechReason).toBeUndefined();
    expect(next.transcript).toBe("测试语音输入");
  });

  test("command 会话的写回凭证可以 commit（插入不认业务分支）", async () => {
    const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }) });
    const started = await host.bridge.request(RequestMethod.VoiceToggle, { mode: "command" }) as {
      deliveryTarget: { id: string };
    };
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "command" });
    await expect(
      host.bridge.request(RequestMethod.VoiceDeliverCommit, { targetId: started.deliveryTarget.id, text: "Translated" }),
    ).resolves.toEqual({ committed: true });
  });
});
