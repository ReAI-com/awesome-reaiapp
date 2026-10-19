import { createHash } from "node:crypto";
import { VOICE_DOCUMENT_LIMITS } from "../src/voice-document-policy";
export const PDFJS_UPSTREAM_WORKER_SHA256 = "df3bf6bf6b8b8dac8a4042d8c4ecf1cf21e1d197e0fe231c192122409eba656b";
export const PDF_DECODE_BUDGET_MARKER = "VOICE_PDF_DECODE_BUDGET_EXCEEDED";
export const PDF_DECODE_BUDGET_POLICY = `voice-pdf-decoded-capacity-v1:${VOICE_DOCUMENT_LIMITS.maxPdfDecodedBytes}`;

// This source is inserted into the pinned worker. It has no process-global document budget.
const budgetSource = `
const VOICE_PDF_DECODE_BUDGET_MARKER = ${JSON.stringify(PDF_DECODE_BUDGET_MARKER)};
const VOICE_PDF_DECODE_BUDGET_POLICY = ${JSON.stringify(PDF_DECODE_BUDGET_POLICY)};
let voicePdfUnboundAllocations = 0;
class VoicePdfDecodedBudget {
  used = 0;
  failed = false;
  capacities = new WeakMap();
  constructor(limit = ${VOICE_DOCUMENT_LIMITS.maxPdfDecodedBytes}) { this.limit = limit; }
  fail() { this.failed = true; throw new Error(VOICE_PDF_DECODE_BUDGET_MARKER); }
  check() { if (this.failed) this.fail(); }
  reserve(key, slot, capacity) {
    this.check();
    if (!Number.isSafeInteger(capacity) || capacity < 0) this.fail();
    const record = this.capacities.get(key) || Object.create(null);
    const previous = record[slot] || 0;
    if (capacity <= previous) return;
    const increment = capacity - previous;
    if (increment > this.limit - this.used) this.fail();
    this.used += increment;
    record[slot] = capacity;
    this.capacities.set(key, record);
  }
  grow(key, requested, current) {
    this.check();
    if (!Number.isSafeInteger(requested) || requested < 0) this.fail();
    this.reserve(key, "buffer", current);
    if (requested <= current) return current;
    const available = current + this.limit - this.used;
    if (requested > available) this.fail();
    let capacity = 512;
    while (capacity < requested) capacity *= 2;
    // Near the budget, grow by at least 1/8 instead of to the exact request: exact
    // growth reallocates and copies the whole buffer for every small decoded block.
    if (capacity > available) capacity = Math.min(available, Math.max(requested, current + Math.ceil(current / 8)));
    this.reserve(key, "buffer", capacity);
    return capacity;
  }
}
function voiceRequirePdfBudget(stream) {
  const budget = stream?.voicePdfBudget;
  if (!budget) { voicePdfUnboundAllocations++; throw new Error(VOICE_PDF_DECODE_BUDGET_MARKER); }
  budget.check();
  return budget;
}
function voiceBindPdfStream(stream, budget) {
  if (!budget) { voicePdfUnboundAllocations++; throw new Error(VOICE_PDF_DECODE_BUDGET_MARKER); }
  const existing = stream.voicePdfBudget;
  if (existing && existing !== budget) budget.fail();
  stream._voicePdfBudget = budget;
  return stream;
}
function voiceCopyPdfBudget(source, target) {
  const budget = source.voicePdfBudget;
  return budget ? voiceBindPdfStream(target, budget) : target;
}
function voiceRejectPdfDecoder(stream) { voiceRequirePdfBudget(stream).fail(); }
`;

