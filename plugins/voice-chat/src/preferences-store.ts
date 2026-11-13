export interface PrivateSettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}
import type {
  AgentMemoryMode,
  AgentRuntimeChoice,
  BrainMode,
  ExternalBrainTier,
  Os1Mood,
  SttLanguageChoice,
  SttProviderChoice,
  TtsProviderChoice,
  VoiceChatSettings,
  WainaoTtsModel,
} from "./types";

const STORAGE_KEY = "settings.v1";

export const DEFAULT_VOICE_SYSTEM_PROMPT =
  "你是一个温和、敏锐、自然的实时语音对话伙伴。请直接用简短口语化的中文交流，每次回复尽量控制在一到三句话内，第一小句简短并带逗号以便即时语音播报。严禁输出任何 Markdown 格式符号（不要星号、井号、列表、代码块或表情符号），数字与单位用自然口语表达。";

export const DEFAULT_VOICE_CHAT_SETTINGS: VoiceChatSettings = {
  schemaVersion: 1,
  brain: {
    mode: "agent-service",
    agentRuntime: "auto",
    agentMemory: "session",
    fillerOnToolCall: true,
    externalBrainTier: "text-default",
    customBaseUrl: "https://api.deepseek.com/v1",
    customModel: "deepseek-flash",
    customApiKey: "",
    disableThinking: true,
    systemPrompt: DEFAULT_VOICE_SYSTEM_PROMPT,
  },
  stt: {
    provider: "voice-plugin",
    language: "auto",
    localBridgeUrl: "http://127.0.0.1:7860",
  },
  tts: {
    provider: "system-speech",
    wainaoModel: "CosyVoice2",
    wainaoProjectId: "",
    endpointUrl: "http://127.0.0.1:8080/v1/audio/speech",
    modelId: "s2.1-pro",
    voiceId: "",
    apiKey: "",
    speed: 1.0,
    clauseStreaming: true,
  },
  experience: {
    mood: "os1-auto",
    autoContinueListening: true,
    bargeInEnabled: true,
    showSubtitles: false,
  },
};

function oneOf<T extends string>(val: unknown, allowed: readonly T[], fallback: T): T {
  return typeof val === "string" && (allowed as readonly string[]).includes(val) ? (val as T) : fallback;
}

function cleanText(val: unknown, fallback: string, maxLen = 4000): string {
  if (typeof val !== "string") return fallback;
  return val.slice(0, maxLen);
}

function cleanSpeed(val: unknown, fallback: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  return Math.round(Math.min(1.3, Math.max(0.8, val)) * 100) / 100;
}

