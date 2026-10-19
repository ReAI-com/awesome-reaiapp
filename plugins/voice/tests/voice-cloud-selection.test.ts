import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, VOICE_FEATURE_SETTINGS_KEY } from "../src/data";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { cloudModelsRetryTiming } from "../src/cloud-models-retry";
beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
const productionRetryTiming = { ...cloudModelsRetryTiming };
afterEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); Object.assign(cloudModelsRetryTiming, productionRetryTiming); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await tick();
  expect(check()).toBeTrue();
}
const key = (name: string) => `com.reai.voice/voice-state/${name}`;
const options = [
  { id: "transcribe-paid", kind: "transcribe" as const, label: "Paid model" },
  { id: "transcribe-free", kind: "transcribe" as const, label: "Free model" },
];
async function harness(id = "transcribe-default", engine = "local", fresh = false, trusted = false, initialSaveFails = false, freeOnly = false, legacySdk = false, initialModels: readonly Record<string, unknown>[] = options, extra: { developerMode?: boolean; failInitialList?: string | null } = {}) {
  const host = new MockHost({ manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const module = await import("../src/app");
      if (!legacySdk) return module;
      return { default: { ...module.default, activate(ctx: Parameters<NonNullable<typeof module.default.activate>>[0]) {
        Reflect.deleteProperty(ctx.aiApi, "freeOnlyTranscriptionSupported");
        return module.default.activate!(ctx);
      } } };
    }, createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; } });
  host.setVoiceContextCapture({ sessionEpoch: "voice-cloud-test-account" });
  const internals = host as unknown as { storage: Map<string, unknown>; handleRequest(method: string, params: unknown): Promise<unknown> };
  if (!fresh) internals.storage.set(key("settings"), { ...DEFAULT_SETTINGS, engine, polish: "raw" });
  internals.storage.set(key(VOICE_FEATURE_SETTINGS_KEY), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: id, ...(freeOnly ? { cloudModelBillingPolicy: "free-only" } : {}) });
  host.setCloudModels(initialModels as unknown as typeof options);
  let models = structuredClone(initialModels).map(m => trusted && m.id === "transcribe-free" ? { ...m, isDefault: true, billingPolicy: "free" as const } : m) as typeof options, listFails = extra.failInitialList !== undefined, saveFails = initialSaveFails, listCalls = 0;
  let listFailureCode: string | undefined = extra.failInitialList ?? undefined;
  let listGate: (() => Promise<void>) | undefined;
  let saveGate: (() => Promise<void>) | undefined;
  const sentModels: string[] = [];
  const sentPolicies: unknown[] = [];
  const original = internals.handleRequest.bind(host);
  internals.handleRequest = async (method, params) => {
    if (method === "environment.get") return { developerMode: extra.developerMode ?? true };
    if (method === "ai.models.list") {
      listCalls++;
      const snapshot = structuredClone(models), gate = listGate; listGate = undefined;
      if (gate) await gate();
      if (listFails) throw Object.assign(new Error("catalog temporarily unavailable"), { code: listFailureCode });
      return { models: snapshot };
    }
    if (method === "storage.set" && JSON.stringify(params).includes(VOICE_FEATURE_SETTINGS_KEY) && saveGate) {
      const gate = saveGate; saveGate = undefined; await gate();
    }
    if (method === "storage.set" && saveFails && JSON.stringify(params).includes(VOICE_FEATURE_SETTINGS_KEY)) throw new Error("selection could not be saved");
    if (method === "ai.audio.transcribe") {
      const id = (params as { model: string }).model; sentModels.push(id); sentPolicies.push((params as { billingPolicy?: string }).billingPolicy);
      if (listFails) throw new Error("Host configuration temporarily unavailable");
      if (!models.some(m => m.id === id)) throw new Error("Host selected option unavailable");
    }
    return original(method, params);
  };
  await host.installAndEnable(); let surface = await host.openSurface("main");
  const root = () => surface.root!;
  const select = () => root().querySelector<HTMLSelectElement>(".settings-cloud-model")!;
  const featureId = () => (internals.storage.get(key(VOICE_FEATURE_SETTINGS_KEY)) as { cloudModelId: string }).cloudModelId;
  const engineValue = () => (internals.storage.get(key("settings")) as { engine: string }).engine;
  const open = async () => { await host.invokeCommand("com.reai.voice.open-settings"); await tick(); };
  const setEngine = async (next: string) => {
    const label = next === "cloud" ? "云端引擎" : "本地引擎";
    Array.from(root().querySelectorAll<HTMLButtonElement>(".settings-seg button")).find(b => b.textContent === label)!.click();
    await until(() => engineValue() === next); await tick();
  };
  const choose = async (id: string) => { select().value = id; select().dispatchEvent(new Event("change")); await until(() => featureId() === id); await tick(); };
  // invokeCommand's short automatic flush cannot cover deliberately held storage/list calls.
  // Wait for the actual command settlement so this exercises the production save queue.
  let commandSequence = 0;
  const toggle = async () => {
    const bus = host as unknown as {
      dispatch(event: unknown): void;
      settlements: Map<string, { ok: boolean }>;
    };
    const correlationId = `cloud-selection-${++commandSequence}`;
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-input",
      correlationId, input: {}, timeoutMs: 5000 });
    await until(() => bus.settlements.has(correlationId));
  };
  const transcribe = async () => { await toggle(); await toggle(); await tick(); };
  return { host, root, select, open, choose, setEngine, featureId, engineValue, sentModels, sentPolicies, transcribe,
    features: () => internals.storage.get(key(VOICE_FEATURE_SETTINGS_KEY)) as typeof DEFAULT_VOICE_FEATURE_SETTINGS,
    recoverSave: () => { saveFails = false; },
    switchAccount: () => host.setVoiceContextCapture({ sessionEpoch: "second-account" }),
    replaceAccountFeatures: (id: string) => internals.storage.set(key(VOICE_FEATURE_SETTINGS_KEY), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: id }),
    holdNextSave: () => {
      let release!: () => void, started = false;
      const held = new Promise<void>(resolve => { release = resolve; });
      saveGate = async () => { started = true; await held; };
      return { release, started: () => started };
    },
    history: () => internals.storage.get(key("history")) as import("../src/data").VoiceHistoryItem[],
    holdNextList: () => {
      let release!: () => void, started = false;
      const held = new Promise<void>(resolve => { release = resolve; });
      listGate = async () => { started = true; await held; };
      return { release, started: () => started };
    },
    models: (next: readonly Record<string, unknown>[]) => { models = next as typeof options; host.setCloudModels(next as typeof options); }, failList: (code?: string) => { listFails = true; listFailureCode = code; }, failSave: () => { saveFails = true; },
    present: () => host.presentSurface(surface.surfaceMountId),
    setDeveloperMode: async (developerMode: boolean) => {
      const bus = host as unknown as { dispatch(event: unknown): void; runtimeSessionId: string };
      bus.dispatch({ type: "environment.changed", runtimeSessionId: bus.runtimeSessionId, developerMode }); await tick();
    },
    recoverList: () => { listFails = false; models = structuredClone(options); host.setCloudModels(options); }, listCalls: () => listCalls,
    refresh: async () => { await host.unmountSurface(surface.surfaceMountId); surface = await host.openSurface("main"); await open(); },
    restart: async () => { await host.unmountSurface(surface.surfaceMountId); await host.disable(); await host.installAndEnable(); surface = await host.openSurface("main"); await open(); },
    close: async () => { await host.unmountSurface(surface.surfaceMountId); await host.disable(); } };
}
test("legacy ordinary switch does not pretend first paid model is selected; explicit choice persists, is sent, and survives restart", async () => {
  const h = await harness(); try {
    await h.open(); await h.setEngine("cloud"); expect(h.featureId()).toBe("transcribe-default"); expect(h.select().value).toBe(h.featureId());
    expect(h.select().selectedOptions[0]!.textContent).toContain(t("view.cloudOptionsUnavailable")); await h.transcribe(); expect(h.sentModels).toEqual([]);
    await h.choose("transcribe-free"); await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-free"]);
    await h.restart(); expect(h.select().value).toBe("transcribe-free"); expect(h.featureId()).toBe("transcribe-free"); expect(h.root().querySelector(".voice-recognition-setup")).toBeNull();
  } finally { await h.close(); }
});

