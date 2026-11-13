export type BrainMode = "agent-service" | "external-brain" | "custom-openai";
export type AgentRuntimeChoice = "auto" | "pi" | "dsh" | "codex";
export type AgentMemoryMode = "session" | "one-shot";
export type ExternalBrainTier = "text-default" | "text-quality";

export type SttProviderChoice = "voice-plugin" | "host-sensevoice" | "local-bridge";
export type SttLanguageChoice = "auto" | "zh" | "en";

export type TtsProviderChoice =
  | "system-speech"
  | "wainao-gateway"
  | "fish-audio"
  | "minimax"
  | "openai-compatible";

export type WainaoTtsModel =
  | "CosyVoice2"
  | "qwen3-tts-flash"
  | "step-tts-mini"
  | "qwen-audio-3.0-tts-flash";

export type Os1Mood = "os1-auto" | "os1-crimson" | "host";

export type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export interface BrainSettings {
  mode: BrainMode;
  agentRuntime: AgentRuntimeChoice;
  agentMemory: AgentMemoryMode;
  fillerOnToolCall: boolean;
  externalBrainTier: ExternalBrainTier;
  customBaseUrl: string;
  customModel: string;
  customApiKey: string;
  disableThinking: boolean;
  systemPrompt: string;
}

export interface SttSettings {
  provider: SttProviderChoice;
  language: SttLanguageChoice;
  localBridgeUrl: string;
}

export interface TtsSettings {
  provider: TtsProviderChoice;
  wainaoModel: WainaoTtsModel;
  wainaoProjectId: string;
  endpointUrl: string;
  modelId: string;
  voiceId: string;
  apiKey: string;
  speed: number;
  clauseStreaming: boolean;
}

export interface ExperienceSettings {
  mood: Os1Mood;
  autoContinueListening: boolean;
  bargeInEnabled: boolean;
  showSubtitles: boolean;
}

export interface VoiceChatSettings {
  schemaVersion: 1;
  brain: BrainSettings;
  stt: SttSettings;
  tts: TtsSettings;
  experience: ExperienceSettings;
}

/**
 * 第二步（界面确认后实现）的三大解耦端口定义：
 * 语音交互界面与流水线只依赖这三个抽象接口，不耦合任何单一服务商或固定 Agent。
 */
export interface SttPort {
  readonly id: SttProviderChoice;
  captureUtterance(signal: AbortSignal): Promise<{ text: string }>;
  cancel(): Promise<void>;
}

export interface BrainTurnCallbacks {
  onDelta?(deltaText: string): void;
  onToolStarted?(toolName: string): void;
}

export interface BrainPort {
  readonly id: BrainMode;
  runTurn(userText: string, callbacks: BrainTurnCallbacks, signal: AbortSignal): Promise<{ text: string }>;
  resetSession(): Promise<void>;
}

export interface TtsPort {
  readonly id: TtsProviderChoice;
  speak(text: string, onEnergy: (energy: number) => void, signal: AbortSignal): Promise<void>;
  stop(): void;
}
