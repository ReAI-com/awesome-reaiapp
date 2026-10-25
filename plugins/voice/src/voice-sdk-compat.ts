/**
 * Voice 侧对 SDK 的两处小补充。平台包 v107.2（Host API 1.29）已自带 Host 1.0.6 以来的 Voice 合同字段
 * （maxRecordingMinutes / captureLimitSeconds / captureModel / pending / seq / asyncFinish / waitMs /
 * voiceSessionId），原先在这里补的模块声明已删；这里只剩运行时常量与「finalizing」回执判定。
 */
import type { VoiceInputResult } from "@reai/app-sdk/v1";


/**
 * `asyncFinish` 会话结束录音后的回执（锁定 SDK 的 `phase` 联合里还没有 `"finalizing"`）。
 */
export function isFinalizingResult(result: Pick<VoiceInputResult, "phase">): boolean {
  return (result.phase as string) === "finalizing";
}

/** 命令段的非 `deferred` 前台呈现被 Host 要求转后台（有新录音或前台面板被占）。 */
export const VOICE_ANSWER_DEFER_REQUIRED = "VOICE_ANSWER_DEFER_REQUIRED";