for (const failure of ["error", "empty"] as const) {
  test(`reopened settings recover saved free choice after a temporary ${failure} without manual refresh`, async () => {
    // A failed read has nothing cached to keep only when no list was read yet; an empty snapshot always wins.
    const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options,
      failure === "error" ? { failInitialList: "AI_NETWORK_ERROR" } : {});
    try {
      await h.open();
      if (failure === "empty") { expect(h.select().value).toBe("transcribe-free"); h.models([]); await h.refresh(); }
      await until(() => h.select().disabled);
      expect(h.featureId()).toBe("transcribe-free");
      h.recoverList();
      // Waiting is the only action: the persisted choice must reappear on its own.
      await until(() => h.select().value === "transcribe-free" && !h.select().disabled);
      expect(h.featureId()).toBe("transcribe-free");
      expect(h.sentModels).toEqual([]);
    } finally { await h.close(); }
  });
}

for (const failure of ["empty", "rejected"] as const) {
  test(`§6.0 诊断：${failure === "empty" ? "真的收到空列表才写「列表为空」" : "无码的请求拒绝不说成「列表为空」"}`, async () => {
    const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options,
      failure === "rejected" ? { failInitialList: null } : {});
    try {
      await h.open();
      if (failure === "empty") { h.models([]); await h.refresh(); }
      await until(() => h.select().disabled);
      const block = () => h.root().querySelector<HTMLElement>("[data-diag-key^='settings:cloud-models:'] .voice-diag-toggle");
      await until(() => !!block());
      block()!.click();
      await until(() => !!h.root().querySelector("[data-diag-key^='settings:cloud-models:'] .voice-diag-panel"));
      const panel = h.root().querySelector("[data-diag-key^='settings:cloud-models:'] .voice-diag-panel")!.textContent ?? "";
      if (failure === "empty") expect(panel).toContain(t("diagnostics.cloudModelsEmpty"));
      else {
        expect(panel).not.toContain(t("diagnostics.cloudModelsEmpty"));
        expect(panel).toContain("catalog temporarily unavailable");
      }
    } finally { await h.close(); }
  });
}

