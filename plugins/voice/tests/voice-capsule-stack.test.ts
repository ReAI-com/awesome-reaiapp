/**
 * 胶囊叠放阶段 D（主项目 plans/2026-10-23-voice-capsule-stack-plan.md §3.4 / 阶段 D）：
 * 硬件开录声明 `asyncFinish`，结束即回 `finalizing`、录音槽当场空出；每段收尾按开录时冻结的
 * 上下文在后台跑完，终稿经 `getStatus(sessionId, { waitMs })` 取回、`acknowledgeResult` 消费。
 * 旧 Host（不回 captureModel / finalizing）保持同步收尾，开录不带 asyncFinish。
 *
 * MockHost 只会同步收尾，这里在它的线路上叠一层「1.0.6 多段 Host」：开录记下异步会话，结束回
 * `finalizing`，终稿由测试决定何时放出。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, VoiceInputSettings } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  POLISH_LIGHT_DEFAULT_MIGRATION_KEY,
} from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
type Params = Record<string, unknown>;

interface AsyncSession {
  sessionId: string;
  mode: string;
  finalizing: boolean;
  released: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function harness(options: {
  /** 叠一层 1.0.6 多段 Host；false = 原样的旧 Host。 */
  asyncHost: boolean;
  settings?: Partial<VoiceInputSettings>;
  /** 改写某段的 Host 终稿（按开录先后的序号，从 0 起）。 */
  transcriptFor?: (index: number) => string;
  /** 前台结果面板按 Host 规则拒绝（VOICE_ANSWER_DEFER_REQUIRED）。 */
  deferAnswers?: boolean;
  /** 结束回执晚到：终稿当场放出，`finalizing` 回执延后这么久才回。 */
  finishReceiptDelayMs?: number;
  /** 同步收尾的结束回执不带 sessionId（旧 Host 合同允许缺省）。 */
  dropFinishSessionId?: boolean;
  hook?: (ctx: AppContext) => Promise<void> | void;
}) {
  document.body.replaceChildren();
  // 测试线路用的是本仓锁定的 SDK 运行时（不转发 waitMs）；在 SDK 入口记下插件实际传的参数。
  const statusWaits: Array<{ sessionId?: string; waitMs?: number }> = [];
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?capsule-stack=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw", ...options.settings });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free", translationTarget: "zh-CN" });
        const getStatus = ctx.voiceInput.getStatus.bind(ctx.voiceInput);
        Object.assign(ctx.voiceInput, {
          getStatus: (sessionId?: string, wait?: { waitMs?: number }) => {
            if (wait) statusWaits.push({ sessionId, waitMs: wait.waitMs });
            return getStatus(sessionId);
          },
        });
        await options.hook?.(ctx);
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const sessions = new Map<string, AsyncSession>();
  const order: string[] = [];
  const starts: Params[] = [];
  const commits: Array<{ targetId?: string; text?: string }> = [];
  const acks: string[] = [];
  const answers: Params[] = [];
  const tasks: Params[] = [];
  let listening: AsyncSession | undefined;
  let seq = 0;
  /** 接下来这么多次按 sessionId 读状态抛传输异常（Host 状态不变）。 */
  let failSessionStatus = 0;
  /** 下一次结束请求没送到 Host（传输异常，Host 仍在录）。 */
  let failNextFinish = false;
  wire.handleRequest = async (method, params) => {
    if (method === "voice.toggle" && params["action"] === "start") starts.push({ ...params });
    if (method === "voice.acknowledge-result") acks.push(String(params["sessionId"]));
    if (method === "voice.command.present-task") tasks.push({ ...params });
    if (method === "voice.command.present-answer") {
      answers.push({ ...params });
      if (options.deferAnswers && params["voiceSessionId"] && params["deferred"] !== true) {
        throw { code: "VOICE_ANSWER_DEFER_REQUIRED", message: "有新一段正在录音" };
      }
    }
    if (method === "voice.deliver.commit") {
      commits.push({ targetId: params["targetId"] as string, text: params["text"] as string });
      return { committed: true };
    }
    if (!options.asyncHost) {
      const result = await original(method, params);
      if (options.dropFinishSessionId && method === "voice.toggle" && params["action"] !== "start") {
        const { sessionId: _dropped, ...rest } = result as Params;
        return rest;
      }
      return result;
    }
    if (method === "voice.status") {
      const sessionId = params["sessionId"];
      const entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (entry && failSessionStatus > 0) {
        failSessionStatus--;
        throw { code: "BRIDGE_TIMEOUT", message: "读取状态超时" };
      }
      if (entry) {
        if (entry.released && entry.error) return { phase: "idle", sessionId, result: null, resultError: entry.error };
        if (entry.released && entry.result) return { phase: "idle", sessionId, result: entry.result };
        return { phase: entry.finalizing ? "recognizing" : "listening", sessionId, mode: entry.mode, pending: true };
      }
      const status = await original(method, params) as Params;
      return { ...status, captureModel: "span-markers-v1" };
    }
    if (method === "voice.toggle") {
      if (params["action"] === "start" && params["asyncFinish"] === true) {
        const result = await original(method, params) as Params;
        const entry: AsyncSession = {
          sessionId: String(result["sessionId"]),
          mode: String(params["mode"] ?? "input"),
          finalizing: false,
          released: false,
        };
        sessions.set(entry.sessionId, entry);
        order.push(entry.sessionId);
        listening = entry;
        return result;
      }
      if (params["action"] !== "start" && listening && (params["sessionId"] === undefined || params["sessionId"] === listening.sessionId)) {
        if (failNextFinish) {
          failNextFinish = false;
          throw { code: "BRIDGE_TIMEOUT", message: "结束请求超时" };
        }
        const entry = listening;
        listening = undefined;
        const result = await original(method, params) as Params;
        const index = order.indexOf(entry.sessionId);
        const transcript = options.transcriptFor?.(index);
        entry.result = transcript === undefined ? result : { ...result, transcript };
        entry.finalizing = true;
        if (options.finishReceiptDelayMs) {
          entry.released = true;
          await new Promise(resolve => setTimeout(resolve, options.finishReceiptDelayMs));
        }
        return { phase: "finalizing", sessionId: entry.sessionId, seq: ++seq, mode: entry.mode };
      }
    }
    return await original(method, params);
  };
  await host.installAndEnable();
  return {
    host,
    sessions,
    order,
    starts,
    statusWaits,
    commits,
    acks,
    answers,
    tasks,
    failSessionStatus: (count: number) => { failSessionStatus = count; },
    failNextFinish: () => { failNextFinish = true; },
    /** Host 自己结束正在录的那段（胶囊 ✓ / 录音上限），终稿当场放出。 */
    hostEnd: async () => {
      const entry = listening;
      if (!entry) throw new Error("没有正在录的段");
      listening = undefined;
      entry.result = await original("voice.toggle", { action: "finish", sessionId: entry.sessionId }) as Record<string, unknown>;
      entry.finalizing = true;
      entry.released = true;
    },
    /** 放出第 index 段（开录先后）的 Host 终稿。 */
    release: (index: number, error?: { code: string; message: string }) => {
      const entry = sessions.get(order[index]!);
      if (!entry) throw new Error(`没有第 ${index} 段`);
      if (error) entry.error = error;
      entry.released = true;
    },
    dispose: async () => {
      try { await host.disable(); } finally { wire.handleRequest = original; }
    },
  };
}

