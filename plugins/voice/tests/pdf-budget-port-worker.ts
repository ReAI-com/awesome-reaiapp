const attempts: string[] = []; let nativeCalls = 0;
globalThis.fetch = (async (...args: unknown[]) => { attempts.push(String(args[0])); throw new Error("Test network disabled"); }) as unknown as typeof fetch;
Object.defineProperty(globalThis, "DecompressionStream", { value: class { constructor() { nativeCalls++; throw new Error("Native decompression must not run"); } }, configurable: true });
if (process.env.PDF_SILENT_PORT === "yes") { self.onmessage = () => {}; await new Promise(() => {}); }
const path = new URL(process.env.PDF_OLD_PORT === "yes" ? "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs" : "../assets/document-extraction/pdfjs/pdf.worker.mjs", import.meta.url).href;
const { WorkerMessageHandler } = await import(path);
const setup = WorkerMessageHandler.setup;
WorkerMessageHandler.setup = function(handler: any, port: any) {
  handler.on("VoicePdfTestStats", () => ({ attempts, nativeCalls }));
  if (process.env.PDF_BUSY_PORT === "yes") {
    // 握手照常应答，真正开始解析时同步卡死，模拟无法自行退出的解析。
    const on = handler.on.bind(handler);
    handler.on = (name: string, callback: unknown) => on(name, name === "GetDocRequest" ? () => { for (;;) {} } : callback);
  }
  return setup.call(this, handler, port);
};
WorkerMessageHandler.initializeFromPort(self);