test("a pending catalog is shown as loading, then updates in place without another user action", async () => {
  const h = await harness("transcribe-free", "cloud");
  let release: (() => void) | undefined;
  try {
    await h.open(); h.models([]); await h.refresh();
    expect(h.root().textContent).toContain(t("view.cloudSelectionRetained"));
    expect(h.root().textContent).not.toContain(t("view.cloudOptionRequired"));
    h.recoverList(); const gate = h.holdNextList(); release = gate.release;
    await h.refresh(); await until(gate.started);
    expect(h.select().getAttribute("aria-busy")).toBe("true");
    expect(h.select().selectedOptions[0]!.textContent).toContain("transcribe-free");
    for (const locale of ["en", "zh"] as const) {
      h.host.setLocale(locale);
      expect(h.select().selectedOptions[0]!.textContent).toContain("transcribe-free");
    }
    gate.release();
    await until(() => h.select().value === "transcribe-free" && !h.select().disabled);
    expect(h.select().getAttribute("aria-busy")).toBe("false");
    expect(h.featureId()).toBe("transcribe-free");
  } finally { release?.(); await h.close(); }
});

test("persistent unavailability stops after the bounded retry budget and manual refresh can recover", async () => {
  cloudModelsRetryTiming.delaysMs = [20, 20, 20, 20, 20];
  const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options, { failInitialList: "AI_UNAVAILABLE" });
  try {
    await h.open();
    await new Promise(resolve => setTimeout(resolve, 600));
    const settled = h.listCalls();
    await new Promise(resolve => setTimeout(resolve, 300));
    // One initial read plus exactly the five-step budget; then nothing more on its own.
    expect(h.listCalls()).toBe(settled);
    expect(settled).toBeGreaterThanOrEqual(6);
    expect(h.select().disabled).toBeTrue(); expect(h.select().value).toBe(h.featureId());
    expect(h.featureId()).toBe("transcribe-free");
    expect(h.root().textContent).toContain(t("view.cloudSelectionRetained"));
    h.recoverList();
    const reload = Array.from(h.root().querySelectorAll<HTMLButtonElement>(".settings-link-btn"))
      .find(button => button.textContent === t("view.refresh"))!;
    reload.click();
    await until(() => h.select().value === "transcribe-free" && !h.select().disabled);
    expect(h.listCalls()).toBeGreaterThan(settled);
  } finally { await h.close(); }
});

for (const code of ["AI_NOT_LOGGED_IN", "AI_NOT_GRANTED", "AI_DISABLED"]) {
  test(`catalog ${code} does not trigger background retries`, async () => {
    const h = await harness("transcribe-free", "cloud");
    try {
      await h.open(); h.failList(code); const before = h.listCalls();
      await h.refresh(); await new Promise(resolve => setTimeout(resolve, 1150));
      expect(h.listCalls() - before).toBe(1);
      expect(h.featureId()).toBe("transcribe-free");
    } finally { await h.close(); }
  });
}

test("closing the plugin cancels catalog retry work", async () => {
  const h = await harness("transcribe-free", "cloud");
  await h.open(); h.failList("AI_NETWORK_ERROR"); await h.refresh();
  const calls = h.listCalls();
  await h.close(); await new Promise(resolve => setTimeout(resolve, 1150));
  expect(h.listCalls()).toBe(calls);
});

