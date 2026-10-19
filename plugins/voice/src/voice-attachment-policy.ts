/** Shared inert text/document policy. Keep this module independent of UI and Host contracts. */
export type VoiceAttachmentContentCode = "VOICE_ATTACHMENT_SCENE_UNSUPPORTED" | "VOICE_ATTACHMENT_MODEL_UNCONFIRMED" | "VOICE_ATTACHMENT_EMPTY" | "VOICE_ATTACHMENT_TOO_LARGE" | "VOICE_ATTACHMENT_NAME_INVALID" | "VOICE_ATTACHMENT_READ_FAILED" | "VOICE_ATTACHMENT_ENCODING_UNSUPPORTED" | "VOICE_ATTACHMENT_BINARY_UNSUPPORTED" | "VOICE_ATTACHMENT_EXTRACTION_REQUIRED" | "VOICE_ATTACHMENT_COUNT_EXCEEDED" | "VOICE_ATTACHMENT_TURN_TOO_LARGE" | "VOICE_ATTACHMENT_DOCUMENT_INVALID" | "VOICE_ATTACHMENT_DOCUMENT_LIMIT" | "VOICE_ATTACHMENT_DOCUMENT_NO_TEXT" | "VOICE_ATTACHMENT_DOCUMENT_TIMEOUT" | "VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE" | "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED" | "VOICE_ATTACHMENT_DOCUMENT_TOO_LARGE";
export class VoiceAttachmentContentError extends Error {
  constructor(public readonly code: VoiceAttachmentContentCode) { super(code); this.name = "VoiceAttachmentContentError"; }
}
// This preparation route is bounded by today's text request, not the upload plan limit.
export const MAX_TEXT_BYTES = 64 * 1024;
export const VOICE_TEXT_ATTACHMENT_POLICY = { maxFileBytes: MAX_TEXT_BYTES, maxAttachments: 4, maxTurnBytes: MAX_TEXT_BYTES } as const;
export const VOICE_ATTACHMENT_MAX_CHARACTERS = 24000; // continuationPrompt enforces this on new/switched sessions.
