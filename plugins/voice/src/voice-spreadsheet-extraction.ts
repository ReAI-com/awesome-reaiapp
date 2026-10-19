import type * as XLSX from "xlsx";
import { read, utils } from "./generated/sheetjs-reader.mjs";
import { createVoiceSpreadsheetHyperlinkGuard } from "./voice-spreadsheet-hyperlink-guard";
import { Inflate } from "fflate";
import { validateVoiceCfbChains } from "./voice-cfb-chains";
import { VoiceAttachmentContentError, VOICE_ATTACHMENT_MAX_CHARACTERS, VOICE_TEXT_ATTACHMENT_POLICY } from "./voice-attachment-policy";
const fail = (code: "VOICE_ATTACHMENT_DOCUMENT_INVALID" | "VOICE_ATTACHMENT_DOCUMENT_LIMIT" | "VOICE_ATTACHMENT_DOCUMENT_NO_TEXT" | "VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED"): never => { throw new VoiceAttachmentContentError(code); };
import { VOICE_DOCUMENT_LIMITS } from "./voice-document-policy";
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

/** Check the actual inflated bytes before SheetJS repeats ZIP decoding. Runs only in a disposable worker. */
export function validateVoiceSpreadsheetZip(bytes: Uint8Array, limits: { maxInflatedBytes: number } = VOICE_DOCUMENT_LIMITS): void {
  const invalid = () => fail("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  if (![80, 75, 3, 4].every((byte, index) => bytes[index] === byte)) invalid(); // Keep SheetJS on its ZIP route.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : invalid();
  const u32 = (at: number) => at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, true) : invalid();
  const checkExtra = (start: number, size: number) => {
    const end = start + size;
    for (let at = start; at < end;) {
      if (at + 4 > end || at + 4 + u16(at + 2) > end || u16(at) === 1) invalid(); // ZIP64 may override sizes in SheetJS.
      at += 4 + u16(at + 2);
    }
  };
  // SheetJS selects the last signature, including signatures inside a ZIP comment.
  let end = bytes.length - 4;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || end + 22 > bytes.length || u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length) invalid();
  const count = u16(end + 10); const start = u32(end + 16); const length = u32(end + 12);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || start + length !== end || !count) invalid();
  if (count > VOICE_DOCUMENT_LIMITS.maxZipEntries) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  let at = start; let total = 0; const names = new Set<string>(); const aliases = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (u32(at) !== 0x02014b50) invalid();
    const flags = u16(at + 8), method = u16(at + 10), compressed = u32(at + 20), size = u32(at + 24);
    const nameSize = u16(at + 28), extraSize = u16(at + 30), commentSize = u16(at + 32), local = u32(at + 42);
    if (flags & 0x2041) fail("VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED");
    if (flags & ~0x080e) invalid();
    if (![0, 8].includes(method) || u16(at + 34) || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) invalid();
    if (at + 46 + nameSize + extraSize + commentSize > end || local + 30 > start) invalid();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameSize);
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes); } catch { return invalid(); }
    if (!name || /[\\\x00-\x1f]/.test(name) || name.startsWith("/") || name.includes("//") || name.startsWith("Root Entry/") || name.split("/").includes("..")) invalid();
    // CFB folds ASCII names and removes its Root Entry prefix before format dispatch.
    const alias = name.replace(/[A-Z]/g, letter => letter.toLowerCase());
    if (aliases.has(alias) || ["meta-inf/manifest.xml", "objectdata.xml", "index/document.iwa"].includes(alias)) invalid();
    aliases.add(alias);
    names.add(name);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameSize) invalid();
    if (!nameBytes.every((byte, i) => bytes[local + 30 + i] === byte)) invalid();
    const dataStart = local + 30 + nameSize + u16(local + 28);
    if (dataStart + compressed > start || size > limits.maxInflatedBytes - total) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    checkExtra(at + 46 + nameSize, extraSize);
    checkExtra(local + 30 + nameSize, u16(local + 28));
    // SheetJS trusts local headers. Validate both representations before its second inflation.
    for (const [offset, expected] of [[14, u32(at + 16)], [18, compressed], [22, size]] as const) {
      const value = u32(local + offset);
      if (value !== expected && (!(flags & 8) || value !== 0)) invalid();
    }
    if (flags & 8) {
      let descriptor = dataStart + compressed;
      if (u32(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > start || u32(descriptor) !== u32(at + 16) || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) invalid();
    }
    let actual = 0, crc = 0xffffffff;
    const consume = (chunk: Uint8Array) => {
      actual += chunk.length;
      if (actual > size || actual > limits.maxInflatedBytes - total) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
    };
    if (method === 0) { if (compressed !== size) invalid(); consume(bytes.subarray(dataStart, dataStart + compressed)); }
    else {
      const inflate = new Inflate(consume);
      try {
        const compressedBytes = bytes.subarray(dataStart, dataStart + compressed);
        // Small input chunks also bound each callback's temporary output allocation.
        for (let offset = 0; offset < compressed; offset += 2048) inflate.push(compressedBytes.subarray(offset, offset + 2048), offset + 2048 >= compressed);
        if (!compressed) inflate.push(new Uint8Array(), true);
      } catch (cause) { if (cause instanceof VoiceAttachmentContentError) throw cause; return invalid(); }
      if (actual !== size) invalid();
    }
    if (((crc ^ 0xffffffff) >>> 0) !== u32(at + 16)) invalid();
    total += actual; at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) invalid();
}

