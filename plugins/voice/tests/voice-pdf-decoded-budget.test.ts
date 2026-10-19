import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pdfBudgetFixture } from "./pdf-budget-fixtures";
import { patchPdfjsDecodedBudget, PDFJS_BUDGET_TEST_EXPORTS } from "../scripts/pdfjs-decoded-budget-patch";
const fixtures = join(import.meta.dir, "fixtures/pdf-decoded-budget");
async function extractPath(path: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "pdf-decoded-budget-child.ts"), path], { env: { ...process.env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  let watchdogFired = false;
  const timer = setTimeout(() => { watchdogFired = true; child.kill(); }, 25000);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  // 看门狗只兜底，不放宽：触发时直接说明是子进程超时，不只报退出码 143。
  if (watchdogFired) throw new Error(`PDF 解析子进程超过 25 秒，被测试看门狗终止（exit ${exit}）`);
  if (process.env.PDF_BUDGET_EVIDENCE_DIR) {
    const directory = process.env.PDF_BUDGET_EVIDENCE_DIR; mkdirSync(directory, { recursive: true });
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const mode = extraEnv.PDF_TEST_WORKER ? "instrumented" : extraEnv.PDF_OLD_PORT === "yes" ? "upstream-port" : extraEnv.PDF_SILENT_PORT === "yes" ? extraEnv.PDF_WRAPPER === "yes" ? "silent-wrapper" : "silent-port" : "product";
    writeFileSync(join(directory, `${hash}-${extraEnv.PDF_NATIVE ?? "default"}-${extraEnv.PDF_PORT ?? "fake"}-${extraEnv.PDF_OLD_WORKER ?? "fresh"}-${mode}.json`), JSON.stringify({ childPid: child.pid, exit, inputBytes: readFileSync(path).length, inputSha256: hash, stdout, stderr }, null, 2));
  }
  expect(exit).toBe(0); expect(stderr.split("\n").every(line => !line || line.startsWith("Warning:"))).toBe(true);
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result.attempts).toEqual([]);
  expect(result.nativeCalls).toBe(0);
  expect(result.inputSha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  return { ...result, stderr };
}
const extract = (name: string, env?: Record<string, string>) => extractPath(join(fixtures, name), env);
async function synthetic(options: Parameters<typeof pdfBudgetFixture>[0]) {
  const scratch = mkdtempSync(join(tmpdir(), "voice-pdf-budget-fixture-"));
  try { const path = join(scratch, "synthetic.pdf"); writeFileSync(path, pdfBudgetFixture(options)); return await extractPath(path); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
for (const native of ["present", "missing"]) {
  test(`ordinary PDF extracts with native ${native}`, async () => {
    const result = await extract("ordinary.pdf", { PDF_NATIVE: native });
    expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
  }, 30000);
  test(`same-byte high ratio PDF rejects before native ${native}`, async () => {
    const result = await extract("high-whitespace-18mib.pdf", { PDF_NATIVE: native });
    expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  }, 30000);
}
test("an already cached upstream fake worker fails closed", async () => {
  expect((await extract("ordinary.pdf", { PDF_OLD_WORKER: "yes" })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE");
}, 30000);
test("the supplied real Bun Worker port loads the controlled worker and enforces the budget", async () => {
  for (const name of ["ordinary.pdf", "high-whitespace-18mib.pdf"]) {
    const result = await extract(name, { PDF_PORT: "yes" });
    expect(result.code).toBe(name === "ordinary.pdf" ? null : "VOICE_ATTACHMENT_DOCUMENT_LIMIT");
    expect(result.portStats).toEqual({ attempts: [], nativeCalls: 0 });
  }
}, 60000);
test("an actual upstream Bun Worker reports an unavailable policy handshake", async () => {
  const result = await extract("ordinary.pdf", { PDF_PORT: "yes", PDF_OLD_PORT: "yes" });
  expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE"); expect(result.workerMode).toBe("upstream-port"); expect(result.elapsedMs).toBeLessThan(5000);
}, 30000);
test("AbortSignal interrupts a silent real Worker during its policy handshake", async () => {
  const result = await extract("ordinary.pdf", { PDF_PORT: "yes", PDF_SILENT_PORT: "yes", PDF_CANCEL_HANDSHAKE: "yes" });
  expect(result.code).toBe("AbortError"); expect(result.elapsedMs).toBeLessThan(5000);
}, 30000);
test("a silent handshake shares the wrapper's existing whole-document 20 second timeout", async () => {
  const result = await extract("ordinary.pdf", { PDF_WRAPPER: "yes", PDF_SILENT_PORT: "yes" });
  expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_TIMEOUT"); expect(result.wrapperTerminations).toBeGreaterThan(0);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(19500); expect(result.elapsedMs).toBeLessThan(24000);
}, 30000);
test("the whole-document timeout terminates a Worker stuck in synchronous parsing", async () => {
  // 测试 Worker 在 GetDocRequest 里同步死循环：主线程 20 秒整份时限照样能 terminate 它。
  const result = await extract("ordinary.pdf", { PDF_WRAPPER: "yes", PDF_BUSY_PORT: "yes" });
  expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_TIMEOUT"); expect(result.wrapperTerminations).toBeGreaterThan(0);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(19500); expect(result.elapsedMs).toBeLessThan(24000);
}, 30000);
for (const filter of ["FlateDecode", "LZWDecode", "RunLengthDecode", "ASCII85Decode", "ASCIIHexDecode"]) test(`${filter} preserves supported brief text`, async () => {
  const result = await synthetic({ filter }); expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
}, 30000);
for (const predictor of ["png", "tiff"] as const) test(`${predictor} predictor preserves supported text`, async () => {
  const result = await synthetic({ predictor }); expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
}, 30000);
test("100 brief pages stay below the cumulative decoded capacity budget", async () => {
  const result = await synthetic({ pages: 100 }); expect(result.code).toBeNull(); expect(JSON.parse(result.content).pages.length).toBe(100);
}, 30000);
test("page cleanup does not refund cumulative decoded capacity", async () => {
  expect((await synthetic({ pages: 10, padding: 1200000 })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
}, 30000);
test("individually smaller streams cannot evade the document and sequence copy budget", async () => {
  expect((await synthetic({ multi: true, padding: 5 * 1024 * 1024 })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
}, 30000);
test("font ToUnicode decoding cannot recover an over-budget stream as partial success", async () => {
  const result = await synthetic({ toUnicodePadding: 18 * 1024 * 1024 });
  expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
  // #1312：超预算必须立即失败——不能在接近上限时逐块重新分配拷贝十几秒，也不能被 CMap 解析当成坏数据吞掉后继续读流。
  expect(result.elapsedMs).toBeLessThan(5000);
  expect(result.stderr).not.toContain("Invalid cMap data: Error: VOICE_PDF_DECODE_BUDGET_EXCEEDED");
}, 30000);
test("an in-budget ToUnicode stream after other decoded streams stays fast", async () => {
  // 大流排在字形流、内容流之后，加倍放不进剩余预算；预算内也不能退化成逐块拷贝。
  const result = await synthetic({ toUnicodePadding: 14 * 1024 * 1024 });
  expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
  expect(result.elapsedMs).toBeLessThan(5000);
}, 30000);
test("compressed object and xref streams retain their document budget", async () => {
  const result = await synthetic({ objectStream: true }); expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
}, 30000);
test("compressed object stream cannot bypass the allocation budget", async () => {
  expect((await synthetic({ objectStream: true, objectPadding: 18 * 1024 * 1024 })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
}, 30000);
test("xref stream decoding fails before allocating past the budget", async () => {
  expect((await synthetic({ xrefWide: true })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
}, 30000);
test("an ignored image does not disable ordinary PDF text support", async () => {
  const result = await synthetic({ image: true }); expect(result.code).toBeNull(); expect(result.content).toContain("SYNTHETIC_BRIEF_MARKER");
}, 30000);
for (const filter of ["BrotliDecode", "UnsupportedSyntheticFilter"]) test(`${filter} fails closed instead of returning partial text`, async () => {
  expect((await synthetic({ filter })).code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT");
}, 30000);
test("supported PDF source paths have no unowned decoded allocations", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "voice-pdf-budget-owned-"));
  try {
    const worker = join(scratch, "instrumented.mjs");
    writeFileSync(worker, patchPdfjsDecodedBudget(readFileSync(join(import.meta.dir, "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8")) + PDFJS_BUDGET_TEST_EXPORTS);
    for (const options of [{}, { predictor: "png" }, { predictor: "tiff" }, { objectStream: true }, { image: true }, { pages: 2, multi: true }, { toUnicodePadding: 0 }] as const) {
      const path = join(scratch, "fixture.pdf"); writeFileSync(path, pdfBudgetFixture(options));
      const result = await extractPath(path, { PDF_TEST_WORKER: worker }); expect(result.code).toBeNull(); expect(result.unboundAllocations).toBe(0);
    }
    const result = await extract("high-whitespace-18mib.pdf", { PDF_TEST_WORKER: worker });
    expect(result.code).toBe("VOICE_ATTACHMENT_DOCUMENT_LIMIT"); expect(result.unboundAllocations).toBe(0);
    expect(result.budgetEvents.at(-1)).toMatchObject({ before: 16 * 1024 * 1024, after: 16 * 1024 * 1024, error: "VOICE_PDF_DECODE_BUDGET_EXCEEDED" });
    expect(result.budgetEvents.every((event: { after: number }) => event.after <= 16 * 1024 * 1024)).toBe(true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60000);
test("tracked PDF worker is bound to two identical generations from pinned source", async () => {
  const path = join(import.meta.dir, "../assets/document-extraction/pdfjs/pdf.worker.mjs");
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"), initial = hash();
  for (let index = 0; index < 2; index++) {
    const child = Bun.spawn([process.execPath, "run", "prepare:documents"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [exit, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0); expect(stderr).not.toContain("error:"); expect(hash()).toBe(initial);
  }
}, 30000);
