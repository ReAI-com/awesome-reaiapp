import type { Range, WorkSheet } from "xlsx";
import { utils } from "./generated/sheetjs-reader.mjs";
import { VoiceAttachmentContentError } from "./voice-attachment-policy";
import { VOICE_DOCUMENT_LIMITS } from "./voice-document-policy";

export type VoiceHyperlinkEvent = { kind: "range"; range: Range; expands: boolean } | { kind: "cell"; address: string } | { kind: "complete" };
export type VoiceHyperlinkGuard = ((sheet: unknown, event: VoiceHyperlinkEvent) => void) & { check(): void };
type Limits = Pick<typeof VOICE_DOCUMENT_LIMITS, "maxRows" | "maxColumns" | "maxCells" | "maxHyperlinkRangeVisits">;

/** Count actual unique cells before hyperlink expansion. Other parser allocations remain post-parse checks. */
export function createVoiceSpreadsheetHyperlinkGuard(limits: { [Key in keyof Limits]: number } = VOICE_DOCUMENT_LIMITS): VoiceHyperlinkGuard {
  const contributions = new WeakMap<object, number>();
  let total = 0;
  let violation: VoiceAttachmentContentError | undefined;
  const check = () => { if (violation) throw violation; };
  const fail = (code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" | "VOICE_ATTACHMENT_DOCUMENT_LIMIT"): never => {
    violation ??= new VoiceAttachmentContentError(code);
    throw violation;
  };
  const count = (sheet: WorkSheet) => Object.keys(sheet).reduce((sum, address) => sum + Number(!address.startsWith("!")), 0);
  const replace = (sheet: WorkSheet, value: number) => {
    total += value - (contributions.get(sheet) ?? 0);
    contributions.set(sheet, value);
  };
  const initialize = (sheet: WorkSheet) => { if (!contributions.has(sheet)) replace(sheet, count(sheet)); };
  const hasCell = (sheet: WorkSheet, address: string) => Object.prototype.hasOwnProperty.call(sheet, address);
  return Object.assign((value: unknown, event: VoiceHyperlinkEvent) => {
    check();
    // SheetJS can return an empty string for an empty worksheet XML entry.
    if (!value || typeof value !== "object") return;
    const sheet = value as WorkSheet;
    if (event.kind === "complete") { replace(sheet, count(sheet)); return; }
    if (event.kind === "cell") {
      initialize(sheet);
      // Observe interleaved XLSB cell writes. This does not reject ordinary cell allocation.
      if (!hasCell(sheet, event.address)) replace(sheet, contributions.get(sheet)! + 1);
      return;
    }
    const { s, e } = event.range;
    if (![s.r, s.c, e.r, e.c].every(coordinate => Number.isSafeInteger(coordinate) && coordinate >= 0)) fail("VOICE_ATTACHMENT_DOCUMENT_INVALID");
    if (s.r > e.r || s.c > e.c) return; // The upstream loop visits no cells.
    if (e.r >= limits.maxRows || e.c >= limits.maxColumns) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    const area = (e.r - s.r + 1) * (e.c - s.c + 1);
    if (area > limits.maxHyperlinkRangeVisits) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    if (!event.expands) return; // BIFF HLink/Tooltip only visit existing cells.
    initialize(sheet);
    if (total > limits.maxCells) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    let missing = 0;
    for (let row = s.r; row <= e.r; row++) for (let column = s.c; column <= e.c; column++) {
      if (!hasCell(sheet, utils.encode_cell({ r: row, c: column })) && ++missing > limits.maxCells - total) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    }
    // Reserve only new keys. The original loop writes them immediately after this callback returns.
    replace(sheet, contributions.get(sheet)! + missing);
  }, { check });
}