/** Fail on source drift. Each replacement applies only to the reviewed upstream bytes. */
export function patchPdfjsDecodedBudget(upstream: string, verifyHash = true): string {
  if (verifyHash && createHash("sha256").update(upstream).digest("hex") !== PDFJS_UPSTREAM_WORKER_SHA256) throw new Error("Pinned PDF.js worker hash mismatch");
  let source = upstream;
  const replace = (before: string, after: string, count = 1) => {
    const actual = source.split(before).length - 1;
    if (actual !== count) throw new Error(`PDF.js patch anchor mismatch (${actual}/${count}): ${before.slice(0, 80)}`);
    source = source.split(before).join(after);
  };
  replace("class BaseStream {", `${budgetSource}\nclass BaseStream {\n  get voicePdfBudget() {\n    return this._voicePdfBudget || this.stream?.voicePdfBudget || this.dict?.xref?.pdfManager?.voicePdfBudget;\n  }`);
  replace("return new Stream(this.bytes.buffer, start, length, dict);", "return voiceCopyPdfBudget(this, new Stream(this.bytes.buffer, start, length, dict));");
  replace("return new Stream(this.bytes.buffer, this.start, this.length, this.dict?.clone());", "return voiceCopyPdfBudget(this, new Stream(this.bytes.buffer, this.start, this.length, this.dict?.clone()));");
  replace("return new Stream(this.buffer, start, length, dict);", "return voiceBindPdfStream(new Stream(this.buffer, start, length, dict), voiceRequirePdfBudget(this));");
  replace("return new Stream(this.buffer, 0, this.bufferLength, this.dict?.clone());", "return voiceBindPdfStream(new Stream(this.buffer, 0, this.bufferLength, this.dict?.clone()), voiceRequirePdfBudget(this));");
  replace(`    if (maybeMinBufferLength) {
      while (this.minBufferLength < maybeMinBufferLength) {
        this.minBufferLength *= 2;
      }
    }`, "    // The raw length hint must not select decoded allocation capacity.");
  replace(`    const buffer = this.buffer;
    if (requested <= buffer.byteLength) {
      return buffer;
    }
    let size = this.minBufferLength;
    while (size < requested) {
      size *= 2;
    }
    const buffer2 = new Uint8Array(size);`, `    const buffer = this.buffer;
    const size = voiceRequirePdfBudget(this).grow(this, requested, buffer.byteLength);
    if (size === buffer.byteLength) return buffer;
    const buffer2 = new Uint8Array(size);`);
  replace("  async asyncGetBytesFromDecompressionStream(name) {", "  async asyncGetBytesFromDecompressionStream(name) {\n    voiceRejectPdfDecoder(this); // Reject before native chunk allocation.");
  // Audit both native callers. Flate text stays on its bounded JS path.
  if ((source.match(/await this\.asyncGetBytesFromDecompressionStream\(/g) || []).length !== 2) throw new Error("PDF.js native decoder caller mismatch");
  replace("class FlateStream extends DecodeStream {\n  #isAsync = true;", "class FlateStream extends DecodeStream {\n  #isAsync = false;");
  replace("  constructor(streams, onError = null) {\n    streams = streams.filter", "  constructor(streams, onError = null) {\n    const voiceBudget = streams.find(s => s?.voicePdfBudget)?.voicePdfBudget;\n    streams = streams.filter");
  replace("    this.streams = streams;\n    this._onError = onError;", "    this.streams = streams;\n    this._voicePdfBudget = voiceBudget;\n    if (streams.some(s => s.voicePdfBudget && s.voicePdfBudget !== voiceBudget)) voiceBudget.fail();\n    this._onError = onError;");
  replace("      buffer = this.ensureBuffer(bufferLength + i - 1);", "      buffer = this.ensureBuffer(bufferLength + 4); // The final partial group still writes four bytes.");
  replace(`    this.pixBytes = colors * bits + 7 >> 3;
    this.rowBytes = columns * colors * bits + 7 >> 3;`, `    const budget = voiceRequirePdfBudget(this);
    if (!Number.isSafeInteger(colors) || colors <= 0 || !Number.isSafeInteger(columns) || columns <= 0 || ![1, 2, 4, 8, 16].includes(bits)) budget.fail();
    const pixelBits = colors * bits, rowBits = columns * pixelBits;
    if (!Number.isSafeInteger(pixelBits) || !Number.isSafeInteger(rowBits)) budget.fail();
    this.pixBytes = Math.ceil(pixelBits / 8);
    this.rowBytes = Math.ceil(rowBits / 8);
    if (this.rowBytes > budget.limit) budget.fail();`);
  replace("      const compArray = new Uint8Array(colors + 1);", "      voiceRequirePdfBudget(this).reserve(this, \"tiffScratch\", colors + 1);\n      const compArray = new Uint8Array(colors + 1);");
  replace("      prevRow = new Uint8Array(rowBytes);", "      voiceRequirePdfBudget(this).reserve(this, \"pngScratch\", rowBytes);\n      prevRow = new Uint8Array(rowBytes);");
  replace("class BrotliStream extends DecodeStream {", "class BrotliStream extends DecodeStream {");
  replace("    const decodedData = BrotliDecode(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));", "    voiceRejectPdfDecoder(this);\n    const decodedData = BrotliDecode(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));");
  replace("  decodeImage(bytes) {\n    if (this.eof)", "  decodeImage(bytes) {\n    voiceRejectPdfDecoder(this);\n    if (this.eof)");
  replace("  async getTransferableImage(width, height) {\n    if (!(await JpegStream.canUseImageDecoder))", "  async getTransferableImage(width, height) {\n    voiceRejectPdfDecoder(this);\n    if (!(await JpegStream.canUseImageDecoder))");
  replace("  async decodeImage(bytes, length, _decoderOptions) {", "  async decodeImage(bytes, length, _decoderOptions) {\n    voiceRejectPdfDecoder(this);", 2);
  replace("  async decodeImage(bytes, _length, decoderOptions) {", "  async decodeImage(bytes, _length, decoderOptions) {\n    voiceRejectPdfDecoder(this);");
  replace("    this.lexer = lexer;\n    this.xref = xref;", "    this.voicePdfBudget = lexer.stream.voicePdfBudget || xref?.pdfManager?.voicePdfBudget;\n    voiceBindPdfStream(lexer.stream, this.voicePdfBudget);\n    this.lexer = lexer;\n    this.xref = xref;");
  replace("  makeFilter(stream, name, maybeLength, params, cipherTransform = null) {", "  makeFilter(stream, name, maybeLength, params, cipherTransform = null) {\n    voiceBindPdfStream(stream, this.voicePdfBudget);\n    voiceRequirePdfBudget(stream);");
  // Only this function's recovery streams need binding; other NullStreams can be bound by Parser.
  const start = source.indexOf("  makeFilter(stream, name,");
  const end = source.indexOf("\n  }\n}\nconst specialChars", start);
  if (start < 0 || end < 0) throw new Error("PDF.js filter region mismatch");
  let filter = source.slice(start, end);
  if (filter.split("return new NullStream();").length - 1 !== 2) throw new Error("PDF.js filter recovery mismatch");
  filter = filter.replaceAll("return new NullStream();", "return voiceBindPdfStream(new NullStream(), this.voicePdfBudget);");
  filter = filter.replace('      warn(`Filter "${name}" is not supported.`);\n      return stream;', "      voiceRejectPdfDecoder(stream);");
  filter = filter.replace("if (ex instanceof MissingDataException)", "if (ex instanceof MissingDataException || ex?.message === VOICE_PDF_DECODE_BUDGET_MARKER)");
  source = source.slice(0, start) + filter + source.slice(end);
  replace("    const stream = new Stream(args.source);\n    this.pdfDocument", "    this.voicePdfBudget = new VoicePdfDecodedBudget();\n    const stream = voiceBindPdfStream(new Stream(args.source), this.voicePdfBudget);\n    this.pdfDocument");
  // Embedded CMap parsing treats every other error as invalid data and keeps lexing the stream.
  replace("      if (ex instanceof MissingDataException) {\n        throw ex;\n      }\n      warn(\"Invalid cMap data: \" + ex);", "      if (ex instanceof MissingDataException || ex?.message === VOICE_PDF_DECODE_BUDGET_MARKER) {\n        throw ex;\n      }\n      warn(\"Invalid cMap data: \" + ex);");
  replace("class WorkerMessageHandler {", "class WorkerMessageHandler {\n  static { Object.defineProperty(this, \"voicePdfDecodedBudgetPolicy\", { value: VOICE_PDF_DECODE_BUDGET_POLICY }); }");
  replace("  static setup(handler, port) {\n    let testMessageProcessed", "  static setup(handler, port) {\n    handler.on(\"VoicePdfDecodedBudgetPolicy\", () => VOICE_PDF_DECODE_BUDGET_POLICY);\n    let testMessageProcessed");
  replace("    let handler = new MessageHandler(workerHandlerName, docId, port);", `    let handler = new MessageHandler(workerHandlerName, docId, port);
    const voiceCheckBudget = () => pdfManager?.voicePdfBudget?.check();
    const voiceRecordFailure = reason => {
      if (reason?.message === VOICE_PDF_DECODE_BUDGET_MARKER && pdfManager?.voicePdfBudget) pdfManager.voicePdfBudget.failed = true;
      return pdfManager?.voicePdfBudget?.failed ? new Error(VOICE_PDF_DECODE_BUDGET_MARKER) : reason;
    };
    const voiceOriginalOn = handler.on.bind(handler);
    handler.on = (name, callback) => voiceOriginalOn(name, function(data, sink) {
      // Termination must remain available after a resource failure.
      if (name === "Terminate") return callback(data, sink);
      if (sink) {
        const enqueue = sink.enqueue.bind(sink), close = sink.close.bind(sink), error = sink.error.bind(sink);
        sink.enqueue = (...args) => { voiceCheckBudget(); return enqueue(...args); };
        sink.close = () => { try { voiceCheckBudget(); return close(); } catch (reason) { return error(voiceRecordFailure(reason)); } };
        sink.error = reason => error(voiceRecordFailure(reason));
      }
      try {
        voiceCheckBudget();
        const result = callback(data, sink);
        return Promise.resolve(result).then(value => { voiceCheckBudget(); return value; }, reason => { throw voiceRecordFailure(reason); });
      } catch (reason) { throw voiceRecordFailure(reason); }
    });`);
  replace("      const htmlForXfa = isPureXfa ? await pdfManager.ensureDoc(\"htmlForXfa\") : null;", "      const htmlForXfa = isPureXfa ? await pdfManager.ensureDoc(\"htmlForXfa\") : null;\n      voiceCheckBudget();");
  replace("      function onSuccess(doc) {\n        ensureNotTerminated();", "      function onSuccess(doc) {\n        try { voiceCheckBudget(); } catch (reason) { onFailure(reason); return; }\n        ensureNotTerminated();");
  replace("      function onFailure(ex) {\n        if (terminated)", "      function onFailure(ex) {\n        ex = voiceRecordFailure(ex);\n        if (terminated)");
  return source;
}

/** Test-only exports. Never append these to the product worker. */
export const PDFJS_BUDGET_TEST_EXPORTS = `\nexport { VoicePdfDecodedBudget, Stream, NullStream, DecodeStream, StreamsSequenceStream, Ascii85Stream, AsciiHexStream, FlateStream, LZWStream, RunLengthStream, PredictorStream, BrotliStream, JpegStream, Jbig2Stream, JpxStream, CCITTFaxStream, Parser, Lexer, Dict, CMapFactory, voiceBindPdfStream, voiceRequirePdfBudget };\nexport const voiceBudgetUnboundCount = () => voicePdfUnboundAllocations;\n`;