test("新 Host：硬件开录声明 asyncFinish，结束即回 finalizing，上一段收尾时下一段能开录", async () => {
  const h = await harness({ asyncHost: true, transcriptFor: index => `第${index + 1}段` });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect(h.starts[0]?.asyncFinish, "开录声明结束即返回").toBeTrue();
    // 第二次按键只结束这一段：Host 回 finalizing，录音槽当场空出。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "第一段进入收尾");
    // 第一段还在识别：第三次按键开出第二段，而不是 VOICE_BUSY。
    const second = await h.host.invokeCommand("com.reai.voice.toggle-input");
    expect(second.ok, "上一段收尾不挡新录音").toBeTrue();
    await until(() => h.order.length === 2, "第二段开录");
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[1]!)?.finalizing === true, "第二段进入收尾");
    expect(h.commits, "终稿没放出前不写回").toHaveLength(0);
    // 后结束的那段先出终稿：插件照样各自收尾，写回顺序由 Host 按录音结束先后放行。
    h.release(1);
    await until(() => h.commits.length === 1, "第二段写回");
    expect(h.commits[0]!.text).toBe("第2段");
    h.release(0);
    await until(() => h.commits.length === 2, "第一段写回");
    expect(h.commits[1]!.text).toBe("第1段");
    // 两段的写回目标各是自己开录时那一个（冻结的上下文没被下一段覆盖）。
    expect(h.commits[0]!.targetId).not.toBe(h.commits[1]!.targetId);
    // 终稿用 waitMs 长轮询取回，消费后逐段确认。
    expect(h.statusWaits.length).toBeGreaterThan(0);
    expect(h.statusWaits.every(wait => wait.waitMs === 20_000 && h.order.includes(wait.sessionId!))).toBeTrue();
    await until(() => h.order.every(sessionId => h.acks.includes(sessionId)), "两段都确认消费");
  } finally { await h.dispose(); }
});

