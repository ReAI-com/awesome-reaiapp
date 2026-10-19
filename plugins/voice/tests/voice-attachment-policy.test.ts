import { expect, test } from "bun:test";
import * as content from "../src/voice-attachment-content";
import * as policy from "../src/voice-attachment-policy";
import { validateVoiceCfbChains } from "../src/voice-cfb-chains";
import { createVoiceSpreadsheetHyperlinkGuard } from "../src/voice-spreadsheet-hyperlink-guard";

test("content compatibility exports preserve policy and error constructor identity", () => {
  expect(content.VoiceAttachmentContentError).toBe(policy.VoiceAttachmentContentError);
  expect(content.VOICE_TEXT_ATTACHMENT_POLICY).toBe(policy.VOICE_TEXT_ATTACHMENT_POLICY);
  expect(content.VOICE_ATTACHMENT_MAX_CHARACTERS).toBe(policy.VOICE_ATTACHMENT_MAX_CHARACTERS);
  expect(policy.VOICE_TEXT_ATTACHMENT_POLICY).toEqual({ maxFileBytes: 65536, maxAttachments: 4, maxTurnBytes: 65536 });
  expect(policy.VOICE_ATTACHMENT_MAX_CHARACTERS).toBe(24000);
  const error = new content.VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  expect(error).toBeInstanceOf(policy.VoiceAttachmentContentError);
  expect(error).toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_INVALID", message: "VOICE_ATTACHMENT_DOCUMENT_INVALID", name: "VoiceAttachmentContentError" });
});

test("text, CFB and hyperlink failures share the public error identity", async () => {
  try { await content.readVoiceTextAttachment(new File([], "empty.txt"), policy.VOICE_TEXT_ATTACHMENT_POLICY); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(policy.VoiceAttachmentContentError); expect(error).toMatchObject({ code: "VOICE_ATTACHMENT_EMPTY" }); }
  for (const run of [
    () => validateVoiceCfbChains(new Uint8Array()),
    () => createVoiceSpreadsheetHyperlinkGuard()({}, { kind: "range", range: { s: { r: -1, c: 0 }, e: { r: 0, c: 0 } }, expands: true }),
  ]) {
    try { run(); throw new Error("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(content.VoiceAttachmentContentError); expect(error).toMatchObject({ code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" }); }
  }
});
