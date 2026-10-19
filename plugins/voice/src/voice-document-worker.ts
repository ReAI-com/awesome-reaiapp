import { extractVoiceSpreadsheet } from "./voice-spreadsheet-extraction";
import { VoiceAttachmentContentError } from "./voice-attachment-policy";
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void };
scope.onmessage = event => {
  const input = event.data;
  if (!input || !["xlsx", "xls"].includes(input.format) || !(input.bytes instanceof Uint8Array)) { scope.postMessage({ code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" }); return; }
  try { scope.postMessage({ content: extractVoiceSpreadsheet(input.bytes, input.format) }); }
  catch (cause) { scope.postMessage({ code: cause instanceof VoiceAttachmentContentError ? cause.code : "VOICE_ATTACHMENT_DOCUMENT_INVALID" }); }
};