export function normalizeVoiceChatSettings(raw: unknown): VoiceChatSettings {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const b = typeof src.brain === "object" && src.brain !== null ? (src.brain as Record<string, unknown>) : {};
  const s = typeof src.stt === "object" && src.stt !== null ? (src.stt as Record<string, unknown>) : {};
  const t = typeof src.tts === "object" && src.tts !== null ? (src.tts as Record<string, unknown>) : {};
  const e = typeof src.experience === "object" && src.experience !== null ? (src.experience as Record<string, unknown>) : {};

  const d = DEFAULT_VOICE_CHAT_SETTINGS;
  const promptText = cleanText(b.systemPrompt, d.brain.systemPrompt, 4000).trim();

  return {
    schemaVersion: 1,
    brain: {
      mode: oneOf<BrainMode>(b.mode, ["agent-service", "external-brain", "custom-openai"], d.brain.mode),
      agentRuntime: oneOf<AgentRuntimeChoice>(b.agentRuntime, ["auto", "pi", "dsh", "codex"], d.brain.agentRuntime),
      agentMemory: oneOf<AgentMemoryMode>(b.agentMemory, ["session", "one-shot"], d.brain.agentMemory),
      fillerOnToolCall: typeof b.fillerOnToolCall === "boolean" ? b.fillerOnToolCall : d.brain.fillerOnToolCall,
      externalBrainTier: oneOf<ExternalBrainTier>(
        b.externalBrainTier,
        ["text-default", "text-quality"],
        d.brain.externalBrainTier,
      ),
      customBaseUrl: cleanText(b.customBaseUrl, d.brain.customBaseUrl, 512).trim() || d.brain.customBaseUrl,
      customModel: cleanText(b.customModel, d.brain.customModel, 128).trim() || d.brain.customModel,
      customApiKey: cleanText(b.customApiKey, "", 512).trim(),
      disableThinking: typeof b.disableThinking === "boolean" ? b.disableThinking : d.brain.disableThinking,
      systemPrompt: promptText || d.brain.systemPrompt,
    },
    stt: {
      provider: oneOf<SttProviderChoice>(
        s.provider,
        ["voice-plugin", "host-sensevoice", "local-bridge"],
        d.stt.provider,
      ),
      language: oneOf<SttLanguageChoice>(s.language, ["auto", "zh", "en"], d.stt.language),
      localBridgeUrl: cleanText(s.localBridgeUrl, d.stt.localBridgeUrl, 512).trim() || d.stt.localBridgeUrl,
    },
    tts: {
      provider: oneOf<TtsProviderChoice>(
        t.provider,
        ["system-speech", "wainao-gateway", "fish-audio", "minimax", "openai-compatible"],
        d.tts.provider,
      ),
      wainaoModel: oneOf<WainaoTtsModel>(
        t.wainaoModel,
        ["CosyVoice2", "qwen3-tts-flash", "step-tts-mini", "qwen-audio-3.0-tts-flash"],
        d.tts.wainaoModel,
      ),
      wainaoProjectId: cleanText(t.wainaoProjectId, "", 128).trim(),
      endpointUrl: cleanText(t.endpointUrl, d.tts.endpointUrl, 512).trim() || d.tts.endpointUrl,
      modelId: cleanText(t.modelId, d.tts.modelId, 128).trim() || d.tts.modelId,
      voiceId: cleanText(t.voiceId, "", 128).trim(),
      apiKey: cleanText(t.apiKey, "", 512).trim(),
      speed: cleanSpeed(t.speed, d.tts.speed),
      clauseStreaming: typeof t.clauseStreaming === "boolean" ? t.clauseStreaming : d.tts.clauseStreaming,
    },
    experience: {
      mood: oneOf<Os1Mood>(e.mood, ["os1-auto", "os1-crimson", "host"], d.experience.mood),
      autoContinueListening:
        typeof e.autoContinueListening === "boolean" ? e.autoContinueListening : d.experience.autoContinueListening,
      bargeInEnabled: typeof e.bargeInEnabled === "boolean" ? e.bargeInEnabled : d.experience.bargeInEnabled,
      showSubtitles: typeof e.showSubtitles === "boolean" ? e.showSubtitles : d.experience.showSubtitles,
    },
  };
}

const cloneSettings = (val: VoiceChatSettings): VoiceChatSettings =>
  JSON.parse(JSON.stringify(val)) as VoiceChatSettings;

export class VoiceChatPreferencesStore {
  private current: VoiceChatSettings = cloneSettings(DEFAULT_VOICE_CHAT_SETTINGS);
  private readonly listeners = new Set<(settings: VoiceChatSettings) => void>();

  constructor(private readonly kv?: PrivateSettingsStore) {}

  get value(): VoiceChatSettings {
    return this.current;
  }

  async load(): Promise<VoiceChatSettings> {
    if (!this.kv) return this.current;
    const stored = await this.kv.get<unknown>(STORAGE_KEY);
    if (stored !== undefined && stored !== null) {
      this.current = normalizeVoiceChatSettings(stored);
      this.emit();
    }
    return this.current;
  }

  async save(next: VoiceChatSettings): Promise<VoiceChatSettings> {
    const normalized = normalizeVoiceChatSettings(next);
    if (this.kv) {
      await this.kv.set(STORAGE_KEY, normalized);
    }
    this.current = normalized;
    this.emit();
    return normalized;
  }

  async reset(): Promise<VoiceChatSettings> {
    return this.save(cloneSettings(DEFAULT_VOICE_CHAT_SETTINGS));
  }

  subscribe(listener: (settings: VoiceChatSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.current);
    }
  }
}
