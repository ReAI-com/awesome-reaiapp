import { describe, expect, test } from "bun:test";
import type { VoiceAudioSourcesInfo } from "@reai/app-sdk/v1";
import { DEFAULT_SETTINGS } from "../src/data";
import {
  AUDIO_SOURCE_MODES,
  audioSourceModeDisabledReason,
  audioSourceModePatch,
  currentAudioSourceMode,
  noMicrophoneAvailable,
  shouldOfferComputerMicrophoneGrant,
} from "../src/voice-audio-source";

const info = (patch: Partial<VoiceAudioSourcesInfo> = {}): VoiceAudioSourcesInfo => ({
  mode: "auto", hardware: "available", computer: "available", resolved: "board", ...patch,
});

describe("录音来源五档", () => {
  test("顺序固定：自动在最前（默认）", () => {
    expect(AUDIO_SOURCE_MODES).toEqual(["auto", "prefer_board", "prefer_computer", "board_only", "computer_only"]);
  });

  test("当前档位以 Host 真值为准；旧 Host 退回本地设置与旧 source", () => {
    expect(currentAudioSourceMode(DEFAULT_SETTINGS, { audioSources: info({ mode: "board_only" }) })).toBe("board_only");
    expect(currentAudioSourceMode({ ...DEFAULT_SETTINGS, audioSourcePreference: { kind: "prefer_computer" } }, {})).toBe("prefer_computer");
    expect(currentAudioSourceMode({ ...DEFAULT_SETTINGS, source: "system" }, {})).toBe("computer_only");
    expect(currentAudioSourceMode(DEFAULT_SETTINGS, {})).toBe("auto");
    // 旧 UAC 兼容态不属于五档：归位到「自动」显示，不报错。
    expect(currentAudioSourceMode(DEFAULT_SETTINGS, { audioSources: info({ mode: "legacy_board_uac" }) })).toBe("auto");
  });

  test("没有某类麦时只禁对应的「只用」档；两类都没有则全部禁用", () => {
    const noBoard = info({ hardware: "disconnected" });
    expect(AUDIO_SOURCE_MODES.map(mode => audioSourceModeDisabledReason(mode, noBoard)))
      .toEqual([undefined, undefined, undefined, "no_hardware", undefined]);
    const noComputer = info({ computer: "missing" });
    expect(AUDIO_SOURCE_MODES.map(mode => audioSourceModeDisabledReason(mode, noComputer)))
      .toEqual([undefined, undefined, undefined, undefined, "no_computer"]);
    const none = info({ hardware: "disconnected", computer: "missing", resolved: "unavailable" });
    expect(AUDIO_SOURCE_MODES.map(mode => audioSourceModeDisabledReason(mode, none)))
      .toEqual(Array(5).fill("no_microphone"));
    expect(noMicrophoneAvailable(none)).toBe(true);
    // 固件过旧 / 正在检查 / 电脑麦未授权都不是「没有」：可以选。
    for (const partial of [{ hardware: "firmware_too_old" }, { hardware: "checking" }, { computer: "permission_required" }] as const) {
      expect(AUDIO_SOURCE_MODES.every(mode => audioSourceModeDisabledReason(mode, info(partial)) === undefined)).toBe(true);
    }
    // 旧 Host 没有事实：只有它表达不了的「只用硬件麦」提示升级，其余可选。
    expect(AUDIO_SOURCE_MODES.map(mode => audioSourceModeDisabledReason(mode, undefined)))
      .toEqual([undefined, undefined, undefined, "host_upgrade", undefined]);
  });

  test("授权引导只在当前档位可能用到未授权的电脑麦时出现", () => {
    const ungranted = info({ computer: "permission_required" });
    expect(shouldOfferComputerMicrophoneGrant("prefer_computer", ungranted)).toBe(true);
    expect(shouldOfferComputerMicrophoneGrant("computer_only", ungranted)).toBe(true);
    expect(shouldOfferComputerMicrophoneGrant("board_only", ungranted)).toBe(false);
    // 自动 / 硬件优先：键盘能用时不打扰，键盘不可用才引导。
    expect(shouldOfferComputerMicrophoneGrant("auto", ungranted)).toBe(false);
    expect(shouldOfferComputerMicrophoneGrant("prefer_board", ungranted)).toBe(false);
    expect(shouldOfferComputerMicrophoneGrant("auto", { ...ungranted, hardware: "disconnected" })).toBe(true);
    expect(shouldOfferComputerMicrophoneGrant("computer_only", info())).toBe(false);
    expect(shouldOfferComputerMicrophoneGrant("computer_only", info({ computer: "missing" }))).toBe(false);
  });

  test("旧 Host 只收它认识的 kind：自动发等价的 prefer_board，只用电脑麦改用旧 source", () => {
    expect(audioSourceModePatch("auto", false)).toEqual({ audioSourcePreference: { kind: "prefer_board" }, source: "board" });
    expect(audioSourceModePatch("computer_only", false)).toEqual({ source: "system" });
    expect(audioSourceModePatch("prefer_board", false)).toEqual({ audioSourcePreference: { kind: "prefer_board" }, source: "board" });
    expect(audioSourceModePatch("prefer_computer", false)).toEqual({ audioSourcePreference: { kind: "prefer_computer" }, source: "board" });
  });

  test("选档补丁同时写档位与兼容旧 Host 的 source", () => {
    expect(audioSourceModePatch("computer_only")).toEqual({ audioSourcePreference: { kind: "computer_only" }, source: "system" });
    for (const mode of ["auto", "prefer_board", "prefer_computer", "board_only"] as const) {
      expect(audioSourceModePatch(mode)).toEqual({ audioSourcePreference: { kind: mode }, source: "board" });
    }
  });
});
