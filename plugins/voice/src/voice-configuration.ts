import type { VoiceInputSettings } from "@reai/app-sdk/v1";

/**
 * 合并一次设置修改。显式选档（patch 自带 `audioSourcePreference`）原样保留；
 * 旧式的 source 切换会清掉残留档位；在「只用电脑麦」里换具体设备仍属于这一档。
 */
export function withExplicitVoiceSource(previous: VoiceInputSettings, patch: Partial<VoiceInputSettings>): VoiceInputSettings {
  const settings = { ...previous, ...patch };
  if (patch.audioSourcePreference !== undefined) return settings;
  const endpointWithinComputerOnly = patch.source === undefined
    && patch.systemEndpointId !== undefined
    && previous.audioSourcePreference?.kind === "computer_only";
  if ((patch.source !== undefined || patch.systemEndpointId !== undefined) && !endpointWithinComputerOnly) {
    delete settings.audioSourcePreference;
  }
  return settings;
}

/**
 * 准备性 configure 的负载：去掉档位、带上 preserve，Host 保留自己已持久的音源策略
 * （prepare 不重复覆盖 Host 全局策略）。旧来源迁移的那一次例外，交给 Host 判定。
 */
export function preparedVoiceSettings(settings: VoiceInputSettings): VoiceInputSettings {
  if (settings.legacySourceMigration) return settings;
  const { audioSourcePreference: _mode, ...rest } = settings;
  return { ...rest, preserveAudioSourcePreference: true };
}

/** Activation-local successful configuration, never a claim about current Host global policy. */
export function createVoiceConfiguration(configure: (settings: VoiceInputSettings) => Promise<void>) {
  let applied: string | undefined;
  let generation = 0;
  const apply = async (settings: VoiceInputSettings, explicit: boolean, writeSource: boolean) => {
    const snapshot = structuredClone(writeSource ? settings : preparedVoiceSettings(settings));
    // 指纹只看业务设置：档位字段与 preserve 标记不改变 Host 的识别/语言配置。
    const { audioSourcePreference: _mode, preserveAudioSourcePreference: _preserve, ...business } = snapshot;
    // Property insertion order is not meaningful to the settings contract.
    const fingerprint = JSON.stringify(business, Object.keys(business).sort().concat(["window", "recentVoice", "recentVoiceRangeMinutes", "kind"]));
    if (!explicit && applied === fingerprint) return;
    const current = ++generation;
    // Existing settings saves are serialized by the app. A hung preparation must
    // not retain that lock after its deadline or block a fresh recording attempt.
    await configure(snapshot);
    if (current === generation) applied = fingerprint;
  };
  return {
    /** 激活 / 录音前的准备：不写音源档位。 */
    prepare: (settings: VoiceInputSettings) => apply(settings, false, false),
    /**
     * 用户显式保存。`writeSource: false` 用于与音源无关的修改（语言、引擎……），
     * 同样不碰 Host 的音源档位；迁移与回滚沿用默认 true。
     */
    apply: (settings: VoiceInputSettings, options: { writeSource?: boolean } = {}) =>
      apply(settings, true, options.writeSource ?? true),
  };
}
