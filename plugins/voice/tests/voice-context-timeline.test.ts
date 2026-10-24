import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import { contextSegmentRuns } from "../src/context-display";
import { createDefaultVoiceViewState, type VoiceViewState } from "../src/data";
import { dayKeyOf, digestPointSegments, parseDigestPoints, splitDigestPoint, type VoiceDayDigest } from "../src/voice-digest";
import { planDigestWork } from "../src/voice-digest-scheduler";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

function at(hours: number, minutes: number, dayOffset = 0): number {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

function segment(id: string, startMs: number, text: string, durationMs = 5 * 60_000): VoiceRecordingSegment {
  return {
    id,
    wallStartMs: startMs,
    durationMs,
    transport: "usb_vendor_hid",
    transcriptText: text,
    transcribedAtMs: startMs + durationMs,
    transcriptStatus: "complete",
  } as VoiceRecordingSegment;
}

function mount(overrides: Partial<VoiceViewState>, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const loaded: string[] = [];
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onNavigated: () => undefined,
    onSettingsChanged: async () => undefined,
    onDeleteRecording: async () => undefined,
    onSendContextToAgent: async () => undefined,
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onLoadReplayAudio: async (id: string) => {
      loaded.push(id);
      return new Blob([new Uint8Array([1])], { type: "audio/wav" });
    },
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async () => undefined,
    ...extra,
  } as unknown as VoiceViewActions;
  const view = mountVoiceView(root, createDefaultVoiceViewState(overrides), actions);
  (root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
  return { root, view, loaded };
}

describe("Context 时间线：连续空段合并", () => {
  test("只有相邻的已转写空段成组；有话的段与待转写段各自成行", () => {
    const pending = { ...segment("p", at(9, 0), ""), transcriptStatus: "pending" } as VoiceRecordingSegment;
    const runs = contextSegmentRuns([
      segment("a", at(10, 0), "。"),
      segment("b", at(9, 55), "，"),
      segment("c", at(9, 50), "下午开会"),
      segment("d", at(9, 45), "。"),
      pending,
      segment("e", at(8, 55), "。"),
    ]);
    expect(runs.map((run) => run.map((item) => item.id))).toEqual([["a", "b"], ["c"], ["d"], ["p"], ["e"]]);
  });

  test("一串空段收成一行，标出时段与段数；展开后各段仍点得进详情", () => {
    const recordings = [
      segment("s1", at(10, 20), "定了周五发版"),
      segment("e1", at(10, 10), "。"),
      segment("e2", at(10, 5), "。。"),
      segment("e3", at(10, 0), "…"),
    ];
    const { root, view } = mount({ recordings, recordingsTotal: recordings.length });
    const runs = root.querySelectorAll<HTMLDetailsElement>(".ctx-empty-run");
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.querySelector("summary .ctx-seg-empty-range")?.textContent).toBe("10:00 – 10:15");
    expect(run.querySelector("summary .ctx-seg-empty-label")?.textContent).toBe("无人说话 · 3 段");
    expect(run.querySelectorAll(".ctx-empty-run-body .ctx-seg")).toHaveLength(3);
    // 有话的那段在外面，正常一行。
    expect(root.querySelectorAll(".ctx-timeline > .ctx-seg")).toHaveLength(1);
    run.open = true;
    (run.querySelector('.ctx-empty-run-body .ctx-seg[data-recording-id="e2"]') as HTMLButtonElement).click();
    expect(root.querySelector(".ctx-view")).not.toBeNull();
    view.dispose();
  });
});

describe("Context 时间线：加载更早的记录", () => {
  test("列表没翻完才出现按钮；点下去交给 app 翻页，忙态禁用", async () => {
    let calls = 0;
    const recordings = [segment("s1", at(10, 0), "你好")];
    const { root, view } = mount({ recordings, recordingsTotal: 120 }, {
      onLoadMoreRecordings: async () => { calls += 1; },
    });
    const more = root.querySelector('[data-action="load-more-recordings"]') as HTMLButtonElement;
    expect(more.textContent).toBe("加载更早的记录");
    more.click();
    await Promise.resolve();
    expect(calls).toBe(1);
    view.update(createDefaultVoiceViewState({ recordings, recordingsTotal: 120, recordingsLoadingMore: true }));
    const busy = root.querySelector('[data-action="load-more-recordings"]') as HTMLButtonElement;
    expect(busy.disabled).toBeTrue();
    view.update(createDefaultVoiceViewState({ recordings, recordingsTotal: 1 }));
    expect(root.querySelector('[data-action="load-more-recordings"]')).toBeNull();
    view.dispose();
  });
});