test("新 Host：收尾失败只收这一段，正在录的下一段不受影响", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "第一段进入收尾");
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.order.length === 2, "第二段开录");
    // 第二段还在录时，第一段的收尾失败。
    h.release(0, { code: "VOICE_CANCELLED", message: "语音输入已取消" });
    await until(() => h.acks.includes(h.order[0]!), "被取消的那段确认消费");
    await settle();
    // 第二段的录音槽没被复位：这次按键结束的是第二段，不是另开第三段。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[1]!)?.finalizing === true, "第二段进入收尾");
    expect(h.order).toHaveLength(2);
    h.release(1);
    await until(() => h.commits.length === 1, "第二段照常写回");
    await settle();
    expect(h.commits).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("新 Host：录音中的第二段不会被上一段收尾复位", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "第一段进入收尾");
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.order.length === 2, "第二段开录");
    // 第一段收尾（写回、落历史）发生在第二段录音期间。
    h.release(0);
    await until(() => h.commits.length === 1, "第一段写回");
    await settle();
    // 第二段仍在录：下一次按键是结束它，而不是开第三段。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[1]!)?.finalizing === true, "按键结束的是第二段");
    expect(h.order).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("旧 Host：开录不带 asyncFinish，结束照旧同步收尾并写回", async () => {
  const h = await harness({ asyncHost: false });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect("asyncFinish" in (h.starts[0] ?? {}), "旧 Host 的开录参数不变").toBeFalse();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.commits.length === 1, "同步收尾写回");
    expect(h.commits[0]!.text).toBe("测试语音输入");
  } finally { await h.dispose(); }
});

test("新 Host：Agent 段的任务帧与前台结果带 voiceSessionId；Host 要求转后台时改投角落再以 deferred 呈现", async () => {
  const h = await harness({ asyncHost: true, deferAnswers: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    expect(h.starts[0]?.asyncFinish).toBeTrue();
    const sessionId = h.order[0]!;
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    await until(() => h.sessions.get(sessionId)?.finalizing === true, "命令段进入收尾");
    h.release(0);
    await until(() => h.answers.some(answer => answer["deferred"] === true), "转后台后以 deferred 呈现", 5000);
    const [foreground, deferred] = h.answers;
    expect(foreground).toMatchObject({ voiceSessionId: sessionId, status: "succeeded" });
    expect(foreground!.deferred).toBeUndefined();
    expect(deferred!.voiceSessionId, "deferred 呈现不带录音会话").toBeUndefined();
    // 先交接到角落（running），再报终态，最后弹迟到结果框（runId = 后台任务 id）。
    expect(h.tasks.map(task => task["state"])).toEqual(["running", "succeeded"]);
    expect(h.tasks.every(task => task["voiceSessionId"] === sessionId)).toBeTrue();
    expect(deferred!.runId).toBe(h.tasks[0]!["taskId"]);
    await until(() => h.acks.includes(sessionId), "Agent 段交接后确认消费，放开后面的写回");
    expect(h.commits).toHaveLength(0);
  } finally { await h.dispose(); }
}, 15_000);

test("新 Host：Agent 段 3 秒内完成且 Host 允许前台时照旧弹前台结果框", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    const sessionId = h.order[0]!;
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    await until(() => h.sessions.get(sessionId)?.finalizing === true, "命令段进入收尾");
    h.release(0);
    await until(() => h.answers.length === 1, "前台结果框");
    expect(h.answers[0]).toMatchObject({ voiceSessionId: sessionId, text: "这是测试 Agent 回复" });
    await settle();
    expect(h.tasks).toHaveLength(0);
    await until(() => h.acks.includes(sessionId), "确认消费");
  } finally { await h.dispose(); }
});

