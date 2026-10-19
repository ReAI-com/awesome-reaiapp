import type {
  VoiceAudioSourceMode,
  VoiceAudioSourcesInfo,
  VoiceInputSettings,
  VoicePermissionInfo,
} from "@reai/app-sdk/v1";

/**
 * 录音来源五档（2026-10-11 拍板）。Host 是唯一的策略持有者：插件只在用户显式选档时
 * 经 `voice.configure.audioSourcePreference` 写入，平时从 `checkPermissions().audioSources`
 * 读 Host 真值，不自造第二份全局策略。
 */
export const AUDIO_SOURCE_MODES: readonly VoiceAudioSourceMode[] = [
  "auto",
  "prefer_board",
  "prefer_computer",
  "board_only",
  "computer_only",
];

export function isAudioSourceMode(value: unknown): value is VoiceAudioSourceMode {
  return typeof value === "string" && (AUDIO_SOURCE_MODES as readonly string[]).includes(value);
}

/** 当前档位：Host 真值优先；旧 Host 没有 audioSources 时退回本地设置。UAC 兼容态按「自动」归位显示。 */
export function currentAudioSourceMode(
  settings: Pick<VoiceInputSettings, "source" | "audioSourcePreference">,
  permissions: Pick<VoicePermissionInfo, "audioSources">,
): VoiceAudioSourceMode {
  const host = permissions.audioSources?.mode;
  if (isAudioSourceMode(host)) return host;
  if (host === "legacy_board_uac") return "auto";
  const local = settings.audioSourcePreference?.kind;
  if (isAudioSourceMode(local)) return local;
  return settings.source === "system" ? "computer_only" : "auto";
}

/** 当前 Host 是不是还在旧 USB Audio 兼容态（不属于五档，界面需要单独说明）。 */
export function isLegacyCompatibilityMode(permissions: Pick<VoicePermissionInfo, "audioSources">): boolean {
  return permissions.audioSources?.mode === "legacy_board_uac";
}

export type AudioSourceDisabledReason = "no_hardware" | "no_computer" | "no_microphone" | "host_upgrade";

/** Host 是否认识五档（新 Host 在 checkPermissions 里返回 audioSources）。 */
export function hostSupportsFiveModes(permissions: Pick<VoicePermissionInfo, "audioSources">): boolean {
  return permissions.audioSources !== undefined;
}

/**
 * 某一档能不能选。只看「这台机器上有没有这类麦」：
 * - 没接键盘 → 只用硬件麦不可选；
 * - 电脑没有输入设备 → 只用电脑麦不可选；
 * - 两类都没有 → 全部不可选（语音不可用）。
 * 电脑麦未授权不算「没有」：可以选，界面给授权引导。
 * 旧 Host 没有事实：只有「只用硬件麦」无法表达（旧 Host 只认两档自动策略与旧 source），提示升级。
 */
export function audioSourceModeDisabledReason(
  mode: VoiceAudioSourceMode,
  info: VoiceAudioSourcesInfo | undefined,
): AudioSourceDisabledReason | undefined {
  if (!info) return mode === "board_only" ? "host_upgrade" : undefined;
  const noHardware = info.hardware === "disconnected";
  const noComputer = info.computer === "missing";
  if (noHardware && noComputer) return "no_microphone";
  if (mode === "board_only" && noHardware) return "no_hardware";
  if (mode === "computer_only" && noComputer) return "no_computer";
  return undefined;
}

/** 两类麦都没有：语音输入不可用（明确状态，不是静默失败）。 */
export function noMicrophoneAvailable(info: VoiceAudioSourcesInfo | undefined): boolean {
  return info?.hardware === "disconnected" && info.computer === "missing";
}

/**
 * 是否显示「授权电脑麦克风」引导：电脑麦在场但未授权，且当前档位此刻可能用到它
 * （电脑优先 / 只用电脑麦；或自动 / 硬件优先而硬件麦此刻不能用）。只用硬件麦永远不引导。
 */
export function shouldOfferComputerMicrophoneGrant(
  mode: VoiceAudioSourceMode,
  info: VoiceAudioSourcesInfo | undefined,
): boolean {
  if (!info || info.computer !== "permission_required") return false;
  if (mode === "prefer_computer" || mode === "computer_only") return true;
  if (mode === "auto" || mode === "prefer_board") return info.hardware !== "available";
  return false;
}

/**
 * 用户选某一档时写给 Host 的设置补丁；旧 `source` 同步写。
 * 旧 Host（没有 audioSources）只认 `prefer_board` / `prefer_computer` 两个 kind：
 * 「自动」按已拍板的「自动 = 硬件优先」发 `prefer_board`（旧 Host 上会显示为硬件优先，两者等价）；
 * 「只用电脑麦」改用旧 `source: "system"` 表达；不发旧 Host 不认识的 kind。
 */
export function audioSourceModePatch(mode: VoiceAudioSourceMode, fiveModeHost = true): Partial<VoiceInputSettings> {
  const source = mode === "computer_only" ? "system" : "board";
  if (!fiveModeHost && mode === "computer_only") return { source };
  if (!fiveModeHost && mode === "auto") return { audioSourcePreference: { kind: "prefer_board" }, source };
  return { audioSourcePreference: { kind: mode }, source };
}
