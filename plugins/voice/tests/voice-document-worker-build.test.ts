import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// Each build has its own module cache, just like prepare:documents. Tests never
// replace the actual contract or rely on historical Git objects.
const program = `
const { entry, matrix } = JSON.parse(await Bun.stdin.text());
let matrixLoads = 0;
const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true,
  plugins: matrix === undefined ? [] : [{ name: "virtual-matrix-control", setup(builder) {
    builder.onLoad({ filter: /host-support-matrix\\.json$/ }, () => {
      matrixLoads++; return { contents: JSON.stringify(matrix), loader: "json" };
    });
  } }] });
if (!result.success || result.outputs.length !== 1) throw new Error(result.logs.join("\\n"));
console.log(JSON.stringify({ matrixLoads, bytes: Buffer.from(await result.outputs[0].arrayBuffer()).toString("base64") }));
`;

async function build(entry: string, matrix?: unknown): Promise<{ matrixLoads: number; bytes: Buffer }> {
  const child = Bun.spawn([process.execPath, "--eval", program], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ entry, matrix }));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Worker test build failed (${exit}): ${stderr}`);
  const result = JSON.parse(stdout) as { matrixLoads: number; bytes: string };
  return { matrixLoads: result.matrixLoads, bytes: Buffer.from(result.bytes, "base64") };
}

test("worker bytes do not depend on the Host matrix; injection has a positive control", async () => {
  const matrix = JSON.parse(readFileSync(Bun.resolveSync("@reai/app-contract/host-support-matrix.json", root), "utf8"));
  const markers = ["R01_SYNTHETIC_MATRIX_FIRST", "R01_SYNTHETIC_MATRIX_SECOND"];
  const variants = markers.map(marker => ({ ...matrix, stableErrors: [...matrix.stableErrors, marker] }));
  const controls = [];
  for (const variant of variants) controls.push(await build("./src/voice-attachment-content.ts", variant));
  for (let index = 0; index < controls.length; index++) {
    expect(controls[index]!.matrixLoads).toBeGreaterThan(0);
    expect(controls[index]!.bytes.toString()).toContain(markers[index]!);
  }
  expect(controls[0]!.bytes.equals(controls[1]!.bytes)).toBe(false);

  const workers = [];
  for (const variant of variants) workers.push(await build("./src/voice-document-worker.ts", variant));
  expect(workers[0]!.bytes.equals(workers[1]!.bytes)).toBe(true);
  for (const worker of workers) {
    expect(worker.matrixLoads).toBe(0);
    for (const marker of markers) expect(worker.bytes.toString()).not.toContain(marker);
  }
}, 30_000);

test("fresh worker build has exactly the prepared asset bytes", async () => {
  const worker = await build("./src/voice-document-worker.ts");
  expect(worker.bytes.equals(readFileSync(resolve(root, "assets/document-extraction/spreadsheet.worker.mjs")))).toBe(true);
}, 30_000);