test("新 Host：Host 自己结束的段（胶囊 ✓ / 录音上限），终稿先于状态轮询到达也照常写回", async () => {
  const h = await harness({ asyncHost: true, transcriptFor: () => "Host 结束的这段" });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await h.hostEnd();
    await until(() => h.commits.length === 1, "从开录起等着的终稿被收尾");
    await until(() => h.acks.includes(h.order[0]!), "确认消费");
    // 本地已让出录音槽：下一次按键开新段，而不是去结束一段 Host 早已结束的录音。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.order.length === 2, "下一次按键开出新段");
  } finally { await h.dispose(); }
});

test("新 Host：终稿早于结束回执时只收尾一次，不重复写回", async () => {
  const h = await harness({ asyncHost: true, finishReceiptDelayMs: 600 });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.commits.length === 1, "写回一次");
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(h.commits, "迟到的 finalizing 回执不再重复收尾").toHaveLength(1);
  } finally { await h.dispose(); }
});

test("新 Host：录音中读状态连续失败不会把这段当成结束", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    h.failSessionStatus(4);
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(h.acks).toHaveLength(0);
    // 仍在录：这次按键结束它，而不是另开一段。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "按键结束的是原来那段");
    expect(h.order).toHaveLength(1);
    h.release(0);
    await until(() => h.commits.length === 1, "终稿照常写回", 8000);
  } finally { await h.dispose(); }
}, 20_000);

test("新 Host：命令段终稿是取消时也确认消费，放开后面的写回", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "命令段进入收尾");
    h.release(0, { code: "VOICE_CANCELLED", message: "语音输入已取消" });
    await until(() => h.acks.includes(h.order[0]!), "取消的命令段确认消费");
    await settle();
    expect(h.answers).toHaveLength(0);
    expect(h.tasks).toHaveLength(0);
  } finally { await h.dispose(); }
});

test("新 Host：插件停用后，后台收尾不再写回", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "进入收尾");
    await h.host.disable();
    h.release(0);
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(h.commits).toHaveLength(0);
  } finally { await h.dispose().catch(() => undefined); }
});

test("新 Host：结束请求没送到 Host（仍在录）时保持在录，再按一次能结束同一段", async () => {
  const h = await harness({ asyncHost: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    h.failNextFinish();
    await h.host.invokeCommand("com.reai.voice.toggle-input");
    await settle();
    expect(h.sessions.get(h.order[0]!)?.finalizing, "Host 仍在录").toBeFalse();
    // 本地没把录音槽让出去：再按一次结束的是同一段，而不是另开一段。
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "再按一次结束同一段");
    expect(h.order).toHaveLength(1);
    h.release(0);
    await until(() => h.commits.length === 1, "照常写回");
  } finally { await h.dispose(); }
});

test("旧 Host：结束回执不带 sessionId 时同步收尾照常复位，下一次按键能开录", async () => {
  const h = await harness({ asyncHost: false, dropFinishSessionId: true });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    await until(() => h.commits.length === 1, "同步收尾写回");
    await settle();
    // 听写的 phase / activeMode 都已复位：语音命令不会被当成「听写还在处理」挡掉。
    expect((await h.host.invokeCommand("com.reai.voice.command.agent")).ok, "收尾后能开语音命令").toBeTrue();
    await until(() => h.starts.length === 2, "收尾后复位，下一次按键开新录音");
    expect(h.starts[1]!.mode).toBe("command");
  } finally { await h.dispose(); }
});

test("新 Host：结束回执在停用之后才到，不再登记收尾段、不再等终稿", async () => {
  const h = await harness({ asyncHost: true, finishReceiptDelayMs: 400 });
  try {
    expect((await h.host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    void h.host.invokeCommand("com.reai.voice.toggle-input").catch(() => undefined);
    await until(() => h.sessions.get(h.order[0]!)?.finalizing === true, "结束请求已送达 Host");
    const waitsBefore = h.statusWaits.length;
    await h.host.disable();
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(h.commits).toHaveLength(0);
    // 停用后没有新的终稿等待者（迟到的 finalizing 没有重新登记这段）。
    expect(h.statusWaits.length).toBeLessThanOrEqual(waitsBefore + 1);
  } finally { await h.dispose().catch(() => undefined); }
});
