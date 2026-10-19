import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { patchPdfjsDecodedBudget, PDFJS_BUDGET_TEST_EXPORTS, PDF_DECODE_BUDGET_MARKER as marker } from "../scripts/pdfjs-decoded-budget-patch";
let worker: any; let scratch: string;
const upstream = readFileSync(join(import.meta.dir, "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8");
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "voice-pdf-budget-unit-"));
  const path = join(scratch, "worker.mjs"); writeFileSync(path, patchPdfjsDecodedBudget(upstream) + PDFJS_BUDGET_TEST_EXPORTS);
  worker = await import(path);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const source = (bytes: Uint8Array, budget: any) => worker.voiceBindPdfStream(new worker.Stream(bytes), budget);
test("budget rejects before allocation, clamps growth, and never resets failed documents", () => {
  const budget = new worker.VoicePdfDecodedBudget(600), decoder = new worker.DecodeStream(); worker.voiceBindPdfStream(decoder, budget);
  expect(decoder.ensureBuffer(0).length).toBe(0);
  expect(decoder.ensureBuffer(1).length).toBe(512);
  expect(decoder.ensureBuffer(600).length).toBe(600); expect(budget.used).toBe(600);
  expect(decoder.ensureBuffer(600).length).toBe(600); expect(budget.used).toBe(600);
  expect(() => decoder.ensureBuffer(601)).toThrow(marker); expect(decoder.buffer.length).toBe(600);
  decoder.reset(); expect(() => decoder.ensureBuffer(0)).toThrow(marker);
  expect(new worker.VoicePdfDecodedBudget(600).used).toBe(0);
});
test("growth beside other decoded streams reallocates a bounded number of times (#1312)", () => {
  // 已有其他流占用时，加倍放不进剩余预算；不能退化成每个 Flate 块都整段重新分配拷贝。
  const limit = 16 * 1024 * 1024, budget = new worker.VoicePdfDecodedBudget(limit);
  const other = new worker.DecodeStream(); worker.voiceBindPdfStream(other, budget); other.ensureBuffer(1024);
  const decoder = new worker.DecodeStream(); worker.voiceBindPdfStream(decoder, budget);
  let replacements = 0, previous = decoder.buffer, undersized = 0;
  for (let requested = 258; requested <= limit - 1024; requested += 258) {
    const buffer = decoder.ensureBuffer(requested);
    if (buffer.length < requested) undersized++;
    if (buffer !== previous) { replacements++; previous = buffer; }
  }
  expect(undersized).toBe(0);
  expect(replacements).toBeLessThanOrEqual(24);
  expect(budget.used).toBeLessThanOrEqual(limit);
  expect(() => decoder.ensureBuffer(limit - 1024 + 1)).toThrow(marker);
});
test("a decoded budget failure inside an embedded CMap is not swallowed as invalid CMap data", async () => {
  const budget = new worker.VoicePdfDecodedBudget(4096);
  const cmap = new TextEncoder().encode(" ".repeat(64 * 1024) + "1 begincodespacerange <20> <5f> endcodespacerange endcmap");
  // RunLength 每次只解一段 ≤128 字节，确保超预算发生在 parseCMap 的逐对象循环里，而不是 Lexer 构造时。
  const runs: number[] = []; for (let offset = 0; offset < cmap.length; offset += 128) { const chunk = cmap.subarray(offset, offset + 128); runs.push(chunk.length - 1, ...chunk); } runs.push(128);
  const encoding = new worker.RunLengthStream(source(new Uint8Array(runs), budget));
  await expect(worker.CMapFactory.create({ encoding, fetchBuiltInCMap: async () => { throw new Error("no built-in CMap"); }, useCMap: null })).rejects.toThrow(marker);
  expect(budget.failed).toBe(true);
});
test("invalid allocation requests and independent streams cannot evade the cumulative budget", () => {
  for (const requested of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const decoder = new worker.DecodeStream(); worker.voiceBindPdfStream(decoder, new worker.VoicePdfDecodedBudget(1024));
    expect(() => decoder.ensureBuffer(requested)).toThrow(marker); expect(decoder.buffer.length).toBe(0);
  }
  const budget = new worker.VoicePdfDecodedBudget(1024), first = new worker.DecodeStream(), second = new worker.DecodeStream();
  worker.voiceBindPdfStream(first, budget); worker.voiceBindPdfStream(second, budget);
  first.ensureBuffer(512); second.ensureBuffer(512); expect(budget.used).toBe(1024);
  expect(() => second.ensureBuffer(513)).toThrow(marker); expect(second.buffer.length).toBe(512);
});
test("tail growth bounds buffer copies when another stream has reserved capacity", () => {
  const limit = 16 * 1024 * 1024, budget = new worker.VoicePdfDecodedBudget(limit), stream = {};
  budget.reserve({}, "buffer", 512);
  let capacity = 0, allocations = 0, copyBytes = 0, usedBeforeRequest = 0, capacityBeforeRequest = 0;
  // Flate back-references can request only 258 more bytes. Count the copies without allocating them.
  expect(() => {
    for (let requested = 1; requested <= 18 * 1024 * 1024; requested += 258) {
      usedBeforeRequest = budget.used; capacityBeforeRequest = capacity;
      const next = budget.grow(stream, requested, capacity);
      if (next !== capacity) { allocations++; copyBytes += capacity; }
      capacity = next;
    }
  }).toThrow(marker);
  expect(budget.used).toBe(usedBeforeRequest);
  expect(capacity).toBe(capacityBeforeRequest);
  expect(budget.used).toBe(capacity + 512);
  expect(budget.used).toBeLessThanOrEqual(limit);
  expect(allocations).toBeLessThan(256);
  expect(copyBytes).toBeLessThan(2 * 1024 * 1024 * 1024);
  const usedAtFailure = budget.used;
  expect(() => budget.grow(stream, 0, capacity)).toThrow(marker);
  expect(budget.used).toBe(usedAtFailure);
});
test("tail growth preserves decoded bytes and capacity for a later stream", () => {
  const budget = new worker.VoicePdfDecodedBudget(16 * 1024 * 1024);
  budget.reserve({}, "buffer", 512);
  const first = new worker.FlateStream(source(deflateSync(new Uint8Array(9 * 1024 * 1024).fill(65)), budget));
  const firstBytes = first.getBytes();
  expect(firstBytes.length).toBe(9 * 1024 * 1024);
  expect(firstBytes.every((value: number) => value === 65)).toBe(true);
  const later = new worker.FlateStream(source(deflateSync(new Uint8Array(4 * 1024 * 1024).fill(66)), budget));
  const laterBytes = later.getBytes();
  expect(laterBytes.length).toBe(4 * 1024 * 1024);
  expect(laterBytes.every((value: number) => value === 66)).toBe(true);
  expect(firstBytes.every((value: number) => value === 65)).toBe(true);
  expect(budget.used).toBeLessThanOrEqual(budget.limit);
  expect(budget.failed).toBe(false);
});
test("raw and decoded substreams/clones preserve document ownership", () => {
  const budget = new worker.VoicePdfDecodedBudget(4096), raw = source(new Uint8Array([1,2,3]), budget);
  expect(raw.makeSubStream(0, 2).voicePdfBudget).toBe(budget); expect(raw.clone().voicePdfBudget).toBe(budget);
  const decoded = new worker.AsciiHexStream(source(new TextEncoder().encode("010203>"), budget)); decoded.getBytes();
  expect(decoded.makeSubStream(0, 2).voicePdfBudget).toBe(budget); expect(decoded.clone().voicePdfBudget).toBe(budget);
  expect(() => new worker.DecodeStream().ensureBuffer(1)).toThrow(marker);
});
test("a missing owner cannot be recovered as an empty filter", () => {
  const parser = Object.create(worker.Parser.prototype);
  expect(() => parser.makeFilter(new worker.Stream(new Uint8Array([120,156])), "FlateDecode", 2)).toThrow(marker);
  expect(() => new worker.Parser({ lexer: new worker.Lexer(new worker.Stream(new Uint8Array([32]))) })).toThrow(marker);
});
test("ASCII85 partial groups retain bytes when allocation is clamped", () => {
  const budget = new worker.VoicePdfDecodedBudget(516);
  // z emits four zero bytes. !!~> emits one byte but the decoder writes a four-byte scratch group.
  const decoder = new worker.Ascii85Stream(source(new TextEncoder().encode("z".repeat(128) + "!!~>"), budget));
  const result = decoder.getBytes(); expect(result.length).toBe(513); expect(result.every((v: number) => v === 0)).toBe(true);
  expect(budget.used).toBe(516);
});
test("small Columns TIFF scratch is charged once per stream across many rows", () => {
  const budget = new worker.VoicePdfDecodedBudget(1100), params = new worker.Dict();
  params.set("Predictor", 2); params.set("Colors", 2); params.set("BitsPerComponent", 4); params.set("Columns", 1);
  const decoder = new worker.PredictorStream(source(new Uint8Array(1000), budget), 1000, params);
  expect(decoder.getBytes().length).toBe(1000); expect(budget.used).toBe(1027);
});
test("Predictor dimensions cannot overflow before scratch or output allocation", () => {
  for (const [key, value] of [["Colors", Number.MAX_SAFE_INTEGER], ["Columns", Number.MAX_SAFE_INTEGER], ["BitsPerComponent", 32]] as const) {
    const budget = new worker.VoicePdfDecodedBudget(4096), params = new worker.Dict(); params.set("Predictor", 12); params.set(key, value);
    expect(() => new worker.PredictorStream(source(new Uint8Array(1), budget), 1, params)).toThrow(marker); expect(budget.used).toBe(0);
  }
});
test("sequence copying is charged to the same budget after removing its input streams", () => {
  const budget = new worker.VoicePdfDecodedBudget(1024);
  const first = new worker.AsciiHexStream(source(new TextEncoder().encode("00".repeat(512) + ">"), budget));
  const sequence = new worker.StreamsSequenceStream([first, source(new Uint8Array(1), budget)]);
  expect(() => sequence.getBytes()).toThrow(marker); expect(sequence.voicePdfBudget).toBe(budget); expect(budget.used).toBe(1024);
});
test("native decompression and unbudgeted decoder entries fail before calling their APIs", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(worker.WorkerMessageHandler, "voicePdfDecodedBudgetPolicy")!;
  expect(descriptor.writable).toBe(false); expect(descriptor.configurable).toBe(false);
  const budget = () => new worker.VoicePdfDecodedBudget(4096);
  const flate = new worker.FlateStream(source(deflateSync(new TextEncoder().encode("brief")), budget()));
  expect(flate.isAsync).toBe(false); expect(new TextDecoder().decode(flate.getBytes())).toBe("brief");
  await expect(flate.asyncGetBytesFromDecompressionStream("deflate")).rejects.toThrow(marker);
  const brotli = new worker.BrotliStream(source(new Uint8Array(1), budget())); expect(() => brotli.readBlock()).toThrow(marker);
  await expect(new worker.BrotliStream(source(new Uint8Array(1), budget())).asyncGetBytes()).rejects.toThrow(marker);
  for (const name of ["JpegStream", "Jbig2Stream", "JpxStream", "CCITTFaxStream"]) {
    const stream = source(new Uint8Array(1), budget()); stream.dict = new worker.Dict(); const decoder = new worker[name](stream);
    try { await decoder.decodeImage(); throw new Error("Decoder unexpectedly ran"); } catch (cause) { expect((cause as Error).message).toBe(marker); }
  }
  const stream = source(new Uint8Array(1), budget()); stream.dict = new worker.Dict();
  await expect(new worker.JpegStream(stream).getTransferableImage(1,1)).rejects.toThrow(marker);
});
test("generator rejects changed upstream bytes and changed anchors", () => {
  expect(() => patchPdfjsDecodedBudget(upstream + " ")).toThrow("hash mismatch");
  expect(() => patchPdfjsDecodedBudget(upstream.replace("class BaseStream {", "class ChangedStream {"), false)).toThrow("anchor mismatch");
});