test("a late catalog from a disabled activation cannot overwrite the restarted plugin", async () => {
  const h = await harness("transcribe-free", "cloud");
  let release: (() => void) | undefined;
  try {
    await h.open(); h.models([]);
    const gate = h.holdNextList(); release = gate.release;
    await h.refresh(); await until(gate.started);
    h.recoverList(); await h.restart();
    expect(h.select().value).toBe("transcribe-free");
    const calls = h.listCalls(); gate.release();
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(h.select().value).toBe("transcribe-free");
    expect(h.select().disabled).toBeFalse(); expect(h.listCalls()).toBe(calls);
  } finally { release?.(); await h.close(); }
});
test("valid paid selection is retained across engine switches and sent exactly", async () => {
  const h = await harness("transcribe-paid"); try {
    await h.open(); await h.setEngine("cloud"); expect(h.select().value).toBe("transcribe-paid"); await h.setEngine("local"); await h.setEngine("cloud");
    await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-paid"]);
  } finally { await h.close(); }
});
test("removed selection is shown unavailable, never replaced; Host decides its exact request error", async () => {
  const h = await harness("transcribe-removed", "cloud"); try {
    await h.open(); expect(h.select().value).toBe(h.featureId()); expect(h.featureId()).toBe("transcribe-removed"); await h.transcribe();
    expect(h.sentModels).toEqual(["transcribe-removed"]); expect(h.root().textContent).toContain("Host selected option unavailable");
  } finally { await h.close(); }
});
test("Host locale updates an unavailable selection in place without saving or requesting a replacement", async () => {
  const h = await harness("transcribe-removed", "cloud");
  try {
    await h.open();
    const select = h.select();
    const labels = Array.from(select.options).slice(1).map(option => option.textContent);
    select.focus();
    for (const locale of ["en", "zh"] as const) {
      h.host.setLocale(locale);
      expect(h.select()).toBe(select);
      expect(select.options[0].textContent).toContain(t("view.cloudOptionsUnavailable"));
      expect(select.getAttribute("aria-label")).toBe(t("view.chooseACloudModel"));
      expect(Array.from(select.options).slice(1).map(option => option.textContent)).toEqual(labels);
      expect(document.activeElement).toBe(select);
      expect(select.value).toBe(h.featureId());
      expect(h.featureId()).toBe("transcribe-removed");
      expect(h.engineValue()).toBe("cloud");
      expect(h.sentModels).toEqual([]);
      expect(h.host.voiceInputRequests.filter(request => request.method === "voice.toggle")).toHaveLength(0);
    }
  } finally { await h.close(); }
});
test("unavailable catalog disables selector without overwriting saved paid ID or inventing replacement", async () => {
  const h = await harness("transcribe-paid", "cloud", false, false, false, false, false, options, { failInitialList: null }); try {
    await h.open(); await until(() => h.select().disabled); expect(h.select().value).toBe(h.featureId()); expect(h.featureId()).toBe("transcribe-paid");
    await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-paid"]); expect(h.root().textContent).toContain("Host configuration temporarily unavailable");
  } finally { await h.close(); }
});
test("a failed reread for the same account keeps the shown options usable and the saved ID", async () => {
  const h = await harness("transcribe-paid", "cloud"); try {
    await h.open(); expect(h.select().disabled).toBeFalse();
    h.failList(); await h.refresh(); await tick();
    expect(h.select().disabled).toBeFalse(); expect(h.select().value).toBe("transcribe-paid");
    expect(h.featureId()).toBe("transcribe-paid");
    expect(h.root().querySelector("[data-warn='cloud-models']")).toBeNull();
  } finally { await h.close(); }
});
test("failed selection save restores visible persisted choice and reports failure", async () => {
  const h = await harness("transcribe-paid", "cloud"); try {
    await h.open(); h.failSave(); h.select().value = "transcribe-free"; h.select().dispatchEvent(new Event("change")); await until(() => h.root().textContent!.includes("selection could not be saved"));
    expect(h.featureId()).toBe("transcribe-paid"); expect(h.select().value).toBe("transcribe-paid");
  } finally { await h.close(); }
});

for (const [code, messageKey] of [[undefined, "view.cloudModelsUnavailable"], ["AI_NOT_GRANTED", "app.cloudRecognitionPermissionIsNotEnabledIn"], ["AI_NOT_LOGGED_IN", "app.signInFirst"]] as const) {
  test(`failed catalog save has reactive localized guidance and preserves saved ID: ${code ?? "temporary"}`, async () => {
    // No list was ever read, so choosing must read one and report why it cannot.
    const h = await harness("transcribe-paid", "cloud", false, false, false, false, false, options, { failInitialList: code ?? null }); try {
      await h.open();
      h.select().value = "transcribe-free"; h.select().dispatchEvent(new Event("change"));
      await until(() => h.root().querySelector(".settings-error")?.textContent?.includes(t(messageKey)) === true);
      expect(h.featureId()).toBe("transcribe-paid");
      setVoiceLocale("en");
      expect(h.root().querySelector(".settings-error")?.textContent).toContain(t(messageKey));
      expect(h.root().querySelector(".settings-error")?.textContent).not.toContain("catalog temporarily unavailable");
    } finally { await h.close(); }
  });
}

