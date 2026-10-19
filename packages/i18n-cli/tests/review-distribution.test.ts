import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { distributionFiles, verifyReviewDistribution } from "../src/review-distribution";

const roots: string[] = [];
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const specs = [["app-contract", "contract"], ["app-sdk", "sdk"], ["app-test", "test-kit"], ["app-cli", "cli"], ["app-i18n-cli", "i18n-cli"]] as const;

function inventory(root: string): Record<string, string> {
  const files: [string, string][] = [];
  function visit(prefix = "") {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      if (name === "node_modules") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (name.includes(".")) files.push([path, sha(readFileSync(join(root, path)))]);
      else visit(path);
    }
  }
  visit(); return Object.fromEntries(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function archive(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    const h = Buffer.alloc(512); h.write(`package/${path}`);
    h.write("0000644\0", 100); h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    h.fill(32, 148, 156); h[156] = 48; h.write("ustar\0", 257);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "review-distribution-test-"))); roots.push(parent);
  const repo = join(parent, "repository"), app = join(parent, "consumer"), packs = join(parent, "packs");
  mkdirSync(repo); mkdirSync(packs); mkdirSync(join(app, "node_modules/@reai"), { recursive: true });
  const artifacts: any[] = [];
  for (const [slug, directory] of specs) {
    const source = join(repo, "packages", directory), installed = join(app, "node_modules/@reai", slug);
    mkdirSync(join(source, "src"), { recursive: true });
    const exports = slug === "app-contract" ? { "./host-support-matrix.json": "./host-support-matrix.json" }
      : slug === "app-sdk" || slug === "app-test" ? { "./v1": "./src/index.ts" } : { ".": "./src/index.ts" };
    const manifest = { name: `@reai/${slug}`, version: "1.0.0", type: "module", exports,
      dependencies: slug === "app-i18n-cli" ? { "@reai/app-cli": "1.0.0" } : {} };
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(source, "src/index.ts"), "export {};\n");
    if (slug === "app-contract") writeFileSync(join(source, "host-support-matrix.json"), "{}\n");
    cpSync(source, installed, { recursive: true });
    const files = inventory(source), tar = archive(Object.fromEntries(Object.keys(files).map(p => [p, readFileSync(join(source, p))])));
    writeFileSync(join(packs, `${slug}.tgz`), tar);
    artifacts.push({ name: manifest.name, version: manifest.version, file: `packs/${slug}.tgz`, bytes: tar.length, sha256: sha(tar),
      sourceFiles: Object.fromEntries(Object.entries(files).map(([path, hash]) => [`packages/${directory}/${path}`, hash])) });
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
  };
  git("init", "-q"); git("add", "packages");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic distribution fixture");
  // This receipt belongs only to this disposable Git fixture and grants no authority.
  const receipt = { schemaVersion: 1, state: "LOCAL_TOOLCHAIN_VERIFIED", sourceHead: git("rev-parse", "HEAD"), sourceDirty: false,
    bunVersion: Bun.version, compatibilityPolicy: null, runtimeGrant: false, platformApproval: false, published: false, artifacts };
  const path = join(parent, "toolchain.json");
  const save = () => writeFileSync(path, JSON.stringify(receipt)); save();
  const packageRoot = (entry: string) => {
    let p = dirname(realpathSync(entry));
    while (!readdirSync(p).includes("package.json")) p = dirname(p);
    return p;
  };
  return { parent, repo, app, packs, receipt, save, path, verify: () => verifyReviewDistribution(path, app, repo, inventory, packageRoot) };
}

test("fixed tarballs bind committed source, exact installed files and one transitive instance", () => {
  const h = fixture(), result = h.verify();
  expect(Object.keys(result.files)).toHaveLength(5);
  expect(result.receiptSha256).toBe(sha(readFileSync(h.path)));
  expect(result.files["@reai/app-i18n-cli"]?.["src/index.ts"]).toBe(sha("export {};\n"));
  expect(JSON.stringify(result)).not.toContain("SOURCE_REVIEW_SCOPE");
});

test.each(["head", "dirty-claim", "bun", "authority", "duplicate", "tarball-sha", "source-inventory", "version", "path",
  "installed-change", "installed-extra", "source-change", "nested-instance", "symlink"])("distribution rejects %s", mode => {
  const h = fixture(), a = h.receipt.artifacts[4];
  if (mode === "head") h.receipt.sourceHead = "a".repeat(40);
  if (mode === "dirty-claim") h.receipt.sourceDirty = true;
  if (mode === "bun") h.receipt.bunVersion = "0.0.0";
  if (mode === "authority") h.receipt.runtimeGrant = true;
  if (mode === "duplicate") h.receipt.artifacts[0] = a;
  if (mode === "tarball-sha") writeFileSync(join(h.packs, "app-i18n-cli.tgz"), "altered");
  if (mode === "source-inventory") delete a.sourceFiles["packages/i18n-cli/src/index.ts"];
  if (mode === "version") a.version = "99.0.0";
  if (mode === "path") a.file = "../app-i18n-cli.tgz";
  if (mode === "installed-change") writeFileSync(join(h.app, "node_modules/@reai/app-i18n-cli/src/index.ts"), "changed");
  if (mode === "installed-extra") writeFileSync(join(h.app, "node_modules/@reai/app-i18n-cli/extra.ts"), "extra");
  if (mode === "source-change") writeFileSync(join(h.repo, "packages/i18n-cli/src/index.ts"), "changed");
  if (mode === "nested-instance") {
    const nested = join(h.app, "node_modules/@reai/app-i18n-cli/node_modules/@reai/app-cli");
    mkdirSync(dirname(nested), { recursive: true }); cpSync(join(h.app, "node_modules/@reai/app-cli"), nested, { recursive: true });
  }
  if (mode === "symlink") {
    const path = join(h.packs, "app-i18n-cli.tgz"), alias = path + ".alias";
    cpSync(path, alias); rmSync(path); symlinkSync(alias, path);
  }
  h.save(); expect(h.verify).toThrow();
});

test("distribution tar rejects unsafe paths and malformed archives", () => {
  expect(() => distributionFiles(archive({ "../escape": Buffer.from("x") }))).toThrow();
  expect(() => distributionFiles(gzipSync(Buffer.from("not a tar")))).toThrow();
  expect(distributionFiles(archive({ "src/index.ts": Buffer.from("content") }))).toEqual({ "src/index.ts": sha("content") });
});
