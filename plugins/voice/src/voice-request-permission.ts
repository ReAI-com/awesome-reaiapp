import { AppError, type VoiceInputClient, type VoiceInputSettings } from "@reai/app-sdk/v1";

/** Host owns route selection, including legacy Board UAC when the route is unavailable. */
export async function prepareVoiceRequest(
  voice: Pick<VoiceInputClient, "configure" | "checkPermissions">,
  settings: VoiceInputSettings,
  signal: AbortSignal,
  _reportWaitingPermission: () => void,
  messages: { cancelled: string; upgrade: string; microphone: string },
): Promise<void> {
  const cancelled = () => new AppError({ code: "SERVICE_CANCELLED", userMessage: messages.cancelled });
  const checkCancelled = () => { if (signal.aborted) throw cancelled(); };
  checkCancelled();
  await voice.configure(settings);
  checkCancelled();
  const permissions = await voice.checkPermissions();
  checkCancelled();
  if (typeof permissions.microphoneRequired !== "boolean") {
    throw new AppError({ code: "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED", userMessage: messages.upgrade, retryable: true });
  }
  if (!permissions.microphoneRequired || permissions.microphone === "granted") return;
  // 录音开始的链路只检查、不请求（2026-10-11 拍板：录音中绝不弹系统授权）。
  // 需要电脑麦却未授权时直接失败，由用户在 Voice 设置里点击授权。
  throw new AppError({ code: "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED", userMessage: messages.microphone, retryable: true });
}