test("fresh first-run default is persisted, displayed and requested; reopening never applies a new default", async () => {
  const h = await harness("transcribe-default", "local", true, true);
  try {
    await until(() => !!h.root().querySelector(".voice-recognition-setup"));
    h.root().querySelectorAll<HTMLButtonElement>(".voice-recognition-choice button")[1]!.click();
    await until(() => h.featureId() === "transcribe-free");
    await until(() => !h.root().querySelector(".voice-recognition-setup"));
    await h.open(); expect(h.select().value).toBe("transcribe-free");
    await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-free"]);
    h.models([options[1]!, options[0]!]); await h.restart();
    expect(h.select().value).toBe("transcribe-free");
  } finally { await h.close(); }
});
test("queued explicit model changes preserve the last saved choice and an overlapping transcription waits for it", async () => {
  const h = await harness("transcribe-paid", "cloud");
  const gate = { release: () => undefined };
  try {
    await h.open();
    // Switching validates against the list already read; the save itself is what queues.
    const saveGate = h.holdNextSave();
    h.select().value = "transcribe-free"; h.select().dispatchEvent(new Event("change"));
    await until(saveGate.started);
    h.select().value = "transcribe-paid"; h.select().dispatchEvent(new Event("change"));
    const transcript = h.transcribe();
    await tick(); expect(h.sentModels).toEqual([]);
    saveGate.release(); await transcript;
    await until(() => h.featureId() === "transcribe-paid");
    expect(h.select().value).toBe("transcribe-paid"); expect(h.sentModels).toEqual(["transcribe-paid"]);
  } finally { gate.release(); await h.close(); }
});
test("a recording keeps its original cloud model after settings change before finish", async () => {
  const h = await harness("transcribe-paid", "cloud");
  try {
    await h.open();
    await h.host.invokeCommand("com.reai.voice.toggle-input");
    await h.choose("transcribe-free");
    await h.host.invokeCommand("com.reai.voice.toggle-input");
    await tick();
    expect(h.sentModels).toEqual(["transcribe-paid"]);
    expect(h.history()[0]?.originalSelection?.modelId).toBe("transcribe-paid");
    expect(h.history()[0]?.originalSelection?.modelName).toBe("Paid model");
    await h.restart();
    expect(h.history()[0]?.originalSelection?.modelId).toBe("transcribe-paid");
  } finally { await h.close(); }
});

test("an older successful list cannot resurrect options after a newer empty snapshot", async () => {
  const h = await harness("transcribe-paid", "cloud");
  let release: (() => void) | undefined;
  try {
    await h.open(); const gate = h.holdNextList(); release = gate.release;
    await h.refresh(); await until(gate.started);
    h.models([]); await h.refresh(); expect(h.select().disabled).toBeTrue();
    gate.release(); await tick(); expect(h.select().disabled).toBeTrue();
    expect(h.select().value).toBe(h.featureId()); expect(h.featureId()).toBe("transcribe-paid");
  } finally { release?.(); await h.close(); }
});

for (const id of ["", "transcribe-default", "illegal", "transcribe-removed"]) {
  test(`successful catalog durably repairs ${id || "empty"} to trusted free default without changing engine`, async () => {
    const h = await harness(id, "local", false, true);
    try {
      await until(() => h.featureId() === "transcribe-free");
      expect(h.features().cloudModelBillingPolicy).toBe("free-only");
      expect(h.engineValue()).toBe("local");
      await h.open(); await h.setEngine("cloud");
      expect(h.select().value).toBe("transcribe-free");
      expect(Array.from(h.select().options).some(o => o.value === "")).toBeFalse();
      await h.transcribe();
      expect(h.host.cloudRequests.find(r => r.method === "ai.audio.transcribe")?.params).toMatchObject({ model: "transcribe-free", billingPolicy: "free-only" });
      await h.restart(); expect(h.features().cloudModelBillingPolicy).toBe("free-only");
    } finally { await h.close(); }
  });
}

test("automatic free selection save failure keeps old selection visible and retries via refresh", async () => {
  const h = await harness("transcribe-removed", "cloud", false, true, true);
  try {
    await h.open(); await until(() => h.root().textContent!.includes("selection could not be saved"));
    expect(h.featureId()).toBe("transcribe-removed"); expect(h.select().value).toBe("transcribe-removed");
    expect(h.features().cloudModelBillingPolicy).toBeUndefined();
    h.recoverSave(); await h.refresh(); await until(() => h.featureId() === "transcribe-free");
    expect(h.features().cloudModelBillingPolicy).toBe("free-only");
  } finally { await h.close(); }
});

test("valid paid selection remains metered despite a trusted free default", async () => {
  const h = await harness("transcribe-paid", "cloud", false, true);
  try { await h.open(); expect(h.featureId()).toBe("transcribe-paid"); expect(h.features().cloudModelBillingPolicy).toBeUndefined(); }
  finally { await h.close(); }
});

test("late account catalog cannot repair the current account choice", async () => {
  const h = await harness("transcribe-paid", "cloud", false, true);
  let release: (() => void) | undefined;
  try {
    await h.open();
    h.models([{ ...options[1]!, isDefault: true, billingPolicy: "free" } as typeof options[number]]);
    const gate = h.holdNextList(); release = gate.release;
    await h.refresh(); await until(gate.started); h.switchAccount(); gate.release(); await tick();
    expect(h.featureId()).toBe("transcribe-paid"); expect(h.features().cloudModelBillingPolicy).toBeUndefined();
  } finally { release?.(); await h.close(); }
});

