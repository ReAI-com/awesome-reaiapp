import { describe, expect, test } from "bun:test";

import {
  VoiceContextRegistry,
  createWindowScreenshotProvider,
  type VoiceContextHost,
  type VoiceContextSettings,
} from "../src/voice-context";
import { buildPolishMessages, wrapTranscript } from "../src/voice-polish";

const SETTINGS: VoiceContextSettings = {
  windowEnabled: true,
  screenshotEnabled: true,
  recentVoiceEnabled: false,
  recentVoiceRangeMinutes: 5,
};

const GRANT = { sessionId: "voice-session", consentEpoch: "epoch", isCurrent: () => true };

const SHOT = {
  mime: "image/jpeg" as const,
  dataBase64: "/9j/4AAQSkZJRg==",
  width: 800,
  height: 450,
};

describe("D-5 焦点窗口截图上下文", () => {
  test("截图 provider 只在显式开启时向 Host 要截图，并把图片作为独立内容返回", async () => {
    const seen: unknown[] = [];
    const host: VoiceContextHost = {
      async capture(options) {
        seen.push(options);
        return {
          windowTextStatus: "not_requested",
          sessionEpoch: "epoch",
          screenRecording: "granted",
          windowScreenshot: SHOT,
        } as never;
      },
    };

    const outcome = await createWindowScreenshotProvider(host).collect({
      settings: SETTINGS,
      screenshot: GRANT,
      now: 0,
    });

    expect(seen).toEqual([{ includeWindowText: false, includeWindowScreenshot: true, sessionId: "voice-session", consentEpoch: "epoch" }]);
    expect(outcome).toEqual({ status: "collected", images: [SHOT] });
  });

  test("截图进入 envelope.images，但绝不被拼成附近文字或 data URL 文本", async () => {
    const host: VoiceContextHost = {
      async capture() {
        return {
          windowTextStatus: "not_requested",
          sessionEpoch: "epoch",
          screenRecording: "granted",
          windowScreenshot: SHOT,
        } as never;
      },
    };
    const registry = new VoiceContextRegistry().register(createWindowScreenshotProvider(host));
    const { envelope } = await registry.assemble({ settings: SETTINGS, screenshot: GRANT, now: 0 });

    expect(envelope).toEqual({ version: "1", images: [SHOT] });
    expect(envelope?.nearbyText).toBeUndefined();
  });

  test("关闭截图开关时零采集", async () => {
    let calls = 0;
    const host: VoiceContextHost = {
      async capture() {
        calls += 1;
        throw new Error("不该调用");
      },
    };
    const outcome = await createWindowScreenshotProvider(host).collect({
      settings: { ...SETTINGS, screenshotEnabled: false },
      screenshot: GRANT,
      now: 0,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(calls).toBe(0);
  });
});

describe("D-5 多模态润色消息", () => {
  test("旧的纯文本上下文仍使用字符串 content", () => {
    const messages = buildPolishMessages({
      level: "light",
      transcript: "发给 Alex",
      context: { version: "1", nearbyText: "邮件正文" },
    });

    expect(messages.every((message) => typeof message.content === "string")).toBeTrue();
  });

  test("有截图时仅上下文 user 消息升级成 text + image 部件，转写仍是最后一条纯文本", () => {
    const messages = buildPolishMessages({
      level: "light",
      transcript: "发给 Alex",
      context: { version: "1", nearbyText: "邮件正文", images: [SHOT] } as never,
    });
    const contextMessage = messages.at(-2)!;

    expect(contextMessage.role).toBe("user");
    expect(contextMessage.content).toEqual([
      { type: "text", text: expect.stringContaining("邮件正文") },
      { type: "image", mime: "image/jpeg", dataBase64: SHOT.dataBase64, detail: "low" },
    ]);
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content).toBe(wrapTranscript("发给 Alex", "CTX"));
  });

  test("越过 Host 截图合同的自定义图片只丢图，文字润色仍继续", () => {
    const messages = buildPolishMessages({
      level: "light",
      transcript: "发给 Alex",
      context: {
        version: "1",
        nearbyText: "邮件正文",
        images: [{ ...SHOT, width: 1025 }],
      } as never,
    });

    expect(messages.at(-2)).toEqual({
      role: "user",
      content: expect.stringContaining("邮件正文"),
    });
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content).toBe(wrapTranscript("发给 Alex", "CTX"));
  });
});