describe("当日总结：要点可点到来源段", () => {
  test("来源时刻标记被拆出、截断后仍保留，坏标记不猜", () => {
    expect(splitDigestPoint("周五前交初稿〔09:48、14:03〕")).toEqual({ text: "周五前交初稿", times: ["09:48", "14:03"] });
    expect(splitDigestPoint("确认预算 [9:05]")).toEqual({ text: "确认预算", times: ["09:05"] });
    expect(splitDigestPoint("没有来源")).toEqual({ text: "没有来源", times: [] });
    expect(splitDigestPoint("时刻不对〔25:61〕").times).toEqual([]);
    const [long] = parseDigestPoints(`- ${"很".repeat(300)}〔10:00〕`);
    expect(long!.endsWith("…〔10:00〕")).toBeTrue();
  });

  test("时刻落在哪段的时间范围里就指向哪段，找不到不就近硬凑", () => {
    const morning = segment("m", at(9, 45), "a", 10 * 60_000);
    const noon = segment("n", at(12, 0), "b", 5 * 60_000);
    expect(digestPointSegments(["09:48"], [morning, noon]).map((item) => item.id)).toEqual(["m"]);
    expect(digestPointSegments(["12:04", "09:45"], [morning, noon]).map((item) => item.id)).toEqual(["m", "n"]);
    expect(digestPointSegments(["11:00"], [morning, noon])).toEqual([]);
  });

  test("展开总结后点时刻钮进入那一段的原文", () => {
    const todayKey = dayKeyOf(new Date());
    const recordings = [segment("n", at(12, 0), "午饭后对一下排期"), segment("m", at(9, 45), "周五前交初稿", 10 * 60_000)];
    const digest: VoiceDayDigest = {
      dayKey: todayKey,
      points: ["周五前交初稿〔09:48〕", "旧总结没有标记"],
      segs: 2,
      chars: 10,
      fromMs: at(9, 45),
      toMs: at(12, 5),
      createdAt: new Date().toISOString(),
      final: false,
      sourceKey: "x",
    };
    const { root, view, loaded } = mount({ recordings, recordingsTotal: 2, dayDigests: { [todayKey]: digest } });
    (root.querySelector(".ctx-dg-row") as HTMLButtonElement).click();
    const items = root.querySelectorAll(".ctx-sum-i");
    expect(items[0]?.querySelector(".ctx-sum-tx")?.textContent).toBe("周五前交初稿");
    expect(items[1]?.querySelector("button")).toBeNull();
    const jump = items[0]!.querySelector('[data-action="open-digest-source"]') as HTMLButtonElement;
    expect(jump.textContent).toBe("09:45");
    jump.click();
    expect(root.querySelector(".ctx-view")).not.toBeNull();
    expect(root.querySelector('.ctx-tab[data-ctx-pane="raw"]')?.getAttribute("aria-selected")).toBe("true");
    expect(loaded).toContain("m");
    view.dispose();
  });
});

describe("总结调度：分页截断的那一天", () => {
  test("过去的天只翻到一截时不重合，免得把完整总结覆盖成残缺的；今天照常", () => {
    const now = at(18, 0);
    const today = [segment("t1", at(10, 0), "今天")];
    const partialYesterday = [segment("y2", at(20, 0, -1), "昨天晚上")];
    const plan = planDigestWork({ recordings: [...today, ...partialYesterday], digests: {}, nowMs: now, listComplete: false });
    expect(plan.generate.map((item) => item.dayKey)).toEqual([dayKeyOf(new Date(now))]);
    const complete = planDigestWork({ recordings: [...today, ...partialYesterday], digests: {}, nowMs: now, listComplete: true });
    expect(complete.generate).toHaveLength(2);
    const onlyToday = planDigestWork({ recordings: today, digests: {}, nowMs: now, listComplete: false });
    expect(onlyToday.generate).toHaveLength(1);
  });
});