test("saved free-only intent survives default changes, recording changes, and restart", async () => {
  const h = await harness("", "cloud", false, true);
  try {
    await until(() => h.featureId() === "transcribe-free"); await h.open();
    h.models(options.map(m => m.id === "transcribe-free" ? { ...m, isDefault: false, billingPolicy: "free" } : m)); await h.refresh();
    expect(h.features().cloudModelBillingPolicy).toBe("free-only");
    await h.host.invokeCommand("com.reai.voice.toggle-input");
    await h.choose("transcribe-paid");
    await h.host.invokeCommand("com.reai.voice.toggle-input"); await tick();
    expect(h.host.cloudRequests.find(r => r.method === "ai.audio.transcribe")?.params).toMatchObject({ model: "transcribe-free", billingPolicy: "free-only" });
    expect(h.history()[0]?.originalSelection).toMatchObject({ modelId: "transcribe-free", billingPolicy: "free-only" });
    await h.restart(); expect(h.history()[0]?.originalSelection).toMatchObject({ billingPolicy: "free-only" });
    expect(h.features().cloudModelBillingPolicy).toBeUndefined();
  } finally { await h.close(); }
});

test("account change during automatic save suppresses publication; new activation rereads its saved choice", async () => {
  const h = await harness("transcribe-paid", "cloud", false, true);
  let release: (() => void) | undefined;
  try {
    await h.open();
    h.models([{ ...options[1]!, isDefault: true, billingPolicy: "free" } as typeof options[number]]);
    const gate = h.holdNextSave(); release = gate.release;
    await h.refresh(); await until(gate.started);
    h.switchAccount(); gate.release(); await until(() => h.featureId() === "transcribe-free"); await tick();
    // MockHost has one map: the completed write represents the retired account's store.
    // It must never be published into the current account's visible selection.
    expect(h.select().value).toBe("transcribe-paid");
    h.replaceAccountFeatures("transcribe-paid"); h.models(options); await h.restart();
    expect(h.select().value).toBe("transcribe-paid"); expect(h.features().cloudModelBillingPolicy).toBeUndefined();
  } finally { release?.(); await h.close(); }
});

for (const path of ["live", "service"] as const) {
  for (const legacySdk of [false, true]) {
  test(`persisted free-only ${path} blocks ${legacySdk ? "an old SDK despite free metadata" : "an old catalog without billing metadata"}`, async () => {
    const h = await harness("transcribe-free", "cloud", false, legacySdk, false, true, legacySdk);
    try {
      await h.open();
      if (path === "live") await h.transcribe();
      else {
        const serviceId = "com.reai.voice/request-text@1";
        const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
        const caller = { appId: "com.example.consumer", surfaceMountId: "consumer", runtimeSessionId: "consumer-runtime", accountGeneration: "voice-cloud-test-account" };
        const pending = h.host.invokeService(serviceId, "request-text", input, caller);
        await until(() => h.host.voiceInputRequests.some(r => r.method === "voice.toggle"));
        await h.host.invokeService(serviceId, "finish", input, caller);
        await pending.catch(() => undefined);
      }
      expect(h.sentModels).toEqual([]);
      expect(h.features().cloudModelBillingPolicy).toBe("free-only");
      expect(h.engineValue()).toBe("cloud");
    } finally { await h.close(); }
  });
}
}

const accountModel = (policy: "free" | "metered", id = "transcribe-account") => ({
  id, kind: "transcribe" as const, label: "Current account model", isDefault: true,
  pricingContext: "current-account" as const, billingPolicy: policy,
});

