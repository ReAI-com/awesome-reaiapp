import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codexTitlebarPresetFrom, PendingPresetState } from "../src/app";
import manifest from "../app.manifest.json";

const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

describe("Codex Link 0.5 Manifest", () => {
  // 这条守的是「声明的都得真有实现」，不是「一个命令都不许有」。
  // 审批（approve / deny）已在 app.ts 里注册，所以 manifest 声明它们是对的；
  // 但清单必须逐个列全——将来谁再加一条声明，这里会红，逼他先确认实现真的存在。
  // 实现侧不归这条管：Host 在 activate 时会核对声明与实际注册（对不上当场回滚），
  // 那边自有测试。这里守的是清单快照本身——多一条、少一条、改名、换序都会红。
  test("控制命令清单与 hostCapabilities 快照", () => {
    expect(manifest.contributes.commands.map((c) => c.id)).toEqual([
      "com.reai.codex-link.new-task",
      "com.reai.codex-link.approve",
      "com.reai.codex-link.deny",
    ]);
    // 「新建任务」是硬件键的目标，不该出现在用户的 Action 菜单里，所以 callers 只给 host。
    const newTask = manifest.contributes.commands.find(
      (c) => c.id === "com.reai.codex-link.new-task",
    )!;
    expect(newTask.callers).toEqual(["host"]);
    // 入参白名单 = Host `static_input` 收得下的那四项。**没有「模式」字段**：
    // Codex 协议没有切换会话审批模式的方法，建 thread / 起 turn 的窄口也不收它。
    expect(Object.keys(newTask.inputSchema.properties ?? {})).toEqual([
      "model",
      "effort",
      "skillName",
      "promptPrefix",
    ]);
    expect(newTask.inputSchema.additionalProperties).toBe(false);
    // 上面那条恒等断言就是「没有模式字段」的守卫：多一个 mode 会当场红。
    // 不用子串检查——"mode" 是 "model" 的前缀，那样写永远误报。
    expect(manifest.contributes.intents).toEqual([]);
    // 声明了命令就必须要 commands@1，否则宿主不会给注册通道。
    expect(manifest.requires.hostCapabilities).toContain("commands@1");
    expect(manifest.requires.hostCapabilities).toContain("agent.codex@1");
    expect(manifest.requires.hostCapabilities).toContain("storage.kv@1");
    // activation=startup 的插件必须同时声明 activation.startup@1（矩阵 grantGatedNote
    // 的合同要求，voice-app 同姿势）；靠 seed 特判放行的隐式写法不给第三方示范。
    expect(manifest.requires.hostCapabilities).toContain("activation.startup@1");
    // 新任务表单的「选文件夹…」：Host 弹系统面板，只回用户亲手挑的那一个绝对路径。
    expect(manifest.requires.hostCapabilities).toContain("system.folder-pick@1");
    expect(manifest.data.privateStores).toEqual([{ id: "thread-state", schemaVersion: 1 }]);
    expect(manifest.dataCompatibility.rollbackFloor).toBe("0.2.0");
    expect(manifest.version).toBe("0.5.13");
    // 开放平台身份（2026-09-26 建品）：publisherId 是 Team ID、oauthAppId 是产品的公开
    // OAuth Client ID，与 submission.identity.json 逐字一致；Product ID 不进 Manifest。
    expect(manifest.publisherId).toBe("4d8a4ddb-2293-4b11-9ef4-3f24f117998c");
    expect(manifest.oauthAppId).toBe("MWlGsyT9YXxuQ5IkVaIQxBscQaFfCc3b");
    // Host 已放开 Windows 会话能力后，安装目标含 macOS aarch64 + Windows（aarch64 / x86_64）。
    expect(manifest.targets).toEqual([
      { platform: "macos", architectures: ["aarch64"] },
      { platform: "windows", architectures: ["aarch64", "x86_64"] },
    ]);
    // 0.5.11 送审被服务端拒绝：平台 Manifest 合同基线 1.1@c3475cb 的 i18n target 枚举
    // 不含 storeListing.*（v2 目标）。送审包与 Voice / Browser 同姿势：metadata.i18n@1 +
    // 仅 v1 目标；商店展示文案由提交表单填写，不再走 i18n 引用。
    expect(manifest.requires.hostCapabilities).toContain("metadata.i18n@1");
    expect(manifest.requires.hostCapabilities).not.toContain("metadata.i18n@2");
    expect(manifest.i18n.messages.some((message) => message.target.startsWith("storeListing."))).toBe(false);
    // B9-11（设计稿 t10 / EXT_PHASE1）：「第一期就有的三件事」承诺段是给大客户
    // 的验收标尺，文案逐字住在 manifest——宿主抽屉只读不写。三条逐字钉死，
    // 改一条都算改承诺。
    expect(manifest.storeListing?.phaseOneCommitments).toEqual([
      "把 Skill 变成 Action 层的快捷方式：挂上去，按 Action 键直接使",
      "快速创建对话：结合拨杆，一步开一个新任务",
      "交互提醒：Codex 里有对话在等你时，进 Tab 层，一按就跳过去处理",
    ]);
  });

  test("只把 Host 新任务标题栏信封转换成空预设", () => {
    expect(codexTitlebarPresetFrom({
      source: "host.titlebarAction",
      actionId: "new-task",
      deliveryId: "titlebar-test",
      payload: { type: "new-task" },
    })).toEqual({});
    expect(codexTitlebarPresetFrom({
      source: "host.titlebarAction",
      actionId: "unknown",
      payload: { type: "new-task" },
    })).toBeUndefined();
  });
});

describe("冷启动预设代次", () => {
  test("surface 初始化失败后不再重放这次待铺预设", () => {
    const pending = new PendingPresetState();
    pending.stage({ promptPrefix: "failed command" }, 1_000);
    const failedSurfaceGeneration = pending.currentGeneration();

    pending.discard(failedSurfaceGeneration);

    expect(pending.takeFresh(1_001, 30_000)).toBeUndefined();
    expect(appSource).toContain(
      "const pendingGenerationAtStart = pendingPresets.currentGeneration()",
    );
    expect(appSource).toContain("pendingPresets.discard(pendingGenerationAtStart)");
  });

  test("旧 surface 的失败不能误清失败期间到达的新命令", () => {
    const pending = new PendingPresetState();
    pending.stage({ promptPrefix: "old command" }, 1_000);
    const failedSurfaceGeneration = pending.currentGeneration();
    pending.stage({ promptPrefix: "new command" }, 1_001);

    pending.discard(failedSurfaceGeneration);

    expect(pending.takeFresh(1_002, 30_000)).toEqual({ promptPrefix: "new command" });
  });
});