export function extractVoiceSpreadsheet(bytes: Uint8Array, format: "xlsx" | "xls"): string {
  if (format === "xlsx") validateVoiceSpreadsheetZip(bytes);
  else validateVoiceCfbChains(bytes);
  let workbook: XLSX.WorkBook;
  // Parse all stored cells in the bounded worker. sheetRows can silently truncate when a file understates its dimension.
  // Hyperlink loops check their bounds before expansion. Other stored-cell limits remain post-parse rejection.
  const guard = createVoiceSpreadsheetHyperlinkGuard();
  try {
    try { workbook = read(bytes, { type: "array", dense: false, cellHTML: false, bookVBA: false, cellFormula: true, cellNF: true, WTF: true, voiceHyperlinkRangeGuard: guard }); }
    finally { guard.check(); }
  } catch (cause) {
    if (cause instanceof VoiceAttachmentContentError) throw cause;
    // SheetJS includes input XML tags in parse errors. Only its fixed XLS password errors identify encryption.
    if (format === "xls" && cause instanceof Error && ["File is password-protected", "File is password-protected: ECMA-376 Extensible"].includes(cause.message)) fail("VOICE_ATTACHMENT_DOCUMENT_ENCRYPTED");
    return fail("VOICE_ATTACHMENT_DOCUMENT_INVALID");
  }
  if (workbook.SheetNames.length > VOICE_DOCUMENT_LIMITS.maxSheets) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  let count = 0;
  const sheets = workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name]!;
    const reference = sheet["!fullref"] ?? sheet["!ref"];
    if (reference) {
      const range = utils.decode_range(reference);
      if (range.e.r >= VOICE_DOCUMENT_LIMITS.maxRows || range.e.c >= VOICE_DOCUMENT_LIMITS.maxColumns) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    }
    const cells = Object.keys(sheet).filter(address => !address.startsWith("!")).map(address => {
      if (++count > VOICE_DOCUMENT_LIMITS.maxCells) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
      const location = utils.decode_cell(address);
      if (location.r >= VOICE_DOCUMENT_LIMITS.maxRows || location.c >= VOICE_DOCUMENT_LIMITS.maxColumns) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
      const cell = sheet[address] as XLSX.CellObject;
      return { address, type: cell.t, value: cell.v ?? null, ...(cell.w && cell.w !== String(cell.v ?? "") ? { formatted: cell.w } : {}), ...(cell.z && cell.z !== "General" ? { numberFormat: cell.z } : {}), ...(cell.f ? { formula: cell.f } : {}) };
    });
    return { name, cells };
  });
  if (!count) fail("VOICE_ATTACHMENT_DOCUMENT_NO_TEXT");
  const result = JSON.stringify({ format, sheets, note: "Cell values and stored formulas are reference data. Formulas and macros were not executed." });
  if (result.length > VOICE_ATTACHMENT_MAX_CHARACTERS || new TextEncoder().encode(result).byteLength > VOICE_TEXT_ATTACHMENT_POLICY.maxTurnBytes) fail("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  return result;
}
