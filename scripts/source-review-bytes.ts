#!/usr/bin/env bun
/** This command creates unapproved review material. It does not install or publish. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { calculateReviewBytes, type ReviewInputPin } from "../packages/i18n-cli/src/review-bytes";
import { parseCompression } from "../packages/i18n-cli/src/archive";

function noSymlinkAncestors(path: string): void {
  let current = path;
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Symlink in review output path");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function runReviewBytes(argv: string[]) {
  const app = argv[0];
  if (!app || app.startsWith("--")) throw new Error("App directory is required");
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag || !["--inputs", "--out", "--expected-bun", "--compression", "--toolchain-receipt"].includes(flag) || !value || value.startsWith("--") || flags.has(flag)) throw new Error("Invalid or duplicate review calculation argument");
    flags.set(flag, value);
  }
  const inputFile = flags.get("--inputs"), output = flags.get("--out"), expectedBun = flags.get("--expected-bun");
  if (!inputFile || !output || !expectedBun) throw new Error("--inputs, --out and --expected-bun are required");
  const compression = parseCompression(flags.get("--compression"));
  const root = realpathSync(resolve(app)), directory = resolve(output);
  noSymlinkAncestors(directory);
  const parent = realpathSync(dirname(directory)), physical = join(parent, basename(directory));
  const path = relative(root, physical);
  if (!path || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))) throw new Error("Review output must be outside the App directory");
  if (existsSync(directory)) throw new Error("Review output directory already exists");
  if (lstatSync(resolve(inputFile)).isSymbolicLink()) throw new Error("Symlink input pin is not allowed");
  const pin = JSON.parse(readFileSync(inputFile, "utf8")) as ReviewInputPin;
  const toolchainReceipt = flags.get("--toolchain-receipt");
  const { archive, calculation } = await calculateReviewBytes(root, pin, expectedBun, { compression, ...(toolchainReceipt ? { toolchainReceipt } : {}) });
  mkdirSync(directory, { mode: 0o700 });
  try {
    writeFileSync(join(directory, "candidate.review-bytes"), archive, { flag: "wx" });
    writeFileSync(join(directory, "calculation.json"), JSON.stringify(calculation, null, 2) + "\n", { flag: "wx" });
  } catch (cause) { rmSync(directory, { recursive: true, force: true }); throw cause; }
  return calculation;
}

if (import.meta.main) {
  try { const result = await runReviewBytes(process.argv.slice(2)); console.log(JSON.stringify({ status: result.status, archiveSha256: result.archiveSha256, bytes: result.bytes, entryCount: result.entryCount, compression: result.compression, runtimeGrant: false, platformApproval: false })); }
  catch (cause) { console.error(String(cause)); process.exitCode = 1; }
}
