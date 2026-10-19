import { VoiceAttachmentContentError } from "./voice-attachment-policy";

const END = -2;
const invalid = (): never => { throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_DOCUMENT_INVALID"); };

/** Validate main FAT chains before SheetJS. This does not bound all workbook parsing. */
export function validateVoiceCfbChains(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : invalid();
  const i32 = (at: number) => at >= 0 && at + 4 <= bytes.length ? view.getInt32(at, true) : invalid();
  if (bytes.length < 512 || ![208, 207, 17, 224, 161, 177, 26, 225].every((byte, i) => bytes[i] === byte)) invalid();
  const major = u16(26), shift = u16(30);
  // SheetJS ignores byteOrder: some writers use 0xffff. Reads remain little-endian.
  if (u16(32) !== 6 || !((major === 3 && shift === 9) || (major === 4 && shift === 12))) invalid();
  const sectorSize = 2 ** shift;
  if (bytes.length < sectorSize || (major === 3 && i32(40) !== 0) || i32(56) !== 4096) invalid();
  // Match sectorify: the last data sector may be short. Metadata must be complete.
  const sectorCount = Math.ceil(bytes.length / sectorSize) - 1;
  const validSector = (sector: number) => Number.isInteger(sector) && sector >= 0 && sector < sectorCount;
  const offset = (sector: number) => {
    if (!validSector(sector)) invalid();
    return (sector + 1) * sectorSize;
  };
  const completeOffset = (sector: number) => {
    const at = offset(sector);
    if (at + sectorSize > bytes.length) invalid();
    return at;
  };
  const requiredPages = Math.ceil(sectorCount * 4 / sectorSize);
  const declaredPages = i32(44), declaredDifat = i32(72);
  if (!sectorCount || declaredPages < requiredPages || declaredPages > sectorCount || declaredDifat < 0 || declaredDifat > sectorCount) invalid();
  const pages: number[] = [];
  const addPage = (sector: number) => {
    // Do not remove FREE slots: doing so would shift SheetJS's FAT page mapping.
    if (pages.length < requiredPages) { completeOffset(sector); pages.push(sector); }
  };
  for (let index = 0; index < 109; index++) {
    const sector = i32(76 + index * 4);
    if (sector < 0) break; // SheetJS stops at the first negative header slot.
    addPage(sector);
  }
  const seenDifat = new Uint8Array(sectorCount);
  let difat = i32(68);
  for (let step = 0; step < declaredDifat; step++) {
    const at = completeOffset(difat);
    if (seenDifat[difat]) invalid();
    seenDifat[difat] = 1;
    for (let slot = 0; slot < sectorSize / 4 - 1; slot++) {
      const sector = i32(at + slot * 4);
      if (sector === END) { if (pages.length < requiredPages) invalid(); break; }
      addPage(sector);
    }
    difat = i32(at + sectorSize - 4);
  }
  // A further sector would be read by upstream sleuth_fat, even with count zero.
  if ((difat !== END && difat !== -1) || pages.length !== requiredPages || new Set(pages).size !== pages.length) invalid();
  const next = new Int32Array(sectorCount);
  for (let sector = 0; sector < sectorCount; sector++) {
    const byteIndex = sector * 4;
    const value = i32(completeOffset(pages[Math.floor(byteIndex / sectorSize)]!) + byteIndex % sectorSize);
    if (!validSector(value) && ![-1, END, -3, -4].includes(value)) invalid();
    next[sector] = value;
  }
  // State 1 belongs to the current path. State 2 is an already completed acyclic tail.
  const state = new Uint8Array(sectorCount);
  for (let start = 0; start < sectorCount; start++) {
    let sector = start;
    while (sector >= 0 && state[sector] === 0) { state[sector] = 1; sector = next[sector]!; }
    if (sector >= 0 && state[sector] === 1) invalid();
    sector = start;
    while (sector >= 0 && state[sector] === 1) { state[sector] = 2; sector = next[sector]!; }
  }
  let directory = i32(48);
  if (!validSector(directory)) invalid();
  while (directory >= 0) {
    const at = completeOffset(directory);
    for (let entry = at; entry < at + sectorSize; entry += 128) {
      // read_directory uses this predicate for every non-root type, including invalid types.
      if (bytes[entry + 66] !== 5 && i32(entry + 120) >= 4096 && !validSector(i32(entry + 116))) invalid();
    }
    directory = next[directory]!;
  }
  if (directory !== END) invalid();
}