for (const locale of ["zh", "en"] as const) {
  test(`request-text missing cloud selection preserves the registered code and specific message: ${locale}`, async () => {
    const h = await harness("transcribe-default", "cloud");
    const serviceId = "com.reai.voice/request-text@1";
    const input = { requestId: `${Date.now()}:${crypto.randomUUID()}` };
    const caller = { appId: "com.example.consumer", surfaceMountId: "consumer", runtimeSessionId: "consumer-runtime", accountGeneration: "voice-cloud-test-account" };
    try {
      h.host.setLocale(locale);
      await tick();
      const result = await h.host.invokeService(serviceId, "request-text", input, caller);
      expect(result).toMatchObject({ ok: false, error: {
        code: "com.reai.voice/CLOUD_MODEL_SELECTION_REQUIRED",
        // The registered service selects its resource again. It does not pass the original error message through.
        userMessage: t("app.chooseCloudModelBeforeTranscribing"),
        retryable: false,
      } });
      const status = await h.host.invokeService(serviceId, "status", input, caller);
      expect(status).toMatchObject({ ok: true, output: {
        phase: "failed", captureStarted: false,
        errorCode: "com.reai.voice/CLOUD_MODEL_SELECTION_REQUIRED",
      } });
      expect(h.host.voiceInputRequests.some(r => r.method === "voice.toggle")).toBeFalse();
      expect(h.sentModels).toEqual([]);
      expect(h.featureId()).toBe("transcribe-default");
      expect(h.engineValue()).toBe("cloud");
    } finally { await h.close(); }
  });
}
test("account default at zero and later metered executes ordinary billing without changing saved intent", async () => {
  const h = await harness("transcribe-default", "cloud", false, false, false, false, false, [accountModel("free")]);
  try {
    await h.open(); await until(() => h.featureId() === "transcribe-account");
    expect(h.features().cloudModelBillingPolicy).toBeUndefined();
    await h.transcribe();
    h.models([accountModel("metered")]); await h.refresh(); await h.transcribe();
    expect(h.sentModels).toEqual(["transcribe-account", "transcribe-account"]);
    expect(h.sentPolicies).toEqual([undefined, undefined]);
    expect(h.features().cloudModelBillingPolicy).toBeUndefined();
  } finally { await h.close(); }
});
test("same account model retains explicit free-only through refresh and reselection; metered execution is refused", async () => {
  const h = await harness("transcribe-account", "cloud", false, false, false, true, false, [accountModel("free")]);
  try {
    await h.open(); await h.choose("transcribe-account"); await h.transcribe();
    expect(h.sentPolicies).toEqual(["free-only"]);
    h.models([accountModel("metered"), accountModel("metered", "transcribe-other")]); await h.refresh();
    expect(h.features().cloudModelBillingPolicy).toBe("free-only");
    await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-account"]);
    await h.choose("transcribe-other"); expect(h.features().cloudModelBillingPolicy).toBeUndefined();
    await h.transcribe(); expect(h.sentPolicies).toEqual(["free-only", undefined]);
    expect(h.history().some(item => item.originalSelection?.billingPolicy === "free-only")).toBeTrue();
  } finally { await h.close(); }
});
test("account pricing failure retains ordinary selection and does not fall back to anonymous free model", async () => {
  const h = await harness("transcribe-account", "cloud", false, false, false, false, false, [accountModel("free")]);
  try {
    await h.open(); h.failList(); await h.refresh();
    expect(h.featureId()).toBe("transcribe-account"); expect(h.engineValue()).toBe("cloud");
    await h.transcribe(); expect(h.sentModels).toEqual(["transcribe-account"]);
    expect(h.features().cloudModelBillingPolicy).toBeUndefined();
  } finally { await h.close(); }
});

const accountOption = (id: string, billingPolicy: "free" | "metered", isDefault = false) => ({
  id, kind: "transcribe" as const, label: id === "transcribe-acct-free" ? "免费云转写" : "标准云转写", isDefault,
  pricingContext: "current-account" as const, billingPolicy,
});
// Production-shaped catalog: the account default is metered, a separate option is free.
const accountCatalog = [accountOption("transcribe-acct-paid", "metered", true), accountOption("transcribe-acct-free", "free")];

test("a REAUTH after relogin recovers on its own after the old two-retry window", async () => {
  cloudModelsRetryTiming.delaysMs = [30, 60, 90, 120, 150];
  const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options, { failInitialList: "PLUGIN_OAUTH_REAUTH_REQUIRED" });
  try {
    await h.open();
    await until(() => h.listCalls() >= 4);
    expect(h.select().disabled).toBeTrue();
    h.recoverList();
    await until(() => h.select().value === "transcribe-free" && !h.select().disabled);
    expect(h.featureId()).toBe("transcribe-free");
  } finally { await h.close(); }
});

test("the surface becoming visible rereads an unavailable catalog with a minimum interval", async () => {
  cloudModelsRetryTiming.delaysMs = [];
  cloudModelsRetryTiming.minVisibleIntervalMs = 60_000;
  const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options, { failInitialList: "AI_NETWORK_ERROR" });
  try {
    await h.open(); await until(() => h.select().disabled); await tick();
    const before = h.listCalls();
    await h.present(); await until(() => h.listCalls() === before + 1); await tick();
    await h.present(); await tick(); await tick();
    expect(h.listCalls()).toBe(before + 1);
    h.recoverList(); cloudModelsRetryTiming.minVisibleIntervalMs = 0;
    await h.present();
    await until(() => h.select().value === "transcribe-free" && !h.select().disabled);
  } finally { await h.close(); }
});

test("switching the cloud model does not reread the catalog and never shows loading", async () => {
  const h = await harness("transcribe-paid", "cloud");
  try {
    await h.open(); const before = h.listCalls();
    const seen: string[] = [];
    const observer = new MutationObserver(() => { seen.push(h.root().textContent ?? ""); if (h.select()?.disabled) seen.push("DISABLED"); });
    observer.observe(h.root(), { subtree: true, childList: true, characterData: true, attributes: true });
    await h.choose("transcribe-free"); observer.disconnect();
    expect(h.listCalls()).toBe(before);
    expect(seen.some(text => text === "DISABLED" || text.includes(t("view.cloudModelsLoading")) || text.includes(t("diagnostics.step.cloudModels")))).toBeFalse();
    expect(h.select().value).toBe("transcribe-free");
  } finally { await h.close(); }
});

