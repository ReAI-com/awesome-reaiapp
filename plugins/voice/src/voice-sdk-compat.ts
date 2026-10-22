/**
 * Host 1.0.6「单次录音最长时间」合同字段。本仓锁定的 SDK 包早于该合同，
 * 先在插件侧补上可选字段；换到带这些字段的 SDK 包后删掉本文件即可。
 */
export {};

declare module "@reai/app-sdk/v1" {
  interface VoiceInputSettings {
    /** 单次录音最长时间（分钟，整数 1–10，缺省 10）。旧 Host 忽略，固定 120 秒。 */
    maxRecordingMinutes?: number;
  }
  interface VoiceInputStatus {
    /** 下一次录音的单次上限（秒）。旧 Host 不返回。 */
    captureLimitSeconds?: number;
  }
  interface VoiceInputResult {
    /** `phase: "listening"` 时返回本次录音的单次上限（秒）。旧 Host 不返回。 */
    captureLimitSeconds?: number;
  }
}
