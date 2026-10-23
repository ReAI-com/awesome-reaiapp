/**
 * Host 1.0.6 新增的 Voice 合同字段。本仓锁定的 SDK 包早于这些合同，
 * 先在插件侧补上可选字段；换到带这些字段的 SDK 包后删掉本文件即可。
 *
 * 运行时由 Host 注入（构建时 `@reai/app-sdk/v1` 是 external），新字段能否送达只取决于
 * 当前 Host；旧 Host 忽略这些字段。
 */
import type { VoiceInputResult } from "@reai/app-sdk/v1";

export {};

declare module "@reai/app-sdk/v1" {
  interface VoiceInputSettings {
    /** 单次录音最长时间（分钟，整数 1–10，缺省 10）。旧 Host 忽略，固定 120 秒。 */
    maxRecordingMinutes?: number;
  }
  interface VoiceInputStatus {
    /** 下一次录音的单次上限（秒）。旧 Host 不返回。 */
    captureLimitSeconds?: number;
    /**
     * 按键会话切片口径（2026-10-23）：`"span-markers-v1"` 表示 Host 切片已带完整原始回看并按
     * VAD 向外找气口，与片段增强同一窗口，插件不再做第二次识别。旧 Host 不返回。
     */
    captureModel?: string;
    /** `getStatus(sessionId, { waitMs })` 到点时该 `asyncFinish` 会话仍在收尾。旧 Host 不返回。 */
    pending?: boolean;
  }
  interface VoiceInputResult {
    /** `phase: "listening"` 时返回本次录音的单次上限（秒）。旧 Host 不返回。 */
    captureLimitSeconds?: number;
    /** `phase: "finalizing"` 时返回：录音结束先后的序号，写回按它排队。 */
    seq?: number;
  }
  interface VoiceInputStartOptions {
    /**
     * 结束即返回（2026-10-23，胶囊叠放）：这段的结束立刻回 `phase: "finalizing"`，收尾在 Host
     * 后台，终稿用 `getStatus(sessionId, { waitMs })` 取回、`acknowledgeResult` 消费。旧 Host 忽略。
     */
    asyncFinish?: boolean;
  }
  interface VoiceInputClient {
    /** `waitMs`（≤ 20000）只对 `asyncFinish` 会话生效；旧 Host 忽略，立即返回普通状态。 */
    getStatus(sessionId?: string, options?: { waitMs?: number }): Promise<VoiceInputStatus>;
  }
  interface VoiceTaskSnapshot {
    /** 这件任务来自哪段 `asyncFinish` 录音：Host 按会话认中央那一枚胶囊。旧 Host 忽略。 */
    voiceSessionId?: string;
  }
}

/**
 * `asyncFinish` 会话结束录音后的回执（锁定 SDK 的 `phase` 联合里还没有 `"finalizing"`）。
 */
export function isFinalizingResult(result: Pick<VoiceInputResult, "phase">): boolean {
  return (result.phase as string) === "finalizing";
}

/** 命令段的非 `deferred` 前台呈现被 Host 要求转后台（有新录音或前台面板被占）。 */
export const VOICE_ANSWER_DEFER_REQUIRED = "VOICE_ANSWER_DEFER_REQUIRED";