test("reopening with a usable list rereads silently: selector stays enabled with its choice", async () => {
  const h = await harness("transcribe-paid", "cloud");
  let release: (() => void) | undefined;
  try {
    await h.open(); const gate = h.holdNextList(); release = gate.release;
    await h.refresh(); await until(gate.started);
    expect(h.select().disabled).toBeFalse(); expect(h.select().value).toBe("transcribe-paid");
    expect(h.root().textContent).not.toContain(t("view.cloudModelsLoading"));
    gate.release(); await tick();
    expect(h.select().value).toBe("transcribe-paid");
  } finally { release?.(); await h.close(); }
});

for (const id of ["", "transcribe-default", "transcribe-removed"]) {
  test(`account catalog defaults ${id || "an empty choice"} to the free option, not the metered account default`, async () => {
    const h = await harness(id, "cloud", false, false, false, false, false, accountCatalog);
    try {
      await until(() => h.featureId() === "transcribe-acct-free");
      // Account pricing is a current quote: ordinary billing intent, not an invented free-only promise.
      expect(h.features().cloudModelBillingPolicy).toBeUndefined();
      await h.open(); expect(h.select().value).toBe("transcribe-acct-free");
    } finally { await h.close(); }
  });
}

test("a missing free-only choice is not moved to another zero-priced option Host would not accept", async () => {
  const h = await harness("transcribe-gone", "cloud", false, false, false, true, false, accountCatalog);
  try {
    await h.open(); await tick(); await tick();
    expect(h.featureId()).toBe("transcribe-gone");
    expect(h.features().cloudModelBillingPolicy).toBe("free-only");
    expect(h.select().value).toBe("transcribe-gone");
  } finally { await h.close(); }
});

test("recording before a choice exists rereads the catalog; the next recording uses the free default", async () => {
  cloudModelsRetryTiming.delaysMs = [];
  const h = await harness("", "cloud", false, false, false, false, false, accountCatalog, { failInitialList: "AI_NETWORK_ERROR" });
  try {
    await h.open(); await until(() => h.select().disabled);
    h.recoverList(); h.models(accountCatalog);
    await h.transcribe(); expect(h.sentModels).toEqual([]);
    await until(() => h.featureId() === "transcribe-acct-free");
    await h.transcribe();
    expect(h.sentModels).toEqual(["transcribe-acct-free"]);
    expect(h.history()[0]?.originalSelection?.modelId).toBe("transcribe-acct-free");
  } finally { await h.close(); }
});

test("plain mode: retrying, stopped and reconnect states speak plainly without codes or waits", async () => {
  cloudModelsRetryTiming.delaysMs = [200, 20, 20, 20, 20];
  const h = await harness("transcribe-free", "cloud", false, false, false, false, false, options,
    { developerMode: false, failInitialList: "PLUGIN_OAUTH_REAUTH_REQUIRED" });
  try {
    await h.open(); await until(() => h.select().disabled);
    for (const locale of ["zh", "en"] as const) {
      h.host.setLocale(locale); await tick();
      const text = h.root().textContent ?? "";
      expect(text).toContain(t("view.cloudRetryingHint"));
      for (const leak of ["PLUGIN_OAUTH_REAUTH_REQUIRED", "catalog temporarily unavailable", "transcribe-free", t("diagnostics.cloudModelsReason")]) expect(text).not.toContain(leak);
      expect(text).not.toMatch(/已等待至少|at least .* since/);
    }
    h.host.setLocale("zh");
    await until(() => (h.root().textContent ?? "").includes(t("view.cloudReconnectHint")));
    expect(h.root().querySelector("[data-action='reconnect-cloud']")).not.toBeNull();
    expect(h.root().textContent).not.toContain("PLUGIN_OAUTH_REAUTH_REQUIRED");
  } finally { await h.close(); }
});

test("turning developer mode off immediately hides raw failure text already on screen", async () => {
  const h = await harness("transcribe-paid", "cloud");
  try {
    await h.open(); h.failSave(); h.select().value = "transcribe-free"; h.select().dispatchEvent(new Event("change"));
    await until(() => h.root().textContent!.includes("selection could not be saved"));
    await h.setDeveloperMode(false);
    await until(() => !h.root().textContent!.includes("selection could not be saved"));
    for (const locale of ["zh", "en"] as const) {
      h.host.setLocale(locale); await tick();
      expect(h.root().textContent).toContain(t("app.notCompletedTryAgainLater"));
    }
    expect(h.featureId()).toBe("transcribe-paid");
  } finally { await h.close(); }
});
