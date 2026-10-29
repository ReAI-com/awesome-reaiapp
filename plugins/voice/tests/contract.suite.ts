import { defineContractSuite, MockHost, type MockHostOptions } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, type VoiceCommandHistoryItem } from "../src/data";
import { t } from "../src/voice-i18n";

const ownedOpenRejections = "有主会话拒绝裸意图、过期来源、拒绝权限和未落地，提交失败保留未读";
const ownedOpenScenarios = new Set([
  "命令详情听写起跑尚未返回就离页会在 listening 到达后立即取消",
  "toggle-command 本地识别后直接运行通用 Agent 并保存真实回复",
  ownedOpenRejections,
]);
let ownedContractLoad = 0;
function createOwnedContractHost() {
  // Explicit synthetic admission only for these scenarios; default Host stays unavailable.
  const source: NonNullable<MockHostOptions["ownedConversationOpen"]> = {
    accountGeneration: "synthetic-voice-contract", packageDigest: "a".repeat(64),
    admitted: true, decision: "granted", userCeiling: "system",
  };
  const roots: HTMLElement[] = [];
  const entry = new URL(`../${manifest.runtime.components[0]!.entry}`, import.meta.url).href;
  const host = new MockHost({ manifest: manifest as MockHostOptions["manifest"],
    ownedConversationOpen: source,
    loadApp: () => import(`${entry}?ownedContract=${++ownedContractLoad}`),
    createRoot: () => {
      const root = document.createElement("div");
      document.body.append(root); roots.push(root); return root;
    },
  });
  return { host, source, roots };
}
const ownedContractHosts = new WeakMap<MockHost, ReturnType<typeof createOwnedContractHost>>();
async function syntheticCommandHistory(host: MockHost): Promise<VoiceCommandHistoryItem[]> {
  const result = await host.bridge.request<{ found: boolean; value?: VoiceCommandHistoryItem[] }>(
    "storage.get", { storeId: "voice-state", key: COMMAND_HISTORY_KEY },
  );
  return result.found && Array.isArray(result.value) ? structuredClone(result.value) : [];
}
async function syntheticCommandRow(host: MockHost, id: string): Promise<VoiceCommandHistoryItem> {
  const row = (await syntheticCommandHistory(host)).find(entry => entry.id === id);
  if (!row) throw new Error("真实命令历史没有该任务");
  return row;
}
async function waitForCommandRead(host: MockHost, id: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while ((await syntheticCommandRow(host, id)).unread === true) {
    if (Date.now() >= deadline) throw new Error("同 owner commit 后未读没有同步落旗");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitUntil(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 识别引擎是设计稿明确画的分段按钮（`.settings-seg`），不是原生 select。
 * `root.querySelector` 拿的是当前渲染出的按钮，`render()` 每次都会
 * replaceChildren，所以每次调用都要重新查询，不能缓存引用。
 */
function engineSegButton(root: HTMLElement, engine: "local" | "cloud"): HTMLButtonElement {
  const label = engine === "cloud" ? "云端引擎" : "本地引擎";
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>(".settings-seg button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`设置页缺少「${label}」分段按钮`);
  return button;
}

async function selectEngine(root: HTMLElement, engine: "local" | "cloud"): Promise<void> {
  engineSegButton(root, engine).click();
  await waitUntil(
    () => engineSegButton(root, engine).getAttribute("aria-checked") === "true",
    "识别引擎没有完成保存",
  );
  if (engine !== "cloud") return;
  // These scenarios exercise cloud recognition/permissions, after the user has
  // explicitly picked MockHost's public option through the real selector.
  await waitUntil(
    () => !!root.querySelector('.settings-cloud-model option[value="transcribe-free"]'),
    "云端选择器没有提供测试 Host 的转写选项",
  );
  const select = root.querySelector<HTMLSelectElement>(".settings-cloud-model")!;
  select.value = "transcribe-free";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitUntil(() => {
    const saved = root.querySelector<HTMLSelectElement>(".settings-cloud-model");
    return saved !== select && saved?.value === "transcribe-free";
  }, "显式云端选择没有保存并重渲染");
}

/** 润色档位按钮（原样/轻度/规整）；档位标签在设置页唯一，不与其它分段组重名。 */
function polishLevelButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
    .filter((button) => button.textContent === "原样" || button.textContent === "轻度" || button.textContent === "规整");
}

function checkedPolishLevel(root: HTMLElement): string | undefined {
  return polishLevelButtons(root)
    .find((button) => button.getAttribute("aria-checked") === "true")
    ?.textContent ?? undefined;
}

async function selectPolishLevel(root: HTMLElement, label: "原样" | "轻度" | "规整"): Promise<void> {
  const button = polishLevelButtons(root).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`设置页缺少「${label}」润色档位按钮`);
  button.click();
  await waitUntil(
    () => checkedPolishLevel(root) === label,
    `润色档位「${label}」没有完成保存与重渲染`,
  );
}

/** 引擎分段与润色分段同页；只认 aria-checked，不靠面板可见性推断。 */
async function ensureCloudEngine(root: HTMLElement): Promise<void> {
  await selectEngine(root, "cloud");
}

/**
 * 润色设置现在对本地/云端引擎都可见，这些场景沿云端引擎路径验证（云端转写 +
 * 润色同一条链路）。新用户默认已是「原样」（DEV-16，2026-09-14 拍板）：目标档
 * 就是当前档时没有变更事件，先切到别的档再切回来，保证「用户显式选择」真实落盘一次。
 */
async function selectPolish(root: HTMLElement, label: "原样" | "轻度" | "规整"): Promise<void> {
  await ensureCloudEngine(root);
  await waitUntil(
    () => root.textContent?.includes("注入前的处理") === true,
    "润色设置没有出现",
  );
  if (checkedPolishLevel(root) === label) {
    await selectPolishLevel(root, label === "规整" ? "轻度" : "规整");
  }
  await selectPolishLevel(root, label);
}

/**
 * 这些场景验证命令路由/写回/权限语义，不是润色本身：显式钉住「原样」，让断言
 * 回到「识别成什么就写什么」的确定路径。不切引擎，保持各场景原有引擎前提。
 * 默认档已是「原样」（DEV-16），点「原样」没有变更事件；则先切轻度再切回，
 * 两种默认下都保证一次真实写入。
 */
async function pinRawPolish(host: ContractHostLike & { storageKeys(): string[] }, deliveryId: string): Promise<void> {
  const root = await openSettings(host, deliveryId);
  await waitUntil(
    () => root.textContent?.includes("注入前的处理") === true,
    "润色设置没有出现",
  );
  if (checkedPolishLevel(root) === "原样") {
    await selectPolishLevel(root, "轻度");
  }
  await selectPolishLevel(root, "原样");
  await waitUntil(
    () => host.storageKeys().includes("com.reai.voice/voice-state/settings"),
    "原样档位没有落盘",
  );
}

/** 打开 Voice Surface 并经 Host 标题栏动作进入设置页，返回可继续操作的 root。 */
interface ContractHostLike {
  openSurface(surfaceId: string): Promise<{ root: HTMLElement | undefined; surfaceMountId: string }>;
  sendIntent(surfaceMountId: string, intent: unknown): Promise<void>;
}

async function openSettings(
  host: ContractHostLike,
  deliveryId: string,
): Promise<HTMLElement> {
  const main = await host.openSurface("main");
  const root = main.root;
  if (!root) throw new Error("DOM 环境不可用");
  await host.sendIntent(main.surfaceMountId, {
    source: "host.titlebarAction",
    actionId: "settings",
    deliveryId,
    payload: { type: "open-settings" },
  });
  return root;
}

/** 每日总结默认关闭；需要自动调度的合同场景必须像用户一样明确接受后再开启。 */
async function enableAutomaticSummary(
  host: ContractHostLike,
  deliveryId: string,
): Promise<void> {
  const root = await openSettings(host, deliveryId);
  await waitUntil(
    () => root.querySelector<HTMLButtonElement>('[data-action="summary-enabled"]') !== null,
    "每日总结没有显示云端生成开关",
  );
  root.querySelector<HTMLButtonElement>('[data-action="summary-enabled"]')?.click();
  await waitUntil(
    () => root.querySelector('.voice-consent-dialog') !== null,
    "首次开启每日总结没有显示用量与隐私确认",
  );
  const checks = root.querySelectorAll<HTMLInputElement>('.voice-consent-dialog input[type="checkbox"]');
  if (checks.length !== 2) throw new Error("每日总结确认应包含用量与隐私两项");
  for (const check of Array.from(checks)) {
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const confirm = Array.from(
    root.querySelectorAll<HTMLButtonElement>('.voice-consent-dialog button'),
  ).find((button) => button.textContent === "确认并开启");
  if (!confirm || confirm.disabled) throw new Error("两项确认后仍无法开启每日总结");
  confirm.click();
  await waitUntil(
    () => Array.from(root.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
      .some((button) => button.textContent === "自动"),
    "开启云端生成后没有显示手动/自动选择",
  );
  const auto = Array.from(root.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
    .find((button) => button.textContent === "自动");
  auto?.click();
  await waitUntil(
    () => Array.from(root.querySelectorAll<HTMLButtonElement>(".settings-seg button"))
      .some((button) => button.textContent === "自动" && button.getAttribute("aria-checked") === "true"),
    "每日总结没有切换为自动生成",
  );
}

/** Existing feature scenarios start after the user makes the new first-run choice. */
function configuredVoiceSuite(config: Parameters<typeof defineContractSuite>[0]) {
  return defineContractSuite({ ...config, scenarios: config.scenarios?.map(scenario => ({
    ...scenario,
    async run(api) {
      const fixture = ownedOpenScenarios.has(scenario.name) ? createOwnedContractHost() : undefined;
      const host = fixture?.host ?? api.host;
      if (fixture) {
        await api.host.disable();
        ownedContractHosts.set(host, fixture);
      }
      try {
        if (fixture) await host.installAndEnable();
        const initial = await host.openSurface("main");
        const root = initial.root;
        if (!root) throw new Error("DOM 环境不可用");
        if (initial.readyCount !== 1 || initial.failCount !== 0) throw new Error("前置 Surface 没有真实就绪");
        await waitUntil(() => !!root.querySelector(".voice-recognition-setup"), "全新 Voice 没有提示选择识别方式");
        root.querySelector<HTMLButtonElement>(".voice-recognition-choice button")!.click();
        await waitUntil(() => !root.querySelector(".voice-recognition-setup"), "本地识别选择没有完成");
        await host.unmountSurface(initial.surfaceMountId);
        // Feature assertions measure their own configure/invoke operations, not
        // the preceding setup interaction. Keep persistent settings intact.
        host.voiceInputRequests.length = 0;
        host.cloudRequests.length = 0;
        await scenario.run({ ...api, host });
      } finally {
        if (fixture) {
          try { await host.disable(); }
          finally { for (const root of fixture.roots) root.remove(); ownedContractHosts.delete(host); }
        }
      }
    },
  })) });
}

export default configuredVoiceSuite({
  appDirectory: "..",
  hostApi: "1.25.0",
  expect: {
    surfaces: ["main"],
    commands: [
      "com.reai.voice.toggle-input",
      "com.reai.voice.toggle-command",
      "com.reai.voice.refresh-day-digest",
      // 三个可被绑定的命令事件。插件只把事件交出来；哪颗键、哪个拨杆档触发哪一个，
      // 是 Host 键位设置的事（插件与硬件解耦条款）。
      "com.reai.voice.command.transcribe",
      "com.reai.voice.command.translate",
      "com.reai.voice.command.agent",
    ],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.voice",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "自动当日总结失败的退避写入私有 KV，Runtime 重建后一小时内不重试",
      async run({ host }) {
        await enableAutomaticSummary(host, "contract-digest-backoff-settings");
        const now = Date.now();
        host.setVoiceRecordings([{
          id: "digest-backoff-seg",
          wallStartMs: now - 60_000,
          durationMs: 30_000,
          transport: "usb_vendor_hid",
          transcriptText: "这是一段用于验证自动总结失败退避的现场记录。",
          transcribedAtMs: now - 10_000,
        }]);
        host.rejectNextAgentSend({ kind: "engine", stderr_tail: "simulated digest failure" });

        // 场景创建时 App 已激活过一次；停用再启用，模拟真正的 Runtime 重建，
        // 同一个 Mock Host 的私有 KV 与录音索引继续保留。
        await host.disable();
        await host.installAndEnable();
        await host.invokeCommand("com.reai.voice.refresh-day-digest");
        await waitUntil(
          () => host.storageKeys().includes(
            "com.reai.voice/voice-state/day-digest-attempts-v1",
          ),
          "自动总结失败后没有把退避时间写入私有 KV",
        );
        const sendsAfterFailure = host.agentRequests.filter(
          (request) => request.method === "agent.v2.turn.start",
        ).length;
        if (sendsAfterFailure !== 1) {
          throw new Error(`首次失败应恰好发送一轮，实际 ${sendsAfterFailure}`);
        }

        await host.disable();
        await host.installAndEnable();
        await host.invokeCommand("com.reai.voice.refresh-day-digest");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const sendsAfterRestart = host.agentRequests.filter(
          (request) => request.method === "agent.v2.turn.start",
        ).length;
        if (sendsAfterRestart !== sendsAfterFailure) {
          throw new Error("Runtime 重建后丢失失败退避，一小时内又自动发送了一轮");
        }
      },
    },
    {
      name: "用户删段会把当天的自动总结退避同步清出私有 KV",
      async run({ host }) {
        await enableAutomaticSummary(host, "contract-digest-delete-settings");
        const now = Date.now();
        host.setVoiceRecordings([{
          id: "digest-delete-old",
          wallStartMs: now - 60_000,
          durationMs: 30_000,
          transport: "usb_vendor_hid",
          transcriptText: "这段记录先让自动总结失败一次。",
          transcribedAtMs: now - 10_000,
        }]);
        host.rejectNextAgentSend({ kind: "engine", stderr_tail: "simulated digest failure" });

        await host.disable();
        await host.installAndEnable();
        await host.invokeCommand("com.reai.voice.refresh-day-digest");
        await waitUntil(
          () => host.agentRequests.filter((request) => request.method === "agent.v2.turn.start").length === 1,
          "前置自动总结没有按预期失败一次",
        );

        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')?.click();
        await waitUntil(() => root.querySelector(".recording-copy") !== null, "Context 档没有列出待删除的段");
        root.querySelector<HTMLButtonElement>(".recording-copy")?.click();
        await waitUntil(
          () => root.querySelector('[data-action="delete-recording"]') !== null,
          "段详情没有删除入口",
        );
        root.querySelector<HTMLButtonElement>('[data-action="delete-recording"]')?.click();
        await waitUntil(
          () => root.querySelector('[data-ask="delete-recording"] [data-ask="yes"]') !== null,
          "删除确认层没有出现",
        );
        root.querySelector<HTMLButtonElement>('[data-ask="delete-recording"] [data-ask="yes"]')?.click();
        await waitUntil(() => host.getVoiceRecordings().length === 0, "段没有从 Host 录音索引删除");
        await new Promise((resolve) => setTimeout(resolve, 20));

        // 同一天随后出现新素材并重建 Runtime：用户删段已经是强信号，旧失败退避不能复活。
        host.setVoiceRecordings([{
          id: "digest-delete-new",
          wallStartMs: now,
          durationMs: 20_000,
          transport: "usb_vendor_hid",
          transcriptText: "删段后同一天出现的新现场记录。",
          transcribedAtMs: now,
        }]);
        await host.disable();
        await host.installAndEnable();
        await host.invokeCommand("com.reai.voice.refresh-day-digest");
        await waitUntil(
          () => host.agentRequests.filter((request) => request.method === "agent.v2.turn.start").length === 2,
          "Runtime 重建后旧退避从 KV 复活，压住了删段后的新素材",
        );
      },
    },
    {
      name: "命令详情听写起跑尚未返回就离页会在 listening 到达后立即取消",
      async run({ host }) {
        // 先走真实命令链落下一条可打开的历史；场景开始时插件已经激活，直接改 KV
        // 不会让内存状态重读，也就测不到详情页。
        await host.invokeCommand("com.reai.voice.toggle-command");
        await host.invokeCommand("com.reai.voice.toggle-command");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/command-history"),
          "前置命令没有生成可打开的历史",
        );

        const taskId = (host.agentRequests.find(request => request.method === "agent.v2.turn.start")?.params as
          { idempotencyKey?: string } | undefined)?.idempotencyKey;
        if (!taskId) throw new Error("前置真实命令缺少任务身份");
        const original = host.bridge.request.bind(host.bridge);
        let intercepted = false;
        let listeningSessionId: string | undefined;
        let releaseToggle: () => void = () => undefined;
        const toggleGate = new Promise<void>((resolve) => {
          releaseToggle = resolve;
        });
        host.bridge.request = async <T>(method: Parameters<MockHost["bridge"]["request"]>[0], params: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
          if (method === "voice.toggle" && !intercepted) {
            intercepted = true;
            await toggleGate;
          }
          const response = await original<T>(method, params, options);
          if (method === "voice.toggle") {
            const listening = response as { phase?: string; sessionId?: string };
            if (listening.phase === "listening") listeningSessionId = listening.sessionId;
          }
          return response;
        };
        try {
          const main = await host.openSurface("main");
          const root = main.root;
          if (!root || !root.isConnected || main.readyCount !== 1 || main.failCount !== 0) throw new Error("DOM Surface 没有真实就绪");
          root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')?.click();
          root.querySelector<HTMLButtonElement>(".command-history-item")?.click();
          await waitUntil(() => !!root.querySelector(".chat-mic"), "异步打开后命令详情没有听写麦克风");
          await waitForCommandRead(host, taskId);
          root.querySelector<HTMLButtonElement>(".chat-mic")!.click();
          await waitUntil(() => intercepted, "听写起跑没有进入 voice.toggle");

          // 此刻 App 的 dictationPhase 仍是 idle；返回动作必须记住取消意图。
          await host.invokeCommand("com.reai.voice.back-to-root");
          releaseToggle();
          await waitUntil(
            () => !!listeningSessionId && host.voiceInputRequests.some((request) => request.method === "voice.cancel"
              && (request.params as { sessionId?: string }).sessionId === listeningSessionId),
            "迟到的 listening 精确会话没有被立即取消",
          );
          const status = await original<{ phase?: string }>("voice.status", {});
          if (status.phase !== "idle") throw new Error("取消竞态收口后 Host 仍处于 listening");
        } finally {
          releaseToggle();
          host.bridge.request = original;
        }
      },
    },
    {
      name: "旧固件 CTA 只发起 Host 系统任务并携带有界返回意图",
      async run({ host }) {
        host.setVoiceInputStatus({
          phase: "idle",
          source: "board",
          modelId: "sensevoice-small-int8",
          sourceReady: false,
          sourceIssue: "firmware_too_old",
          boardFirmwareVersion: "1.49",
          minimumBoardFirmwareVersion: "1.50",
        });
        const statusCallsBeforeMount = host.voiceInputRequests.filter(
          (request) => request.method === "voice.status",
        ).length;
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        // R2：固件太旧是档内一行琥珀提醒，「去升级 ›」只发起 Host 系统任务。
        await waitUntil(
          () => host.voiceInputRequests.filter(
            (request) => request.method === "voice.status",
          ).length > statusCallsBeforeMount && root
            .querySelector<HTMLButtonElement>('.voice-warn[data-warn="firmware"] .voice-warn-go')
            ?.textContent?.includes("去升级") === true,
          "旧固件 CTA 没有出现",
        );
        root.querySelector<HTMLButtonElement>('.voice-warn[data-warn="firmware"] .voice-warn-go')?.click();
        await waitUntil(
          () => host.systemTaskRequests.some((request) => request.method === "system.tasks.open"),
          "旧固件 CTA 没有发起 Host 系统任务",
        );
        const request = host.systemTaskRequests.find(
          (candidate) => candidate.method === "system.tasks.open",
        );
        const params = request?.params as {
          target?: string;
          returnIntent?: { reason?: string };
        } | undefined;
        if (
          params?.target !== "firmware-upgrade" ||
          params.returnIntent?.reason !== "voice-firmware-required"
        ) {
          throw new Error("系统任务必须只携带固定 target 与有界 returnIntent");
        }
      },
    },
    {
      name: "系统任务返回 intent 会强制重读 Host 权威状态",
      async run({ host }) {
        const main = await host.openSurface("main");
        const before = host.voiceInputRequests.filter(
          (request) => request.method === "voice.status",
        ).length;
        await host.sendIntent(main.surfaceMountId, {
          type: "system-task.return",
          taskId: "task-contract-return",
          target: "firmware-upgrade",
          outcome: "succeeded",
          payload: { reason: "voice-firmware-required" },
        });
        await waitUntil(
          () => host.voiceInputRequests.filter(
            (request) => request.method === "voice.status",
          ).length > before,
          "系统任务返回后没有重新读取 Voice 状态",
        );
      },
    },
    {
      name: "系统任务打开失败会在 Voice 页面显示可读反馈",
      async run({ host }) {
        host.setVoiceInputStatus({
          phase: "idle",
          source: "board",
          modelId: "sensevoice-small-int8",
          sourceReady: false,
          sourceIssue: "firmware_too_old",
          boardFirmwareVersion: "1.49",
          minimumBoardFirmwareVersion: "1.50",
        });
        const statusCallsBeforeMount = host.voiceInputRequests.filter(
          (request) => request.method === "voice.status",
        ).length;
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await waitUntil(
          () => host.voiceInputRequests.filter(
            (request) => request.method === "voice.status",
          ).length > statusCallsBeforeMount && root
            .querySelector<HTMLButtonElement>('.voice-warn[data-warn="firmware"] .voice-warn-go')
            ?.textContent?.includes("去升级") === true,
          "旧固件 CTA 没有出现",
        );
        host.rejectNextSystemTaskOpen("已有固件升级正在进行");
        root.querySelector<HTMLButtonElement>('.voice-warn[data-warn="firmware"] .voice-warn-go')?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // 失败反馈落在列表页的原地 inline-error（提醒行下方）。
        const feedback = root.querySelector<HTMLElement>(".voice-list-view .inline-error")
          ?.textContent?.trim();
        if (!feedback) {
          throw new Error(
            `系统任务失败没有反馈到 Voice 页面；请求：${JSON.stringify(host.systemTaskRequests)}；当前页面：${root.textContent}`,
          );
        }
      },
    },
    {
      name: "Host 标题栏动作能进入插件自有设置页并保存音源",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        if (root.querySelector('[aria-label="Voice 设置"]')) {
          throw new Error("Voice 主界面不应重复渲染 Host 已托管的设置按钮");
        }
        const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        if (tabs.length !== 4) throw new Error("Voice 主界面必须提供 All / Input / Command / Context 四个设计标签");
        // R1 / R14：页头胶囊是全局状态、四档恒两段（键盘没断线时），不随 tab 变；
        // 正常/过渡态只陈述状态，异常态才提供能解决问题的按钮。
        const capsule = root.querySelector<HTMLElement>(".voice-cap");
        if (!capsule) {
          throw new Error("页头必须有状态胶囊");
        }
        for (const segment of Array.from(
          capsule.querySelectorAll<HTMLElement>(".voice-cap-seg"),
        )) {
          const isAbnormal = segment.classList.contains("off");
          const isRecoveryAction = segment.matches("button.voice-cap-action");
          if (isAbnormal !== isRecoveryAction) {
            throw new Error("正常状态必须只显示，异常状态必须提供恢复入口");
          }
          if (isRecoveryAction && !segment.getAttribute("aria-label")) {
            throw new Error("异常状态恢复入口必须说明点击去向");
          }
        }
        if (root.querySelector(".voice-status")) {
          throw new Error("R1：tab 下面不应再有状态卡");
        }
        const command = root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]');
        command?.click();
        if (root.querySelectorAll(".voice-cap-seg").length !== 2) {
          throw new Error("胶囊在 Command 档也必须是「麦克风 | 在听」两段");
        }
        const context = root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]');
        context?.click();
        // R4：Context 档没有控制条；R18：按天分组的时间线（没记录时只有一句空态）。
        if (root.textContent?.includes("连续时间线") || root.textContent?.includes("暂停时间线")) {
          throw new Error("R4：Context 档不应再有控制条 / 技术诊断");
        }
        if (!root.querySelector(".ctx-timeline")) {
          throw new Error("Context 标签必须渲染按天分组的时间线");
        }
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-titlebar-settings",
          payload: { type: "open-settings" },
        });
        if (!root.querySelector(".voice-settings-view")) {
          throw new Error("Host 标题栏动作没有进入独立设置页");
        }
        // 录音来源是识别引擎卡里的 › 行，点开是五档单选（2026-10-11）。
        const source = root.querySelector<HTMLButtonElement>('[data-settings-target="source"]');
        if (!source) throw new Error("设置页缺少录音来源行");
        source.click();
        const modes = Array.from(root.querySelectorAll<HTMLButtonElement>(".voice-source-option"))
          .map((option) => option.dataset.audioSourceMode);
        if (modes.join(",") !== "auto,prefer_board,prefer_computer,board_only,computer_only") {
          throw new Error(`录音来源对话框应列出五档，实际：${modes.join(",")}`);
        }
        root.querySelector<HTMLButtonElement>('.voice-source-option[data-audio-source-mode="computer_only"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!host.storageKeys().includes("com.reai.voice/voice-state/settings")) {
          throw new Error("音频来源修改没有写入 Voice 私有 KV");
        }
        /* V1.7.0 / B5-14：页内返回钮已撤，返回走 Host 面包屑合同
           （back-to-root command）。 */
        if (root.querySelector('[aria-label="返回 Voice"]')) {
          throw new Error("B5-14：设置页不应再有页内返回钮");
        }
        const settled = await host.invokeCommand("com.reai.voice.back-to-root", {});
        if (!settled.ok) throw new Error("back-to-root command 失败");
        if (!root.querySelector(".task-list-view")) throw new Error("back-to-root 没有回到 Voice 主列表");
      },
    },
    {
      /* R1：列表页不再有「测试语音识别」按钮（状态卡整块撤掉）。页面测试入口
         （toggleInput(undefined, false)：只做本地识别、显式禁用文字插入）归设置 ›
         识别引擎，由设置页车道落位后在这里重建「入口 → voice.toggle insertText:false
         → 历史标「未写入」」的 UI 驱动断言。这里先钉住「列表页没有这颗按钮」。 */
      name: "列表页没有测试按钮与状态卡：状态进页头胶囊",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        root.querySelector<HTMLButtonElement>('[data-voice-tab="input"]')?.click();
        if (root.textContent?.includes("测试语音识别") || root.querySelector(".voice-status")) {
          throw new Error("R1：Input 档不应再有测试按钮 / 状态卡");
        }
        if (!root.querySelector(".voice-cap [data-cap-seg='mic']")) {
          throw new Error("页头胶囊必须有麦克风段");
        }
      },
    },
    {
      name: "toggle-command 本地识别后直接运行通用 Agent 并保存真实回复",
      async run({ host }) {
        // 本场景验证「命令→通用 Agent」的路由与负载合同。Agent 不润色（2026-09-27 定稿），
        // 所以不钉润色档：默认「轻度」下 Agent 收到的也必须是原始识别结果。
        const generateBefore = host.cloudRequests.filter((request) => request.method === "ai.text.generate").length;
        const started = await host.invokeCommand("com.reai.voice.toggle-command");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("第一次语音命令应进入 listening");
        }
        const finished = await host.invokeCommand("com.reai.voice.toggle-command");
        if (!finished.ok || (finished.output as { phase?: string }).phase !== "recognizing") {
          throw new Error("第二次语音命令应立即进入后台 recognizing");
        }
        await waitUntil(
          () => host.agentRequests.some((request) => request.method === "agent.v2.turn.start"),
          "后台识别完成后没有发起通用 Agent",
        );
        const run = host.agentRequests.find(
          (request) => request.method === "agent.v2.turn.start",
        );
        // 契约不变：只发最终识别文本。不发原始音频、前台窗口、选区、剪贴板或历史。
        if ((run?.params as { text?: string } | undefined)?.text !== "测试语音命令") {
          throw new Error("Agent 只应收到最终本地识别文本");
        }
        if (host.cloudRequests.filter((request) => request.method === "ai.text.generate").length !== generateBefore) {
          throw new Error("Agent 命令不润色：不得发起任何云端润色生成");
        }
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/command-history"),
          "语音命令结果没有写入独立历史",
        );
        // Mock Agent 在 3 秒内完成：只弹结果面板，不在桌面角落留下第二份任务卡。
        await waitUntil(
          () => host.voiceCommandRequests.some(
            (request) => request.method === "voice.command.present-answer",
          ),
          "短 Agent 回合没有弹出结果面板",
        );
        if (host.voiceCommandRequests.some((request) => request.method === "voice.command.present-task")) {
          throw new Error("3 秒内完成的 Agent 回合不应投递后台任务胶囊");
        }

        const answer = host.voiceCommandRequests.find(
          (request) => request.method === "voice.command.present-answer",
        );
        const actualTurnId = (answer?.params as { runId?: string } | undefined)?.runId;
        const taskId = (run?.params as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        const sessionId = (run?.params as { sessionId?: string } | undefined)?.sessionId;
        if (!taskId || !actualTurnId || !sessionId) throw new Error("结果面板缺少任务或会话身份");
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root || !root.isConnected || main.readyCount !== 1 || main.failCount !== 0) throw new Error("任务 Surface 没有真实就绪");
        const row = await syntheticCommandRow(host, taskId);
        if (row.agentSessionId !== sessionId || row.runId !== actualTurnId || row.unread !== true) throw new Error("结果历史缺少真实身份或未读旗");
        const original = host.bridge.request.bind(host.bridge);
        let paintedBeforeCommit = false;
        let unreadBeforeCommit = false;
        host.bridge.request = async <T>(method: Parameters<MockHost["bridge"]["request"]>[0], params: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
          if (method === "agent.v2.session.conversation-opened" && (params as { phase?: string }).phase === "commit") {
            paintedBeforeCommit = root.isConnected && !!root.querySelector(".main-body .chat-mic")
              && !!row.reply && root.textContent?.includes(row.reply) === true;
            const saved = await original<{ found: boolean; value?: VoiceCommandHistoryItem[] }>(
              "storage.get", { storeId: "voice-state", key: COMMAND_HISTORY_KEY },
            );
            unreadBeforeCommit = saved.value?.find(entry => entry.id === taskId)?.unread === true;
          }
          return original<T>(method, params, options);
        };
        try {
          const receipt = await host.deliverOwnedConversationOpen(sessionId);
          await waitUntil(() => host.ownedConversationCommits.length === 1, "真实 Host receipt 没有提交");
          await waitForCommandRead(host, taskId);
          const commit = host.ownedConversationCommits[0]!;
          if (commit.sessionId !== sessionId || commit.openToken !== receipt.openToken
            || !paintedBeforeCommit || !unreadBeforeCommit) throw new Error("提交没有绑定真实会话、原 receipt、已绘制详情和提交前未读");
          await host.sendIntent(main.surfaceMountId, { source: "host.taskConversation", actionId: "open-conversation",
            payload: { entityId: sessionId, openToken: receipt.openToken } });
          if (host.ownedConversationCommits.length !== 1) throw new Error("重复 receipt 产生了第二次提交");
          if (host.voiceCommandRequests.some(request => request.method === "voice.command.dismiss-task")) throw new Error("有主提交不应降级为 legacy dismiss");
          if (host.agentRequests.some(request => (request.params as { phase?: string }).phase === "prepare")) throw new Error("Host receipt 被替换成本地 prepare");
        } finally { host.bridge.request = original; }
      },
    },
    {
      name: ownedOpenRejections,
      async run({ host }) {
        const fixture = ownedContractHosts.get(host);
        if (!fixture) throw new Error("拒绝测试缺少显式合成 owner fixture");
        await host.invokeCommand("com.reai.voice.toggle-command");
        await host.invokeCommand("com.reai.voice.toggle-command");
        await waitUntil(() => host.voiceCommandRequests.some(request => request.method === "voice.command.present-answer"), "前置真实结果未完成");
        const run = host.agentRequests.find(request => request.method === "agent.v2.turn.start")?.params as
          { sessionId?: string; idempotencyKey?: string } | undefined;
        const sessionId = run?.sessionId, taskId = run?.idempotencyKey;
        if (!sessionId || !taskId) throw new Error("拒绝测试缺少真实任务来源");
        const main = await host.openSurface("main"), root = main.root;
        if (!root || !root.isConnected || main.readyCount !== 1 || main.failCount !== 0) throw new Error("拒绝 fixture 未就绪");
        const unchanged = async () => {
          if ((await syntheticCommandRow(host, taskId)).unread !== true || host.ownedConversationCommits.length !== 0
            || host.voiceCommandRequests.some(request => request.method === "voice.command.dismiss-task")) throw new Error("拒绝路径误清未读或确认已打开");
        };
        await unchanged();
        // Positive admission + attached DOM makes this fail on the old raw→prepare upgrade.
        await host.sendIntent(main.surfaceMountId, { source: "host.taskConversation", payload: { entityId: sessionId } });
        await waitUntil(() => root.querySelector(".inline-error")?.textContent?.includes(t("errors.conversationOpen.sourceStale")) === true, "裸意图没有明确拒绝");
        if (root.querySelector(".chat-mic") || host.agentRequests.some(request => (request.params as { phase?: string }).phase === "prepare")) throw new Error("裸意图升级成了本地打开或详情预览");
        await unchanged();

        const stale = await host.bridge.request<{ openToken: string }>("agent.v2.session.conversation-opened", { sessionId, phase: "prepare" });
        host.advanceOwnedConversationNotice(sessionId);
        await host.sendIntent(main.surfaceMountId, { source: "host.taskConversation", actionId: "open-conversation",
          payload: { entityId: sessionId, openToken: stale.openToken } });
        await waitUntil(() => host.agentRequests.some(request => (request.params as { phase?: string; openToken?: string }).phase === "commit"
          && (request.params as { openToken?: string }).openToken === stale.openToken) && !!root.querySelector(".voice-conversation-open-error"), "过期来源没有在真实提交处拒绝");
        await unchanged();

        await host.invokeCommand("com.reai.voice.back-to-root");
        fixture.source.decision = "denied";
        const prepares = host.agentRequests.filter(request => (request.params as { phase?: string }).phase === "prepare").length;
        root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
        await waitUntil(() => host.agentRequests.filter(request => (request.params as { phase?: string }).phase === "prepare").length > prepares
          && !!root.querySelector(".voice-conversation-open-error"), "拒绝权限没有阻止真实 prepare");
        await unchanged();

        fixture.source.decision = "granted";
        await host.invokeCommand("com.reai.voice.back-to-root");
        root.remove();
        const cancels = host.agentRequests.filter(request => (request.params as { phase?: string }).phase === "cancel").length;
        root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
        await waitUntil(() => host.agentRequests.filter(request => (request.params as { phase?: string }).phase === "cancel").length > cancels
          && !!root.querySelector(".voice-conversation-open-error"), "未附着的真实详情没有取消 receipt");
        await unchanged();
        document.body.append(root);
        await host.invokeCommand("com.reai.voice.back-to-root");
        host.failNextConversationOpenCommit();
        const receipt = await host.deliverOwnedConversationOpen(sessionId);
        await waitUntil(() => !!root.querySelector(".voice-conversation-open-error button") && host.agentRequests.some(request =>
          (request.params as { phase?: string; openToken?: string }).phase === "commit" && (request.params as { openToken?: string }).openToken === receipt.openToken), "持久提交失败没有反馈");
        await unchanged();
        root.querySelector<HTMLButtonElement>(".voice-conversation-open-error button")!.click();
        await waitUntil(() => host.ownedConversationCommits.length === 1, "同 receipt 显式重试未成功");
        await waitForCommandRead(host, taskId);
        if (host.ownedConversationCommits[0]!.openToken !== receipt.openToken || host.ownedConversationCommits[0]!.sessionId !== sessionId) throw new Error("重试换了 receipt 或任务来源");
      },
    },
    {
      name: "toggle-command 没有听清时不启动 Agent，并确认消费本次识别结果",
      async run({ host }) {
        host.setNextVoiceCommandTranscript("");
        const started = await host.invokeCommand("com.reai.voice.toggle-command");
        if (!started.ok) throw new Error("空识别场景没有进入 listening");
        const sessionId = (started.output as { sessionId?: string } | undefined)?.sessionId;
        if (!sessionId) throw new Error("空识别场景缺少 sessionId");
        await host.invokeCommand("com.reai.voice.toggle-command");
        await waitUntil(
          () => host.voiceInputRequests.some(
            (request) => request.method === "voice.acknowledge-result",
          ),
          "空识别没有结算 Host 的 processing 胶囊",
          // 2.14.4-rc.1：识别为空时先让 Host 的「没有听清」停留约 1.5 秒再确认。
          3_000,
        );
        const acknowledgement = host.voiceInputRequests.find(
          (request) => request.method === "voice.acknowledge-result",
        );
        if ((acknowledgement?.params as { sessionId?: string } | undefined)?.sessionId !== sessionId) {
          throw new Error("空识别确认没有绑定原始 sessionId");
        }
        if (host.agentRequests.some((request) => request.method === "agent.v2.turn.start")) {
          throw new Error("空识别不应启动 Agent");
        }
      },
    },
    {
      name: "Host 空闲状态把 mode 序列化为 null 时 Agent 对话仍可继续提问",
      async run({ host }) {
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(
          () => host.voiceCommandRequests.some(
            (request) => request.method === "voice.command.present-answer",
          ),
          "前置 Agent 提问没有完成",
        );

        // Rust 的 Option 在 IPC JSON 中会落成 null。插件状态类型把 mode 声明为可选，
        // 但真实 Host 的空闲态并不是属性缺席；这里必须覆盖线上实际序列化形态。
        host.setVoiceInputStatus({
          phase: "idle",
          mode: null as never,
          source: "system",
          modelId: "sensevoice-small-int8",
          sourceReady: true,
        });
        const statusCallsBeforeMount = host.voiceInputRequests.filter(
          (request) => request.method === "voice.status",
        ).length;
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await waitUntil(
          () => host.voiceInputRequests.filter(
            (request) => request.method === "voice.status",
          ).length > statusCallsBeforeMount,
          "Voice 页面没有读取 Host 的 null idle 状态",
        );

        root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')?.click();
        root.querySelector<HTMLButtonElement>(".command-history-item")?.click();
        await waitUntil(() => {
          const input = root.querySelector<HTMLInputElement>(".chat-input");
          const mic = root.querySelector<HTMLButtonElement>(".chat-mic");
          return input !== null && mic !== null && !input.disabled && !mic.disabled;
        }, "Host mode:null 的空闲态不应禁用 Agent 输入框或听写按钮");
      },
    },
    {
      // 2026-09-27 Voice 链路解耦定稿：转文本与翻译只写回光标处、不弹结果框；3 秒内完成时
      // 确认本次识别结果以收掉中央「处理中」胶囊，也不在角落留下任务卡。
      name: "转文本与翻译命令写回光标处恰好一次，不弹结果框并确认收掉中央胶囊",
      async run({ host }) {
        await pinRawPolish(host, "contract-commands-raw-settings");
        // 翻译默认目标是英文；插件会拦下非目标语言的 Agent 输出（TRANSLATION_WRONG_LANGUAGE），
        // 所以这里给出一段英文译文作为 Agent 的真实结果。
        host.setNextAgentSendText("Test voice command");
        for (const [eventId, commandId] of [
          ["com.reai.voice.command.transcribe", "voice.command.transcribe"],
          ["com.reai.voice.command.translate", "voice.command.translate"],
        ] as const) {
          const commitsBefore = host.cloudRequests.filter(
            (request) => request.method === "voice.deliver.commit",
          ).length;
          const acknowledgementsBefore = host.voiceInputRequests.filter(
            (request) => request.method === "voice.acknowledge-result",
          ).length;
          const started = await host.invokeCommand(eventId);
          const sessionId = (started.ok ? started.output as { sessionId?: string } : undefined)?.sessionId;
          if (!sessionId) throw new Error(`${eventId} 没有开始录音会话`);
          const toggle = host.voiceInputRequests.filter((request) => request.method === "voice.toggle").at(-1);
          if ((toggle?.params as { insertText?: boolean } | undefined)?.insertText !== false) {
            throw new Error(`${eventId} 必须让 Host 只出文本（insertText:false），写回由插件 commit`);
          }
          await host.invokeCommand(eventId);
          if (commandId === "voice.command.translate") {
            await waitUntil(
              () => host.agentRequests.some((request) => request.method === "agent.v2.turn.start"),
              `${eventId} 没有发起通用 Agent 翻译`,
            );
          }
          // 转文本与翻译是「说完直接进目标应用」，跑完必须真的写回去。
          await waitUntil(
            () => host.cloudRequests.filter(
              (request) => request.method === "voice.deliver.commit",
            ).length > commitsBefore,
            `${eventId} 完成后没有把文本写回目标应用`,
          );
          const commit = host.cloudRequests
            .filter((request) => request.method === "voice.deliver.commit")
            .at(-1);
          const expected = commandId === "voice.command.transcribe"
            ? "测试语音命令"
            : "Test voice command";
          if ((commit?.params as { text?: string } | undefined)?.text !== expected) {
            throw new Error(`${eventId} 写回的不是该命令的真实结果`);
          }
          await waitUntil(
            () => host.voiceInputRequests.filter(
              (request) => request.method === "voice.acknowledge-result",
            ).length > acknowledgementsBefore,
            `${eventId} 写回后没有确认本次识别结果（中央胶囊收不掉）`,
          );
          const acknowledgement = host.voiceInputRequests
            .filter((request) => request.method === "voice.acknowledge-result")
            .at(-1);
          if ((acknowledgement?.params as { sessionId?: string } | undefined)?.sessionId !== sessionId) {
            throw new Error(`${eventId} 的确认没有绑定原录音会话`);
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (host.cloudRequests.filter((request) => request.method === "voice.deliver.commit").length !== commitsBefore + 1) {
            throw new Error(`${eventId} 只能写回一次`);
          }
          if (host.voiceCommandRequests.some((request) => request.method === "voice.command.present-answer")) {
            throw new Error(`${eventId} 成功后不应弹结果框`);
          }
          if (host.voiceCommandRequests.some((request) => request.method === "voice.command.present-task")) {
            throw new Error(`${eventId} 3 秒内完成不应在角落留下任务卡`);
          }
        }
      },
    },
    {
      name: "拨杆档位：按键带 yolo 的新会话按 yolo；下一次没带档位的独立新任务回到 chat，不沿用上次",
      async run({ host }) {
        await pinRawPolish(host, "contract-workmode-raw-settings");
        // 档位只在带文件 / 命令工具（范围执行可用）的会话上有意义：按 Host 真实能力声明注入 Pi。
        host.setAgentPiStatus({
          available: true, downloadRequired: false, detail: "",
          capabilities: { hostTools: true, fileTools: true, turnModes: ["chat", "plan", "yolo"], modelSelection: "host-settings", scopedExecutionVersion: 1, commandExecution: true },
        });
        const creates = () => host.agentRequests.filter((request) => request.method === "agent.v2.session.create");
        const before = creates().length;
        // 第一段：硬件按键带 yolo（两次 invoke = 开录 / 结束）。
        await host.invokeCommand("com.reai.voice.command.agent", {}, { workMode: "yolo" });
        await host.invokeCommand("com.reai.voice.command.agent", {}, { workMode: "yolo" });
        await waitUntil(() => creates().length > before, "带 yolo 的语音任务没有新建 Agent 会话");
        const first = creates()[before]!.params as { config?: { mode?: string } };
        if (first.config?.mode !== "yolo") throw new Error(`拨杆 yolo 应落到会话档位，实际 ${String(first.config?.mode)}`);
        const firstTools = ((first.config as { tools?: { ref: string }[] }).tools ?? []).map((tool) => tool.ref);
        if (!firstTools.includes("command")) throw new Error("yolo 会话应申请 command 工具");
        await waitUntil(
          () => host.voiceCommandRequests.filter((request) => request.method === "voice.command.present-answer").length >= 1,
          "第一段没有弹结果面板",
        );
        // 第二段：没有拨杆信息（软件入口 / 无拨杆设备 / 旧 Host），弹窗已关掉 → 独立新任务，必须是 chat。
        host.setVisibleAnswer({ visible: false });
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => creates().length > before + 1, "没带档位的语音任务没有新建 Agent 会话");
        const second = creates()[before + 1]!.params as { config?: { mode?: string } };
        const secondTools = ((second.config as { tools?: { ref: string }[] }).tools ?? []).map((tool) => tool.ref);
        if (secondTools.includes("command")) throw new Error("chat 会话不得申请 command：Host 的工具 × 档位矩阵只在 yolo 接受它，带上会在建会话时被拒");
        if (second.config?.mode !== "chat") {
          const modes = creates().slice(before).map((request) => String((request.params as { config?: { mode?: string } }).config?.mode));
          throw new Error(`没有拨杆信息的新任务应按 chat，实际 ${String(second.config?.mode)}（不得沿用上一次的 yolo）；本场景建的会话档位依次：${modes.join(",")}`);
        }
      },
    },
    {
      name: "结果弹窗还显示着时再按语音键 = 续接同一对话；弹窗不在就是新任务",
      async run({ host }) {
        await pinRawPolish(host, "contract-continue-raw-settings");
        const creates = () => host.agentRequests.filter((request) => request.method === "agent.v2.session.create");
        const starts = () => host.agentRequests.filter((request) => request.method === "agent.v2.turn.start");
        const answers = () => host.voiceCommandRequests.filter((request) => request.method === "voice.command.present-answer");
        const createsBefore = creates().length;
        const answersBefore = answers().length;
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => answers().length > answersBefore, "第一段没有弹结果面板");
        const shown = answers()[answersBefore]!.params as { runId?: string };
        if (!shown.runId) throw new Error("结果面板没有 runId");
        const firstSession = (starts().at(-1)!.params as { sessionId?: string }).sessionId;
        // 弹窗还显示着：Host 回同一 runId → 再按语音键续接同一会话，不新建。
        host.setVisibleAnswer({ visible: true, runId: shown.runId });
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => answers().length > answersBefore + 1, "续接的那段没有弹结果面板");
        if (creates().length !== createsBefore + 1) throw new Error("弹窗还在时再按语音键应续接同一会话，不得新建会话");
        const continued = (starts().at(-1)!.params as { sessionId?: string }).sessionId;
        if (continued !== firstSession) throw new Error("续接应送进同一会话");
        // 弹窗关掉 / 顶掉：Host 回 visible=false → 新任务新会话。
        host.setVisibleAnswer({ visible: false });
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => creates().length > createsBefore + 1, "弹窗不在时再按语音键应新建会话");
        const fresh = (starts().at(-1)!.params as { sessionId?: string }).sessionId;
        if (fresh === firstSession) throw new Error("弹窗不在时不得续接旧会话");
        await waitUntil(() => answers().length > answersBefore + 2, "新任务那段没有弹结果面板");
        const freshRun = (answers().at(-1)!.params as { runId?: string }).runId;
        if (!freshRun) throw new Error("新任务的结果面板没有 runId");
        // 判定在按键开录那一刻冻结（第 2 轮审查）：按键时弹窗在、录音期间被关掉 → 仍续接那条对话。
        host.setVisibleAnswer({ visible: true, runId: freshRun });
        await host.invokeCommand("com.reai.voice.command.agent");
        host.setVisibleAnswer({ visible: false });
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => answers().length > answersBefore + 3, "按键时弹窗在的那段没有弹结果面板");
        if (creates().length !== createsBefore + 2) throw new Error("按键时弹窗在：录音期间关掉也应续接，不得新建会话");
        if ((starts().at(-1)!.params as { sessionId?: string }).sessionId !== fresh) throw new Error("应续接按键那一刻显示着的那条对话");
        // 按键时弹窗不在、录音期间才弹出来 → 仍是新任务，不把新语音并进去。
        host.setVisibleAnswer({ visible: false });
        await host.invokeCommand("com.reai.voice.command.agent");
        host.setVisibleAnswer({ visible: true, runId: freshRun });
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => creates().length > createsBefore + 2, "按键时没弹窗的那段应新建会话");
        if ((starts().at(-1)!.params as { sessionId?: string }).sessionId === fresh) throw new Error("录音期间才弹出来的结果不得把新语音并进去");
        await waitUntil(() => answers().length > answersBefore + 4, "最后一段没有弹结果面板");
      },
    },
    {
      name: "Agent 提问弹面板给人看，不往目标应用写字；失败时也不写",
      async run({ host }) {
        await pinRawPolish(host, "contract-agent-question-raw-settings");
        const commitsBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        const agentBefore = host.agentRequests.length;
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(
          () =>
            host.voiceCommandRequests.some(
              (request) => request.method === "voice.command.present-answer",
            ),
          "Agent 提问跑完没有弹结果面板",
        );
        const answer = host.voiceCommandRequests.find(
          (request) => request.method === "voice.command.present-answer",
        );
        const params = answer?.params as
          | { text?: string; originalText?: string }
          | undefined;
        if (params?.text !== "这是测试 Agent 回复" || params?.originalText !== "测试语音命令") {
          throw new Error("面板要同时给出答案与用户原话，供人核对");
        }
        // Agent 命令走 agent.session@2：先查后端，再 create + start/get；不得
        // 根据 Pi/DSH 选择绕回私有 Harness 接口。
        await waitUntil(
          () => host.agentRequests.some((request) => request.method === "agent.v2.turn.start"),
          "Agent 提问没有走通用 Agent 会话通道",
        );
        const agentUsed = host.agentRequests.slice(agentBefore);
        if (!agentUsed.some((request) => request.method === "agent.v2.backends.list")) {
          throw new Error("Agent 提问前必须确认所选后端可用");
        }
        if (!agentUsed.some((request) => request.method === "agent.v2.session.create")) {
          throw new Error("Agent 提问必须先创建通用会话再发送");
        }
        if (host.dshRequests.length !== 0) {
          throw new Error("Voice 不得绕开通用 Agent 服务直接调用 DSH");
        }
        // 结果需要人看一眼的命令，绝不能零点击写进用户正在打字的那个应用。
        if (
          host.cloudRequests.filter((request) => request.method === "voice.deliver.commit")
            .length !== commitsBefore
        ) {
          throw new Error("Agent 提问的结果不该写回目标应用");
        }

        // 失败同样不写，并且仍走短结果面板：Agent 提问没有「拿原文顶上」这一说。
        const failedAnswersBefore = host.voiceCommandRequests.filter(
          (request) => request.method === "voice.command.present-answer",
        ).length;
        const upstream = "AI_PAYMENT_REQUIRED: INVALID_REQUEST: 502: Dsh 模型请求含 Host 未放行的字段";
        host.rejectNextAgentSend({ kind: "engine", stderr_tail: upstream });
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(
          () =>
            host.voiceCommandRequests.filter(
              (request) => request.method === "voice.command.present-answer",
            ).length > failedAnswersBefore,
          "Agent 提问失败没有进入短结果面板",
        );
        const failedAnswer = host.voiceCommandRequests
          .filter((request) => request.method === "voice.command.present-answer")
          .at(-1)?.params as { status?: string; canCopy?: boolean; canContinue?: boolean; errorCode?: string; originalText?: string; text?: string; sections?: { label: string; text: string }[] } | undefined;
        // §6.0：业务失败字段与正常复制只含可读原因，结构化码供 Host 开发模式诊断使用。
        // 此suite观察Host处理前的插件请求；技术区及复制门禁由Host真实组件回归验证。
        // 原文、继续处理入口保留，但原文不能冒充成功结果，失败也不得注入目标应用。
        const recovery = "当前额度不足。你的内容已保存，补充额度后可以重新发送。";
        const technicalMarkers = ["诊断信息", "错误码:", "插件版本:", "App 版本:", "Host API:", "当前步骤:", "生成时间:", "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED", "INVALID_REQUEST", "502", "AGENT_ENGINE"];
        if (
          failedAnswer?.status !== "failed"
          || failedAnswer.canCopy !== true
          || failedAnswer.canContinue !== true
          || failedAnswer.errorCode !== "AGENT_ENGINE"
          || failedAnswer.originalText !== "测试语音命令"
          || failedAnswer.text !== recovery
          || !failedAnswer.sections?.some((section) => section.label === "错误" && section.text === recovery)
          || !failedAnswer.sections?.some((section) => section.label === "原文" && section.text === failedAnswer.originalText)
          || failedAnswer.sections?.some((section) => technicalMarkers.some((marker) => section.label.includes(marker) || section.text.includes(marker)))
        ) {
          throw new Error(`Agent 提问失败须保留原因、原文和恢复入口，业务正文不带技术诊断且不冒充成功结果：${JSON.stringify(failedAnswer)}`);
        }
        if (
          host.cloudRequests.filter((request) => request.method === "voice.deliver.commit")
            .length !== commitsBefore
        ) {
          throw new Error("Agent 提问失败时不得写回任何文本");
        }
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')?.click();
        await waitUntil(
          () => root.textContent?.includes("当前额度不足。你的内容已保存，补充额度后可以重新发送。") === true,
          `Agent 失败没有保留额度不足的解决办法；当前页面：${root.textContent}`,
        );
        if (["INVALID_REQUEST", "502", "Dsh", "Host"].some((text) => root.textContent?.includes(text))) {
          throw new Error(`Agent 失败页面泄露了内部错误：${root.textContent}`);
        }
      },
    },
    {
      name: "共享组件未授权给 Voice 时走自身授权入口，取消不执行，修复后明确重试",
      async run({ host }) {
        host.setAgentPiStatus({ available: true, detail: "", downloadRequired: true });
        host.setAgentDshStatus({ available: false, detail: "download_required: com.reai.runtime.dsh", downloadRequired: true });
        const main = await host.openSurface("main");
        const started = () => host.voiceInputRequests.filter((request) => request.method === "voice.toggle").length;
        const sends = () => host.agentRequests.filter((request) => request.method === "agent.v2.session.create" || request.method === "agent.v2.turn.start").length;
        const startsBefore = started();
        const sendsBefore = sends();
        const tasksBefore = host.systemTaskRequests.length;
        for (const command of ["com.reai.voice.command.agent", "com.reai.voice.command.translate"]) {
          await host.invokeCommand(command);
        }
        const setups = host.systemTaskRequests.slice(tasksBefore).filter((request) => request.method === "system.tasks.open");
        if (setups.length !== 2) throw new Error("每次明确动作应且仅应发起一次来源插件修复导航");
        for (const setup of setups) {
          const params = setup.params as { target?: string; appId?: string; returnIntent?: { reason?: string; backend?: string } };
          if (params.target !== "app-managed-resources" || params.appId !== undefined || params.returnIntent?.reason !== "voice-agent-runtime" || typeof params.returnIntent.backend !== "string") {
            throw new Error("Voice 必须使用 Host 注入的来源身份与 Host 自己的选择顺序，不能指定其他插件或替代授权");
          }
        }
        await host.sendIntent(main.surfaceMountId, { type: "system-task.return", taskId: "mock-system-task", target: "app-managed-resources", outcome: "cancelled" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (started() !== startsBefore || sends() !== sendsBefore) throw new Error("授权前或取消后不得录音、创建会话或发送模型请求");
        const answer = host.voiceCommandRequests.filter((request) => request.method === "voice.command.present-answer").at(-1)?.params as { text?: string } | undefined;
        if (!answer?.text?.includes("Agent") || /\b(DSH|Dsh|Pi|Codex)\b/.test(answer.text) || answer.text.includes("生命周期")) throw new Error("缺少 Voice 授权时只提示 Agent 服务未就绪，不出现引擎名，也不能误报全局未安装");

        // The mock only models the subsequent authoritative status. Native acceptance
        // must separately prove Host preview/confirmation/attachment, not forge a receipt.
        host.setAgentDshStatus({ available: true, detail: "", downloadRequired: false });
        await host.sendIntent(main.surfaceMountId, { type: "system-task.return", taskId: "mock-system-task", target: "app-managed-resources", outcome: "succeeded" });
        if (started() !== startsBefore || sends() !== sendsBefore) throw new Error("返回来源插件不能自动重发");
        await host.invokeCommand("com.reai.voice.command.agent");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => host.agentRequests.some((request) => request.method === "agent.v2.turn.start"), "明确重试后没有走 Agent create/send");
        if (host.systemTaskRequests.slice(tasksBefore).filter((request) => request.method === "system.tasks.open").length !== 2) throw new Error("已有可用DSH时不应因可选Pi未授权再次跳转");
      },
    },
    {
      name: "运行组件导航失败保留手动入口且不透传内部错误",
      async run({ host }) {
        host.setAgentPiStatus({ available: false, detail: "", downloadRequired: true });
        host.setAgentDshStatus({ available: false, detail: "", downloadRequired: true });
        host.rejectNextSystemTaskOpen("private-error-details");
        await host.invokeCommand("com.reai.voice.command.agent");
        await waitUntil(() => host.voiceCommandRequests.some((request) => request.method === "voice.command.present-answer"), "导航失败没有可操作反馈");
        const answer = host.voiceCommandRequests.filter((request) => request.method === "voice.command.present-answer").at(-1)?.params as { text?: string } | undefined;
        // 2026-10-24 起文案不再提「运行组件 / 引擎名」：说明到 Driver 里完成 Agent 服务安装即可，内部错误不透传。
        if (!answer?.text?.includes("未能打开安装页面") || !answer.text.includes("Driver") || answer.text.includes("private-error-details")) throw new Error("导航失败文案必须说明手动入口并隐藏内部细节");
        if (host.agentRequests.some((request) => request.method === "agent.v2.session.create") || host.voiceInputRequests.some((request) => request.method === "voice.toggle")) throw new Error("导航失败不得继续请求");
      },
    },
    {
      name: "转文本写回原文；翻译失败弹取回卡注明翻译失败，绝不把原文当成译文写回",
      async run({ host }) {
        await pinRawPolish(host, "contract-transcribe-raw-settings");
        // 原样档下转文本没有后续 Agent 步骤，直接写回本地识别原文。
        const commitsBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        await host.invokeCommand("com.reai.voice.command.transcribe");
        await host.invokeCommand("com.reai.voice.command.transcribe");
        await waitUntil(
          () =>
            host.cloudRequests.filter(
              (request) => request.method === "voice.deliver.commit",
            ).length > commitsBefore,
          "转文本没有写回本地识别原文",
        );
        const fallback = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.commit")
          .at(-1);
        if ((fallback?.params as { text?: string } | undefined)?.text !== "测试语音命令") {
          throw new Error("转文本写回的必须是本地识别原文");
        }
        // 回退成功也要留一条历史：文字确实写进了目标应用，历史里一条不留的话用户
        // 回头找不到自己说过什么。云端权限没开通的这段时间里这是常态路径。
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/command-history"),
          "转文本成功后没有写入历史",
        );

        // 翻译：有实质的后续步骤，用原文冒充译文是把失败包装成成功
        // ——用户说中文期望英文，拿到中文，系统还说「已写入」。
        const commitsBeforeTranslate = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        const takebacksBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.present-takeback",
        ).length;
        host.rejectNextAgentSend({ kind: "engine", stderr_tail: "Agent 翻译不可用（测试注入）" });
        await host.invokeCommand("com.reai.voice.command.translate");
        await host.invokeCommand("com.reai.voice.command.translate");
        // 2026-09-27 定稿：翻译本身失败不写原文，只弹一张取回卡，标题注明「翻译失败」、内容是原文。
        await waitUntil(
          () =>
            host.cloudRequests.filter(
              (request) => request.method === "voice.deliver.present-takeback",
            ).length > takebacksBefore,
          "翻译失败没有弹出取回卡",
        );
        const card = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.present-takeback")
          .at(-1)?.params as { title?: string; reason?: string; text?: string } | undefined;
        if (card?.title !== "翻译失败" || card.text !== "测试语音命令" || !card.reason) {
          throw new Error(`翻译失败取回卡必须注明翻译失败并带原文，实际：${JSON.stringify(card)}`);
        }
        if (card.reason.includes("Agent 翻译不可用")) {
          throw new Error("取回卡原因不得透传上游错误文案");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        const commitsAfterTranslate = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        if (commitsAfterTranslate !== commitsBeforeTranslate) {
          throw new Error("翻译失败时不得写回任何文本");
        }
        if (host.voiceCommandRequests.some((request) => request.method === "voice.command.present-answer")) {
          throw new Error("翻译失败只弹取回卡，不再另弹失败结果框");
        }
      },
    },
    {
      name: "toggle-input 先进入 listening，再完成识别并保存历史",
      async run({ host }) {
        await pinRawPolish(host, "contract-toggle-input-raw-settings");
        const configureCallsBefore = host.voiceInputRequests.filter(
          (request) => request.method === "voice.configure",
        ).length;
        const replayStatusCallsBefore = host.voiceInputRequests.filter(
          (request) => request.method === "voice.recordings.replay-status",
        ).length;
        const started = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("第一次语音键应进入 listening");
        }
        const finished = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!finished.ok || (finished.output as { phase?: string }).phase !== "recognizing") {
          throw new Error("第二次语音键应立即进入后台 recognizing");
        }
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "识别历史没有写入 Voice 私有 KV",
        );
        const configureCallsDuringToggles = host.voiceInputRequests.filter(
          (request) => request.method === "voice.configure",
        ).length - configureCallsBefore;
        if (configureCallsDuringToggles !== 0) {
          throw new Error("显式设置已经成功配置；开始与完成录音都不得重复 configure 覆盖 Host 音源");
        }
        // 落下回听片段之后必须再问一次权威的「录音缓存」状态：本地那次就地并入只让
        // 保留下沿往回走，而 Host 的下沿会随过期清理与配额淘汰前移。不追这一次，
        // 跨天或撑满共用配额之后详情页就会显示一条点了取不到件的播放条。
        // 数次数而不是 some()：将来有人在前半段插一句会触发 refresh 的操作，
        // some() 会静默变成恒真，这条断言就白站了。
        await waitUntil(
          () =>
            host.voiceInputRequests.filter(
              (request) => request.method === "voice.recordings.replay-status",
            ).length > replayStatusCallsBefore,
          "识别完成后没有回读权威的录音缓存状态",
        );
        const main = await host.openSurface("main");
        const history = main.root?.querySelector<HTMLButtonElement>(".task-item");
        if (!history?.textContent?.includes("测试语音输入")) {
          throw new Error("真实识别结果没有渲染进 Voice 历史");
        }
        history.click();
        if (!main.root?.querySelector(".input-detail")) {
          throw new Error("语音历史无法进入只读详情页");
        }
        if (!main.root?.querySelector(".replay-bar")) {
          throw new Error("本地识别刚录完的详情页必须立即显示播放器，不能误报录音已过期");
        }
        if (!main.root?.querySelector(".detail-engine.local")?.textContent?.includes("本地识别")) {
          throw new Error("本地识别历史必须按当次实际路径标记，不能读取当前设置反推");
        }
      },
    },
    {
      name: "三种语音胶囊行为共用关闭入口：Agent 可由语音输入键结束",
      async run({ host }) {
        const started = await host.invokeCommand("com.reai.voice.command.agent");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("Agent 开关第一次触发应进入 listening");
        }

        // 用户可能把 Agent 绑在双击、语音输入绑在单击。胶囊已经存在时，任意一条
        // 语音开关都只负责结束当前采集，不能按命令 ID 隔离成 VOICE_BUSY。
        const finishedByInput = await host.invokeCommand("com.reai.voice.toggle-input");
        if (
          !finishedByInput.ok
          || (finishedByInput.output as { phase?: string }).phase !== "recognizing"
        ) {
          throw new Error("Agent 录音必须能由语音输入开关结束并进入 recognizing");
        }

        await waitUntil(
          () => host.voiceCommandRequests.some(
            (request) => request.method === "voice.command.present-answer",
          ),
          "跨入口结束 Agent 录音后没有继续完成原先的 Agent 任务",
        );
      },
    },
    {
      name: "三种语音胶囊行为共用关闭入口：语音输入可由翻译键结束",
      async run({ host }) {
        const started = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("语音输入第一次触发应进入 listening");
        }

        const finishedByTranslate = await host.invokeCommand(
          "com.reai.voice.command.translate",
        );
        if (
          !finishedByTranslate.ok
          || (finishedByTranslate.output as { phase?: string }).phase !== "recognizing"
        ) {
          throw new Error("语音输入录音必须能由翻译开关结束并进入 recognizing");
        }

        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "跨入口结束语音输入后没有按最初的转文本行为保存结果",
        );
      },
    },
    {
      name: "清空语音记录同时删除全天记录、按键回听与输入历史",
      async run({ host }) {
        const now = Date.now();
        host.setVoiceRecordings([{
          id: "clear-all-recording",
          wallStartMs: now - 30_000,
          durationMs: 10_000,
          transport: "usb_vendor_hid",
          transcriptText: "这条有效记录应该被一起清掉。",
          transcribedAtMs: now - 20_000,
        }]);
        await host.disable();
        await host.installAndEnable();
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "前置语音输入没有生成历史",
        );

        const root = await openSettings(host, "contract-clear-all-recordings-settings");
        const clear = root.querySelector<HTMLButtonElement>(
          '[data-settings-target="replay-cache"] .settings-row-danger',
        );
        if (!clear || clear.disabled) throw new Error("有记录时清空语音记录不可用");
        clear.click();
        await waitUntil(() => host.getVoiceRecordings().length === 0, "全天有效记录没有清空");
        await waitUntil(
          () => host.voiceInputRequests.some(
            (request) => request.method === "voice.recordings.replay-clear",
          ),
          "按键回听没有清空",
        );
        await waitUntil(
          () => root.textContent?.includes("删除本机保存的转写与对应录音") === true
            && root.querySelector<HTMLButtonElement>(
              '[data-settings-target="replay-cache"] .settings-row-danger',
            )?.disabled === true,
          "清空后页面仍把本地语音记录显示成可清理",
        );
      },
    },
    {
      name: "云端引擎：转写成功后把云端文本写回并存入历史",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-success-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );
        // 本场景验证云端转写与写回权限语义，钉住原样档，别让默认润色改写转写文本。
        await selectPolishLevel(root, "原样");

        const started = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("云端引擎第一次语音键应进入 listening");
        }
        const startToggle = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          .at(-1);
        if ((startToggle?.params as { retainAudio?: boolean } | undefined)?.retainAudio !== true) {
          throw new Error("云端引擎必须在开始录音时请求 retainAudio，否则音频不会留给云端");
        }
        const replayStatusCallsAfterStart = host.voiceInputRequests.filter(
          (request) => request.method === "voice.recordings.replay-status",
        ).length;

        const finished = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!finished.ok || (finished.output as { phase?: string }).phase !== "recognizing") {
          throw new Error("云端引擎第二次语音键应立即进入后台 recognizing");
        }
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "ai.audio.transcribe"),
          "结束录音后没有发起云端转写",
        );
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "voice.deliver.commit"),
          "云端转写成功后没有把文本写回录音时的应用",
        );
        const commit = host.cloudRequests.find(
          (request) => request.method === "voice.deliver.commit",
        );
        if ((commit?.params as { text?: string } | undefined)?.text !== "测试云端转写") {
          throw new Error("写回的必须是云端转写结果，不能是本地识别或编造的文本");
        }
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "云端识别结果没有写入历史",
        );
        await waitUntil(
          () =>
            host.voiceInputRequests.filter(
              (request) => request.method === "voice.recordings.replay-status",
            ).length > replayStatusCallsAfterStart,
          "云端识别完成后没有回读权威的录音缓存状态",
        );
        const detail = await host.openSurface("main");
        const item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        if (!item?.textContent?.includes("测试云端转写")) {
          throw new Error("云端识别文本没有渲染进 Voice 历史");
        }
        item.click();
        if (!detail.root?.querySelector(".replay-bar")) {
          throw new Error("云端识别刚录完的详情页必须立即显示播放器，不能误报录音已过期");
        }
        const engine = detail.root?.querySelector(".detail-engine.cloud");
        if (!engine?.textContent?.includes("云端识别") || !engine.textContent.includes("已发送到云端")) {
          throw new Error("云端识别历史必须标明该条音频实际发送到云端完成转写");
        }
      },
    },
    {
      name: "云端引擎：语音命令链同样以 retainAudio 留音频并走云端转写再喂 Agent",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-command-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        // 命令链验证「转写文本原样进 Agent」的路由，钉原样档，别让润色改写转写文本。
        await selectPolishLevel(root, "原样");

        const started = await host.invokeCommand("com.reai.voice.toggle-command");
        if (!started.ok || (started.output as { phase?: string }).phase !== "listening") {
          throw new Error("云端引擎第一次语音命令应进入 listening");
        }
        const startToggle = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          .at(-1);
        if ((startToggle?.params as { retainAudio?: boolean } | undefined)?.retainAudio !== true) {
          throw new Error("云端语音命令必须在开始录音时请求 retainAudio，否则被「非 retainAudio 就查本地模型」门禁挡死");
        }

        const finished = await host.invokeCommand("com.reai.voice.toggle-command");
        if (!finished.ok || (finished.output as { phase?: string }).phase !== "recognizing") {
          throw new Error("云端语音命令第二次触发应立即进入后台 recognizing");
        }
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "ai.audio.transcribe"),
          "云端语音命令结束后没有发起云端转写",
        );
        await waitUntil(
          () => host.agentRequests.some((request) => request.method === "agent.v2.turn.start"),
          "云端转写结果没有交给命令 Agent",
        );
        const run = host.agentRequests.find(
          (request) => request.method === "agent.v2.turn.start",
        );
        if ((run?.params as { text?: string } | undefined)?.text !== "测试云端转写") {
          throw new Error("命令 Agent 只应收到云端转写文本，不能是 null 或编造的文本");
        }
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/command-history"),
          "云端语音命令结果没有写入命令历史",
        );
      },
    },
    {
      name: "云端引擎：转写出空文本时安静回到 idle，不写回也不编一条空历史",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-empty-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );

        host.setNextAiAudioTranscribeText("");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "ai.audio.transcribe"),
          "结束录音后没有发起云端转写",
        );
        // 给收尾一点时间跑完（拿到空文本之后还要 publish 回 idle）。
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (host.cloudRequests.some((request) => request.method === "voice.deliver.commit")) {
          throw new Error("云端转写出空文本时不该发起写回");
        }
        if (host.storageKeys().includes("com.reai.voice/voice-state/history")) {
          throw new Error("云端转写出空文本不该写入历史（没有识别到内容，不是失败）");
        }
        if (root.querySelector(".settings-error")) {
          throw new Error("空转写不是失败，不该显示成行内错误");
        }
      },
    },
    {
      name: "云端引擎：转写失败给出行内错误，不编造文本、不静默切本地，且不打断下一次使用",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-failure-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );

        host.failNextAiAudioTranscribe("AI_UNAVAILABLE");

        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "ai.audio.transcribe"),
          "失败前必须真的发起过一次转写，而不是提前短路",
        );
        // 失败要给用户「立刻能感知、能立刻重试」的反馈，而不是无声无息——
        // 设置页仍然开着，同一个 root 会随 state 更新自己重渲染。
        await waitUntil(
          () => root.querySelector(".settings-error")?.textContent?.includes("云端识别失败") === true,
          "云端转写失败没有在设置页给出可读反馈",
        );
        if (host.cloudRequests.some((request) => request.method === "voice.deliver.commit")) {
          throw new Error("云端转写失败后不该发起写回——没有可信文本");
        }
        if (host.storageKeys().includes("com.reai.voice/voice-state/history")) {
          throw new Error("云端转写失败不该写入历史（不编造文本，不假装识别过）");
        }

        // 失败不打断——切回本地引擎后必须仍然完整可用。
        await selectEngine(root, "local");
        await waitUntil(
          () => engineSegButton(root, "local").classList.contains("active"),
          "切回本地引擎没有生效",
        );

        const startedLocal = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!startedLocal.ok || (startedLocal.output as { phase?: string }).phase !== "listening") {
          throw new Error("切回本地引擎后语音键应仍能正常开始录音");
        }
        const finishedLocal = await host.invokeCommand("com.reai.voice.toggle-input");
        if (!finishedLocal.ok || (finishedLocal.output as { phase?: string }).phase !== "recognizing") {
          throw new Error("切回本地引擎后语音键应仍能正常完成录音");
        }
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "切回本地引擎后识别历史应正常写入",
        );
      },
    },
    {
      name: "云端引擎：转写因未授权失败时给出指路文案，不是笼统错误",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-transcribe-permission-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );

        // 未授权 cloud.model.invoke@1 是双层能力门禁的异常路径（throw），
        // 不是普通网络失败——文案必须指路去权限页，不能是通用的「云端识别失败：……」。
        host.failNextAiAudioTranscribe("AI_NOT_GRANTED");

        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.some((request) => request.method === "ai.audio.transcribe"),
          "失败前必须真的发起过一次转写",
        );
        await waitUntil(
          () => root.querySelector(".settings-error")?.textContent?.includes("已安装扩展") === true,
          "未授权转写没有给出指路到权限页的文案",
        );
        if (root.querySelector(".settings-error")?.textContent?.includes("云端识别失败：")) {
          throw new Error("未授权应该给专门的指路文案，不该退化成笼统的「云端识别失败：……」");
        }
      },
    },
    {
      name: "云端引擎：写回因未授权失败时转写结果仍保存到历史，并给出指路警告",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-deliver-permission-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );
        // 本场景验证「转写成功、写回被拒」的中间态，钉住原样档保持转写文本原样。
        await selectPolishLevel(root, "原样");

        // voice.deliver@1 是与 cloud.model.invoke@1 独立的开关，「转写开了、
        // 写回没开」是很自然的中间态：转写照常成功，只有写回这一步失败。
        host.failNextVoiceDeliverCommit("VOICE_DELIVER_PERMISSION_REQUIRED");

        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "写回失败不该抹掉已经拿到的转写结果——识别成功就该存历史",
        );

        const detail = await host.openSurface("main");
        const item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        if (!item?.textContent?.includes("测试云端转写")) {
          throw new Error("写回失败时转写文本没有进入历史");
        }
        item.click();
        // 只查警告元素本身，不查整页文本——设置页的引擎说明里同样出现
        // 「已安装扩展」这几个字，查整页在这里凑巧不误报，但不该靠凑巧。
        const warning = detail.root?.querySelector(".inline-warning")?.textContent ?? "";
        if (!warning.includes("已安装扩展")) {
          throw new Error("写回因未授权失败时没有给出指路到权限页的警告文案");
        }
        if (warning.includes("文字写入失败，识别结果仍保留在历史中")) {
          throw new Error("未授权应该给专门的指路文案，不该退化成笼统的「文字写入失败」");
        }
      },
    },
    {
      name: "云端引擎：写回被 Host 正常拒绝（非授权异常）时，denied/expired 各给出对应文案",
      async run({ host }) {
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-cloud-engine-deliver-denied-settings",
          payload: { type: "open-settings" },
        });
        await selectEngine(root, "cloud");
        await waitUntil(
          () => engineSegButton(root, "cloud").getAttribute("aria-checked") === "true",
          "切换云端引擎没有完成保存",
        );

        // denied 可能是旧 Host 的一般投递失败或目标 owner 拒绝，不能推断系统权限。
        host.setNextVoiceDeliverCommitReason("denied");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "denied 写回失败不该抹掉转写结果",
        );
        let detail = await host.openSurface("main");
        let item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        item?.click();
        let warning = detail.root?.querySelector(".inline-warning")?.textContent ?? "";
        if (!warning.includes("文字写入失败") || warning.includes("权限")) {
          throw new Error(`denied 应保留中性写入失败提示，实际："${warning}"`);
        }

        // expired：写回窗口过期，同样是正常业务失败，不是权限问题。
        host.setNextVoiceDeliverCommitReason("expired");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "expired 写回失败不该抹掉转写结果",
        );
        detail = await host.openSurface("main");
        item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        item?.click();
        warning = detail.root?.querySelector(".inline-warning")?.textContent ?? "";
        if (!warning.includes("过期")) {
          throw new Error(`expired 应显示写回窗口过期提示，实际："${warning}"`);
        }
      },
    },
    {
      name: "润色开启后由插件负责写回：Host 不许先把原文打进去",
      async run({ host }) {
        const root = await openSettings(host, "contract-polish-success-settings");
        await selectPolish(root, "轻度");
        // selectPolish already waits for the saved choice to render as selected.

        host.setNextAiTextGenerateText("我认为应该先完成界面，再对接 API。");
        const generateCountBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const deliverCountBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        const toggleCountBefore = host.voiceInputRequests.filter(
          (request) => request.method === "voice.toggle",
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        const replayStatusCallsAfterStart = host.voiceInputRequests.filter(
          (request) => request.method === "voice.recordings.replay-status",
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "ai.text.generate",
          ).length > generateCountBefore,
          "润色开着却没有发起文本生成",
        );

        // 关键约束：Host 收到的是 insertText:false。否则原文会先被打进输入框，
        // 润色稿再打一遍，用户看到同一句话出现两次。
        const startToggle = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          [toggleCountBefore];
        if ((startToggle?.params as { insertText?: boolean } | undefined)?.insertText !== false) {
          throw new Error("润色开启时必须显式让 Host 不要写回，否则会双份注入");
        }

        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "voice.deliver.commit",
          ).length > deliverCountBefore,
          "润色完成后没有把润色稿写回",
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        const commit = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.commit")
          [deliverCountBefore];
        if (
          (commit?.params as { text?: string } | undefined)?.text
          !== "我认为应该先完成界面，再对接 API。"
        ) {
          throw new Error("写回的必须是润色稿，不能是识别原文");
        }

        // 待润色文本必须原样进入云端润色消息，不能被塞进 system 提示词。
        const generate = host.cloudRequests
          .filter((request) => request.method === "ai.text.generate")
          [generateCountBefore];
        if (!JSON.stringify(generate?.params ?? {}).includes("测试云端转写")) {
          throw new Error("需要整理的转写必须原样进入云端润色消息");
        }

        const detail = await host.openSurface("main");
        const item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        item?.click();
        if (!detail.root?.querySelector(".detail-original-transcript")?.textContent?.includes("测试云端转写")) {
          throw new Error("润色改动过原文时详情页必须给出前后对照");
        }
        if (!detail.root?.querySelector(".replay-bar")) {
          throw new Error("本地润色路径刚录完也必须立即显示播放器");
        }
        if (!detail.root?.querySelector(".detail-engine.cloud")?.textContent?.includes("云端识别")) {
          throw new Error("云端引擎下的润色记录必须保留云端识别来源");
        }
        if (
          host.voiceInputRequests.filter(
            (request) => request.method === "voice.recordings.replay-status",
          ).length <= replayStatusCallsAfterStart
        ) {
          throw new Error("本地润色完成后没有回读权威的录音缓存状态");
        }
      },
    },
    {
      name: "润色失败：回退原样注入，历史如实标注，不把失败伪装成成功",
      async run({ host }) {
        const root = await openSettings(host, "contract-polish-failure-settings");
        await selectPolish(root, "轻度");
        // selectPolish already waits for the saved choice to render as selected.

        host.failNextAiTextGenerate("AI_UNAVAILABLE");
        const generateCountBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const deliverCountBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "ai.text.generate",
          ).length > generateCountBefore,
          "润色失败前必须真的发起过一次生成",
        );
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "voice.deliver.commit",
          ).length > deliverCountBefore,
          "润色失败后必须仍然把原话写回——用户的输入不能因此丢掉",
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        const commit = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.commit")
          [deliverCountBefore];
        if ((commit?.params as { text?: string } | undefined)?.text !== "测试云端转写") {
          throw new Error("润色失败时写回的必须是识别原文，不能是编造或半成品文本");
        }

        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "润色失败的这一条仍然要进历史",
        );
        const detail = await host.openSurface("main");
        const item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        item?.click();
        const warning = detail.root?.querySelector(".inline-warning")?.textContent ?? "";
        if (!warning.includes("按你说的原话写入")) {
          throw new Error(`润色失败必须在历史里如实标注，实际："${warning}"`);
        }
        const values = Array.from(detail.root?.querySelectorAll(".metadata-value") ?? []).map(
          (node) => node.textContent,
        );
        if (!values.includes("轻度润色未完成 · 原样注入")) {
          throw new Error(`详情页必须把「润色没跑成」和「本来就没开润色」分开，实际：${values.join("/")}`);
        }
      },
    },
    {
      name: "润色上下文：关掉窗口这一档时宿主一个字都不读",
      async run({ host }) {
        const root = await openSettings(host, "contract-polish-context-settings");
        await selectPolish(root, "轻度");
        // selectPolish already waits for the saved choice to render as selected.
        const before = host.voiceInputRequests.filter(
          (request) => request.method === "voice.context.capture",
        ).length;
        const generateCountBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const deliverCountBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;

        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "ai.text.generate",
          ).length > generateCountBefore,
          "润色没有跑起来",
        );
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "voice.deliver.commit",
          ).length > deliverCountBefore,
          "润色上下文场景没有完成写回",
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        const captures = host.voiceInputRequests
          .filter((request) => request.method === "voice.context.capture")
          .slice(before);
        // 窗口这一档默认关闭：截图 provider 探权限那一次同样不许要窗口文字。
        if (captures.some((request) => (request.params as { includeWindowText?: boolean }).includeWindowText === true)) {
          throw new Error("窗口上下文关闭时不得向宿主索取窗口文字");
        }
      },
    },
    {
      name: "云端润色 + 写回权限被拒：下一句在录音前拦住，不再丢字",
      async run({ host }) {
        const root = await openSettings(host, "contract-polish-deliver-denied-settings");
        await selectPolish(root, "轻度");
        // selectPolish already waits for the saved choice to render as selected.

        // 润色档下写回归插件；而 voice.deliver@1 是用户可以拒的可选权限。
        const deliverCountBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        const rejectionCountBefore = host.rejections.filter(
          (entry) => entry.reason.includes("VOICE_DELIVER_PERMISSION_REQUIRED"),
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        // 只在本轮录音已经进入 listening 后注入，避免被上一场景仍在收尾的请求消费。
        host.failNextVoiceDeliverCommit("VOICE_DELIVER_PERMISSION_REQUIRED");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.cloudRequests.filter(
            (request) => request.method === "voice.deliver.commit",
          ).length > deliverCountBefore,
          "润色完成后没有尝试写回",
        );
        await waitUntil(
          () => host.rejections.filter(
            (entry) => entry.reason.includes("VOICE_DELIVER_PERMISSION_REQUIRED"),
          ).length > rejectionCountBefore,
          "写回权限失败注入没有被消费",
        );
        // 第二次硬件触发按合同只负责结束采集，润色、写回和状态发布在后台继续。
        // Host 记下拒绝发生在 publish 之前；必须等页面状态真正落地，才能开始验证
        // “下一句退回 Host 原文注入”，否则是在用下一次命令和上一轮收尾赛跑。
        await waitUntil(
          () => root.textContent?.includes("润色已暂停") === true,
          "写回权限被拒后设置页没有说明润色为什么停了",
        );

        const generatesBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const togglesBefore = host.voiceInputRequests.filter(
          (request) => request.method === "voice.toggle",
        ).length;

        // 云端引擎没有本地 transcript，不能假装能退回 Host 原样注入，也不能静默
        // 换引擎。第二段必须在录音开始前失败，避免用户整句说完才发现仍写不回去。
        const blocked = await host.invokeCommand("com.reai.voice.toggle-input");
        if (blocked.ok || blocked.error.code !== "com.reai.voice/VOICE_DELIVER_PERMISSION_REQUIRED") {
          throw new Error(
            `写回权限被拒后，下一次云端录音必须以稳定权限码在采集前拦住，实际：${JSON.stringify(blocked)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        const generatesAfter = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        if (generatesAfter !== generatesBefore) {
          throw new Error("写不回去的时候不该再花一次云端额度做润色");
        }
        if (
          host.voiceInputRequests.filter((request) => request.method === "voice.toggle").length
          !== togglesBefore
        ) {
          throw new Error("权限封锁期间不应开始新的录音");
        }

        // 并且要把原因摆到设置页上，而不是让用户自己猜为什么润色不生效了。
        if (!root.textContent?.includes("润色已暂停")) {
          throw new Error("录音前拦截后不应丢掉润色暂停说明");
        }

        // 界面承诺「开启后把档位切一下即可恢复」——那句话必须是真的。
        // 封锁期间插件不再负责写回，「写回成功就解封」那条路本地引擎永远走不到，
        // 所以切换档位是唯一拿得到的复位信号。
        await selectPolish(root, "原样");
        await selectPolish(root, "规整");
        await waitUntil(
          () => root.textContent?.includes("润色已暂停") !== true,
          "切换档位之后「润色已暂停」应当消失，否则界面在承诺一个做不到的恢复路径",
        );
        await host.invokeCommand("com.reai.voice.toggle-input");
        const resumed = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          .at(-1);
        if ((resumed?.params as { insertText?: boolean } | undefined)?.insertText !== false) {
          throw new Error("恢复之后应重新由插件负责写回（Host 收到 insertText:false）");
        }
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () =>
            host.cloudRequests.filter((request) => request.method === "ai.text.generate").length
            > generatesAfter,
          "恢复之后润色应当重新跑起来",
        );
      },
    },
    {
      name: "润色失败与目标不可用分别记录，不推断焦点变化时间",
      async run({ host }) {
        const root = await openSettings(host, "contract-polish-focus-changed-settings");
        await selectPolish(root, "轻度");
        // selectPolish already waits for the saved choice to render as selected.

        // Host reports target availability, not when a focus change happened.
        host.failNextAiTextGenerate("AI_UNAVAILABLE");
        host.setNextVoiceDeliverCommitReason("focus_changed");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "超时回退后仍要落历史",
        );
        const detail = await host.openSurface("main");
        const item = detail.root?.querySelector<HTMLButtonElement>(".task-item");
        item?.click();
        const warning = detail.root?.querySelector(".inline-warning")?.textContent ?? "";
        if (!warning.includes("未能写入录音对应的输入位置") || warning.includes("润色多花的那几秒")) {
          throw new Error(`目标写入失败应保留文字且不编造焦点变化时间，实际："${warning}"`);
        }
      },
    },
    {
      name: "原样注入档：不发生成请求，Host 只出文本，插件把识别原文写回",
      async run({ host }) {
        await pinRawPolish(host, "contract-raw-injection-settings");
        const before = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const commitsBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "识别历史没有写入",
        );
        const after = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        if (after !== before) {
          throw new Error("原样档不该发起任何润色生成");
        }
        // 识别与插入解耦（Host API 1.22）：原样档同样由插件 commit，Host 只出文本。
        const startToggle = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          .at(-2);
        if ((startToggle?.params as { insertText?: boolean } | undefined)?.insertText !== false) {
          throw new Error("原样档也必须让 Host 只出文本（insertText:false）");
        }
        const commits = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.commit")
          .slice(commitsBefore);
        if (commits.length !== 1 || (commits[0]?.params as { text?: string } | undefined)?.text !== "测试语音输入") {
          throw new Error("原样档必须由插件把识别原文写回且只写一次");
        }
      },
    },
    {
      // 2026-09-27 Voice 链路解耦定稿（取代 DEV-16「默认原样」）：出厂默认档是「轻度」，
      // 只作用于语音输入法。configuredVoiceSuite 的首跑引导只选识别方式、不碰润色档位，
      // 落盘的 polish 来自出厂默认；这里验证没有任何润色选择时读到的默认值本身。
      name: "新默认档：未选过润色档位时默认「轻度」，润色后由插件写回润色稿",
      async run({ host }) {
        host.setNextAiTextGenerateText("测试语音输入，已润色。");
        const generateBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        const commitsBefore = host.cloudRequests.filter(
          (request) => request.method === "voice.deliver.commit",
        ).length;
        await host.invokeCommand("com.reai.voice.toggle-input");
        await host.invokeCommand("com.reai.voice.toggle-input");
        await waitUntil(
          () => host.storageKeys().includes("com.reai.voice/voice-state/history"),
          "默认档识别历史没有写入",
        );
        if (host.cloudRequests.filter((request) => request.method === "ai.text.generate").length !== generateBefore + 1) {
          throw new Error("默认「轻度」必须对语音输入法发起一次润色生成");
        }
        const startToggle = host.voiceInputRequests
          .filter((request) => request.method === "voice.toggle")
          .at(-2);
        if ((startToggle?.params as { insertText?: boolean } | undefined)?.insertText !== false) {
          throw new Error("默认档必须让 Host 只出文本（insertText:false），否则会双份注入");
        }
        const commits = host.cloudRequests
          .filter((request) => request.method === "voice.deliver.commit")
          .slice(commitsBefore);
        if (commits.length !== 1 || (commits[0]?.params as { text?: string } | undefined)?.text !== "测试语音输入，已润色。") {
          throw new Error("默认档必须把润色稿写回且只写一次");
        }
        const main = await host.openSurface("main");
        const item = main.root?.querySelector<HTMLButtonElement>(".task-item");
        if (!item?.textContent?.includes("测试语音输入，已润色。")) {
          throw new Error("历史必须呈现写回的润色稿");
        }
        item.click();
        if (!main.root?.querySelector(".detail-original-transcript")?.textContent?.includes("测试语音输入")) {
          throw new Error("润色改动过原文时详情页必须给出原话对照");
        }
      },
    },
    {
      name: "段总结（R11）：「生成总结」经通用 Agent Session 由 Host 默认 Agent 承担，并经 set-summary 交回 Host 持久化；重新总结复用同一会话",
      async run({ host }) {
        const start = new Date();
        start.setHours(14, 3, 0, 0);
        host.setVoiceRecordings([
          {
            id: "seg-1",
            wallStartMs: start.getTime(),
            durationMs: 38 * 60_000,
            transport: "usb_vendor_hid",
            transcriptText: "我们先把发布节奏定下来。\n那就一起出。",
            transcribedAtMs: start.getTime() + 60_000,
            sentences: [
              { text: "我们先把发布节奏定下来。", startMs: 0, endMs: 3_200 },
              { text: "那就一起出。", startMs: 6 * 60_000, endMs: 6 * 60_000 + 1_800 },
            ],
          },
        ]);
        host.setNextAgentSendText("这是测试工作流回复");
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await waitUntil(
          () => root.querySelector('[data-voice-tab="context"]') !== null,
          "Voice 主页没有渲染出 Context 档",
        );
        root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')?.click();
        await waitUntil(() => root.querySelector(".recording-copy") !== null, "Context 档没有列出注入的段");
        root.querySelector<HTMLButtonElement>(".recording-copy")?.click();
        await waitUntil(() => root.querySelector(".ctx-view") !== null, "没有进入段详情页");
        const summaryTab = Array.from(root.querySelectorAll<HTMLButtonElement>(".ctx-tab"))
          .find((tab) => tab.textContent === "总结");
        if (summaryTab?.getAttribute("aria-selected") !== "true") {
          throw new Error("段详情应默认打开总结档");
        }
        Array.from(root.querySelectorAll<HTMLButtonElement>(".ctx-tab"))
          .find((tab) => tab.textContent === "原文")
          ?.click();
        // 主发言只标真实起始秒；展开审计片段保留原始毫秒区间。
        const stamps = Array.from(root.querySelectorAll(".ctx-utterance-line .ctx-line-ts")).map(
          (node) => node.textContent,
        );
        if (stamps.length !== 2 || stamps[0] !== "14:03:00" || stamps[1] !== "14:09:00") {
          throw new Error(`原文栏应按发言标真实起始秒，实际 ${JSON.stringify(stamps)}`);
        }
        const originalRanges = Array.from(root.querySelectorAll(".ctx-fragments .ctx-line-ts")).map(node => node.textContent);
        if (JSON.stringify(originalRanges) !== JSON.stringify(["14:03:00.000～14:03:03.200", "14:09:00.000～14:09:01.800"])) {
          throw new Error(`原始片段应保留真实毫秒区间，实际 ${JSON.stringify(originalRanges)}`);
        }
        if (root.querySelector(".ctx-lines-note")) {
          throw new Error("有句级时间戳时不该再显示「句子之间没有各自的时间戳」脚注");
        }

        summaryTab?.click();
        const agentBefore = host.agentRequests.length;
        const generate = root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
        if (!generate || generate.textContent !== "生成总结") {
          throw new Error("总结栏空态应有真实的「生成总结」入口");
        }
        generate.click();
        await waitUntil(
          () =>
            host.voiceInputRequests.some(
              (request) => request.method === "voice.recordings.set-summary",
            ),
          "段总结完成后没有交回 Host 持久化",
        );
        const agentUsed = host.agentRequests.slice(agentBefore).map((request) => request.method);
        for (const expected of ["agent.v2.backends.list", "agent.v2.session.create", "agent.v2.turn.start"]) {
          if (!agentUsed.includes(expected)) {
            throw new Error(`段总结必须经 ${expected}，实际只走了 ${agentUsed.join(", ")}`);
          }
        }
        const created = host.agentRequests
          .slice(agentBefore)
          .find((request) => request.method === "agent.v2.session.create")?.params as {
            config?: { runtime?: string; memory?: string; tools?: unknown[] };
          } | undefined;
        if (created?.config?.runtime !== "auto" || created.config.memory !== "session") {
          throw new Error("段总结必须在通用 Agent Session 上以 Host 默认 Agent 建持久会话（runtime=auto）");
        }
        if ((created.config.tools?.length ?? -1) !== 0) {
          throw new Error("总结会话不需要读取 Host 工具");
        }
        const firstSend = host.agentRequests
          .slice(agentBefore)
          .find((request) => request.method === "agent.v2.turn.start");
        const firstText = String((firstSend?.params as { text?: unknown } | undefined)?.text ?? "");
        if (!firstText.includes("[14:03:00] 我们先把发布节奏定下来。")) {
          throw new Error("首轮应把逐句带时刻的转写夹在围栏里发给 Agent");
        }
        const saved = host.voiceInputRequests
          .filter((request) => request.method === "voice.recordings.set-summary")
          .at(-1)?.params as {
            recordingId?: string;
            points?: string[];
            dshSessionId?: string;
            basedOnTranscribedAtMs?: number;
          } | undefined;
        if (saved?.recordingId !== "seg-1" || saved.dshSessionId !== "agent2-mock-1") {
          throw new Error("set-summary 必须带上段 id 与生成它的 Agent 会话");
        }
        if (saved.basedOnTranscribedAtMs !== start.getTime() + 60_000) {
          throw new Error("set-summary 必须带上生成时所依据的转写版本，避免迟到总结覆盖新转写");
        }
        if (!Array.isArray(saved.points) || saved.points[0] !== "这是测试工作流回复") {
          throw new Error("交回 Host 的要点应是 Agent 回复解析出的内容");
        }
        await waitUntil(
          () => root.querySelector(".ctx-sum-lb")?.textContent === "AI 总结",
          "总结栏没有渲染 Host 回写后的总结",
        );
        if (host.getVoiceRecordings()[0]?.summary?.points[0] !== "这是测试工作流回复") {
          throw new Error("Mock Host 的录音索引里应已持久化这份总结");
        }

        // 重新总结：复用同一会话，不再 create，只发短追问。
        const createsBefore = host.agentRequests.filter(
          (request) => request.method === "agent.v2.session.create",
        ).length;
        const sendsBefore = host.agentRequests.filter(
          (request) => request.method === "agent.v2.turn.start",
        ).length;
        const regen = root.querySelector<HTMLButtonElement>(
          '.ctx-sum-ft [data-action="summarize-segment"]',
        );
        if (!regen || regen.textContent !== "重新总结") throw new Error("有总结时脚部应有「重新总结」");
        regen.click();
        await waitUntil(
          () =>
            host.agentRequests.filter((request) => request.method === "agent.v2.turn.start").length
            > sendsBefore,
          "重新总结没有再发一轮",
        );
        const regenSend = host.agentRequests
          .filter((request) => request.method === "agent.v2.turn.start")
          .at(-1)?.params as { sessionId?: string; text?: string } | undefined;
        if (regenSend?.sessionId !== "agent2-mock-1") {
          throw new Error("重新总结必须复用生成它的那个会话");
        }
        if ((regenSend.text ?? "").includes("我们先把发布节奏定下来")) {
          throw new Error("重新总结只发短追问，不该重发转写");
        }
        if (
          host.agentRequests.filter((request) => request.method === "agent.v2.session.create").length
          !== createsBefore
        ) {
          throw new Error("重新总结不该新建会话");
        }
      },
    },
    {
      name: "段总结：Dsh 回合失败时保留旧总结、不向 Host 写回，按钮恢复可点",
      async run({ host }) {
        // 先用可用的引擎生成一份，再把引擎「拔掉」看回退，最后看失败不覆盖旧总结。
        const start = new Date();
        start.setHours(9, 48, 0, 0);
        host.setVoiceRecordings([
          {
            id: "seg-2",
            wallStartMs: start.getTime(),
            durationMs: 7 * 60_000,
            transport: "usb_vendor_hid",
            transcriptText: "扩展商城得能试用。",
            transcribedAtMs: start.getTime() + 1_000,
            summary: { points: ["旧总结：商城要能试用"], generatedAtMs: 1, dshSessionId: "dsh-old" },
          },
        ]);
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await waitUntil(
          () => root.querySelector('[data-voice-tab="context"]') !== null,
          "Voice 主页没有渲染出 Context 档",
        );
        root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')?.click();
        await waitUntil(() => root.querySelector(".recording-copy") !== null, "Context 档没有列出注入的段");
        root.querySelector<HTMLButtonElement>(".recording-copy")?.click();
        await waitUntil(() => root.querySelector(".ctx-view") !== null, "没有进入段详情页");
        Array.from(root.querySelectorAll<HTMLButtonElement>(".ctx-tab"))
          .find((tab) => tab.textContent === "总结")
          ?.click();
        if (root.querySelector(".ctx-sum-i")?.textContent !== "旧总结：商城要能试用") {
          throw new Error("已有总结应直接渲染出来");
        }

        // Dsh 回合失败：旧总结原地不动，不写回 Host，错误就地可见。
        const savesBefore = host.voiceInputRequests.filter(
          (request) => request.method === "voice.recordings.set-summary",
        ).length;
        const upstream = "INVALID_REQUEST: 502: Dsh 模型请求含 Host 未放行的字段";
        host.rejectNextAgentSend({ kind: "engine", stderr_tail: upstream });
        root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]')?.click();
        await waitUntil(
          () => root.querySelector(".ctx-view .inline-error") !== null,
          "Dsh 回合失败没有在详情页就地报错",
        );
        if (root.querySelector(".ctx-sum-i")?.textContent !== "旧总结：商城要能试用") {
          throw new Error("总结失败时旧总结必须保留");
        }
        if (
          host.voiceInputRequests.filter((request) => request.method === "voice.recordings.set-summary")
            .length !== savesBefore
        ) {
          throw new Error("总结失败不该向 Host 写回任何东西");
        }
        if (host.getVoiceRecordings()[0]?.summary?.points[0] !== "旧总结：商城要能试用") {
          throw new Error("Host 侧的旧总结也必须原样保留");
        }
        const visibleError = root.querySelector(".ctx-view .inline-error")?.textContent ?? "";
        if (visibleError !== "暂时无法生成总结。原始记录已保存，请稍后重试。") {
          throw new Error(`总结失败没有告诉用户原始记录已保存和下一步：${visibleError}`);
        }
        if (["INVALID_REQUEST", "502", "Dsh", "Host"].some((text) => visibleError.includes(text))) {
          throw new Error(`总结失败页面泄露了内部错误：${visibleError}`);
        }
        const busy = root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
        if (!busy || busy.disabled) {
          throw new Error("失败后按钮应恢复可点，不能卡在「总结中…」");
        }
      },
    },
    {
      name: "段总结：Agent 不可用时回退云端一次性生成，结果不带会话并在界面说明来路",
      async run({ host }) {
        // 这个场景用「没有任何 Agent 可用」的 Host（runtime 恒 auto，任一后端可用都会走会话）：
        // 回退云端一次性生成，不创建会话。
        const start = new Date();
        start.setHours(11, 20, 0, 0);
        host.setVoiceRecordings([
          {
            id: "seg-3",
            wallStartMs: start.getTime(),
            durationMs: 12 * 60_000,
            transport: "usb_vendor_hid",
            transcriptText: "那个开关默认关掉吧。",
            transcribedAtMs: start.getTime() + 1_000,
          },
        ]);
        host.setAgentDshStatus({
          available: false,
          detail: "未设置 REAI_DSH_ROOT（测试注入）",
        });
        host.setAgentPiStatus({
          available: false,
          detail: "download_required: com.reai.runtime.pi（测试注入）",
          downloadRequired: true,
        });
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await waitUntil(
          () => root.querySelector('[data-voice-tab="context"]') !== null,
          "Voice 主页没有渲染出 Context 档",
        );
        root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')?.click();
        await waitUntil(() => root.querySelector(".recording-copy") !== null, "Context 档没有列出注入的段");
        root.querySelector<HTMLButtonElement>(".recording-copy")?.click();
        await waitUntil(() => root.querySelector(".ctx-view") !== null, "没有进入段详情页");
        Array.from(root.querySelectorAll<HTMLButtonElement>(".ctx-tab"))
          .find((tab) => tab.textContent === "总结")
          ?.click();
        const generatesBefore = host.cloudRequests.filter(
          (request) => request.method === "ai.text.generate",
        ).length;
        root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]')?.click();
        await waitUntil(
          () =>
            host.voiceInputRequests.some(
              (request) => request.method === "voice.recordings.set-summary",
            ),
          "云端回退生成后没有交回 Host 持久化",
        );
        if (
          host.cloudRequests.filter((request) => request.method === "ai.text.generate").length
          !== generatesBefore + 1
        ) {
          throw new Error("引擎不可用时应恰好发起一次云端文本生成");
        }
        if (host.agentRequests.some((request) => request.method === "agent.v2.turn.start")) {
          throw new Error("引擎不可用时不该尝试 Dsh 会话");
        }
        const saved = host.voiceInputRequests
          .filter((request) => request.method === "voice.recordings.set-summary")
          .at(-1)?.params as { dshSessionId?: unknown } | undefined;
        if (saved && "dshSessionId" in saved && saved.dshSessionId) {
          throw new Error("云端回退生成的总结不该带 Dsh 会话 id");
        }
        await waitUntil(
          () => root.querySelector(".ctx-sum-src")?.textContent?.includes("由云端模型直接生成") === true,
          "云端回退的总结没有在溯源行说明来路",
        );
      },
    },
  ],
});
