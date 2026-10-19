#!/usr/bin/env bun

/**
 * Verify that the public plugin toolchain works from packed artifacts only.
 *
 * This deliberately leaves the repository before installation. A green local
 * workspace is not enough: third-party developers receive packages, not this
 * monorepo's relative paths or workspace links.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { assertPortableManifest, assertPackEntries, assertInstalledToolchain, notificationProviderCompatibility, toolchainPackages, type PackageManifest } from "../packages/cli/src/toolchain-verification";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dir, "..");
const platformRoot = join(repositoryRoot, "packages");

const packages = toolchainPackages;
const versions = new Map<string, string>(packages.map(spec => [spec.packageName, JSON.parse(readFileSync(join(platformRoot, spec.directory, "package.json"), "utf8")).version as string]));
const compatibility = versions.get("@reai/app-contract") === "1.25.1-notification-provider.1" ? notificationProviderCompatibility : undefined;
const packedManifests: PackageManifest[] = [];
const retainedIndex = process.argv.indexOf("--out");
const retainedRoot = retainedIndex < 0 ? undefined : process.argv[retainedIndex + 1];
if (retainedIndex >= 0 && (!retainedRoot || retainedRoot.startsWith("--"))) throw new Error("--out requires a new bundle directory");
if (retainedRoot && existsSync(resolve(retainedRoot))) throw new Error("--out bundle directory already exists");
// SOURCE evidence rejects symlink ancestors; macOS /var aliases /private/var.
const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "reai-platform-pack-")));
const packRoot = join(temporaryRoot, "packs");
const consumerRoot = join(temporaryRoot, "external-consumer");
const fixtureRoot = join(consumerRoot, "app");

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${rendered}`);
  }
  return result.stdout.trim();
}

function tarballManifest(tarball: string): Record<string, unknown> {
  const raw = run("tar", ["-xOf", tarball, "package/package.json"], temporaryRoot);
  return JSON.parse(raw) as Record<string, unknown>;
}

try {
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  for (const spec of packages) {
    run(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--filename", join(packRoot, spec.filename)],
      join(platformRoot, spec.directory),
    );
    const tarball = join(packRoot, spec.filename);
    if (!existsSync(tarball)) throw new Error(`missing packed artifact ${tarball}`);
    const manifest = tarballManifest(tarball) as unknown as PackageManifest;
    assertPortableManifest(spec.packageName, manifest, versions, compatibility);
    packedManifests.push(manifest);
    if (spec.directory === "i18n-cli" && (tarballManifest(tarball).dependencies as Record<string, unknown>).fflate !== "0.8.3") {
      throw new Error("modern CLI tarball must pin fflate 0.8.3");
    }
    assertPackEntries(spec.packageName, run("tar", ["-tzf", tarball], temporaryRoot).split("\n"));
  }

  const dependencies = Object.fromEntries(
    packages.map((spec) => [spec.packageName, `file:../packs/${spec.filename}`]),
  );
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "reai-platform-external-verification",
      private: true,
      type: "module",
      dependencies,
      devDependencies: { typescript: "5.6.3", "@types/bun": "1.4.0" },
      // Until the packages are available from a registry, force every
      // transitive exact-semver edge to the same packed artifacts.
      overrides: dependencies,
    }, null, 2)}\n`,
  );

  cpSync(join(platformRoot, "fixtures", "apps", "minimal"), fixtureRoot, {
    recursive: true,
    filter: (source) => !["node_modules", "dist", "bun.lock", "build-manifest.json"].includes(basename(source)),
  });

  // New app identity, with no inherited grant or source approval.
  const appId = "com.synthetic.v105.toolchain";
  for (const file of ["app.manifest.json", "src/app.ts", "tests/contract.suite.ts"]) {
    const path = join(fixtureRoot, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("com.example.minimal", appId));
  }
  writeFileSync(join(fixtureRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
    noEmit: true, skipLibCheck: true, resolveJsonModule: true, types: ["bun"],
  }, include: ["src", "tests"] }));
  writeFileSync(join(fixtureRoot, "tests/development.test.ts"), `
import { expect, test } from "bun:test";
import { MockHost, flush } from "@reai/app-test/v1";
import app from "../src/app";
import manifest from "../app.manifest.json";
test("fresh app identity runs lifecycle, command, storage and surface contracts", async () => {
  const host = new MockHost({ manifest, loadApp: async () => ({ default: app }) });
  try {
    await host.installAndEnable(); await flush();
    const result = await host.invokeCommand(manifest.appId + ".ping");
    expect(result.ok).toBe(true);
    expect(host.storageKeys()).toContain(manifest.appId + "/notes/last-ping");
    expect((await host.openSurface("main")).readyCount).toBe(1);
  } finally { await host.disable(); }
  expect(host.networkRequests).toEqual([]);
});
`);

  run("bun", ["install"], consumerRoot);
  run("bun", ["install", "--frozen-lockfile"], consumerRoot);
  assertInstalledToolchain(consumerRoot, packedManifests);

  // Exercise SDK staging using only installed public tarballs. No network request is sent.
  const uploadFixture = join(consumerRoot, "http-upload.ts");
  writeFileSync(uploadFixture, `
import { strict as assert } from "node:assert";
import { brokerFetch } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
const bytes = new Uint8Array(512 * 1024 + 1).map((_, i) => i % 251);
const sha = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
let received = "";
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => { throw new Error("Unexpected network request"); }, { preconnect: originalFetch.preconnect });
try {
  const host = new MockHost({
    manifest: { appId: "com.synthetic.packed-upload", permissions: [{ id: "http.fetch@1" }],
      network: { endpoints: [{ id: "fixture", origins: ["https://synthetic.invalid"], pathPrefixes: ["/upload"], methods: ["POST"] }] } },
    loadApp: async () => ({ default: {} }),
    networkHandler: async ({ body }) => { received = sha(new Uint8Array(await body.arrayBuffer())); return { status: 201 }; },
  });
  const response = await brokerFetch(host.bridge, "https://synthetic.invalid/upload", { method: "POST", endpointId: "fixture", body: bytes });
  assert.equal(response.status, 201);
  assert.equal(received, sha(bytes));
  assert.equal(host.networkRequests.length, 1);
  assert.equal(host.networkRequests[0]?.bodyBytes, bytes.byteLength);
  assert.equal("bodyBase64" in host.networkRequests[0]!, false);
  console.log("✓ packed SDK + MockHost staged upload and full SHA");
} finally { globalThis.fetch = originalFetch; }
`);
  console.log(run("bun", ["--no-env-file", uploadFixture], consumerRoot));

  const installedCli = join(consumerRoot, "node_modules", "@reai", "app-cli", "package.json");
  if (!existsSync(installedCli)) throw new Error("packed @reai/app-cli was not installed");
  const runCli = (args: string[]) => run(
    "bun",
    ["x", "--no-install", "-p", "@reai/app-cli", "reai-app", ...args],
    consumerRoot,
  );
  if (runCli(["--version"]) !== versions.get("@reai/app-cli")) throw new Error("installed legacy CLI reports the wrong version");
  runCli(["validate", fixtureRoot]);
  run(join(consumerRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", fixtureRoot], consumerRoot);
  console.log(run("bun", ["test", join(fixtureRoot, "tests/development.test.ts")], consumerRoot));
  runCli(["build", fixtureRoot]);
  runCli(["contract-test", fixtureRoot, "--host-api", "1.1"]);

  const appPackage = join(consumerRoot, "minimal.reaiapp");
  runCli(["pack", fixtureRoot, "--out", appPackage]);
  if (!existsSync(appPackage) || readFileSync(appPackage).byteLength === 0) {
    throw new Error("external reai-app pack did not produce a non-empty archive");
  }

  const repeatedAppPackage = join(consumerRoot, "minimal-repeat.reaiapp");
  runCli(["pack", fixtureRoot, "--out", repeatedAppPackage]);
  if (!readFileSync(appPackage).equals(readFileSync(repeatedAppPackage))) throw new Error("fresh app legacy CLI pack is not deterministic");
  console.log(`✓ fresh ${appId}: validate/typecheck/test/build/contract/pack sha256=${sha256(readFileSync(appPackage))}`);

  const manifestPath = join(fixtureRoot, "app.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const definitions = JSON.parse(readFileSync(join(platformRoot, "contract/i18n-targets.json"), "utf8"));
  const references: Array<{target:string;id?:string;key:string}> = [];
  for (const definition of definitions) {
    if (definition.version === 2) continue; // This fixture deliberately exercises unchanged v1 compatibility.
    const owners = definition.collection ? manifest.contributes[definition.collection] ?? []
      : [definition.singleton ? manifest.contributes[definition.singleton] : manifest];
    for (const owner of owners) if (typeof owner?.[definition.field] === "string") {
      references.push({ target:definition.target, ...(definition.collection ? {id:owner.id} : {}), key:`metadata.key${references.length}` });
    }
  }
  manifest.requires.hostCapabilities.push("metadata.i18n@1");
  manifest.i18n = {locales:["zh","en"],messages:references};
  writeFileSync(manifestPath,JSON.stringify(manifest));
  mkdirSync(join(fixtureRoot,"assets/locales"),{recursive:true});
  for (const locale of ["zh","en"]) writeFileSync(join(fixtureRoot,`assets/locales/${locale}.json`),JSON.stringify({metadata:Object.fromEntries(references.map((_,i)=>[`key${i}`,`Label ${i}`]))}));
  const runI18n = (args:string[]) => run("bun",["x","--no-install","-p","@reai/app-i18n-cli","reai-app-i18n",...args],consumerRoot);
  if (runI18n(["--version"]) !== versions.get("@reai/app-i18n-cli")) throw new Error("installed i18n CLI reports the wrong version");
  runI18n(["validate",fixtureRoot]);
  runI18n(["build",fixtureRoot]);
  runI18n(["pack",fixtureRoot,"--out",join(consumerRoot,"localized.reaiapp")]);
  const deflatePackage = join(consumerRoot,"localized-deflate.reaiapp"), repeatedPackage = join(consumerRoot,"localized-deflate-repeat.reaiapp");
  runI18n(["pack",fixtureRoot,"--out",deflatePackage,"--compression","deflate"]);
  runI18n(["pack",fixtureRoot,"--out",repeatedPackage,"--compression","deflate"]);
  if (!readFileSync(deflatePackage).equals(readFileSync(repeatedPackage))) throw new Error("installed Deflate pack is not deterministic");
  writeFileSync(join(consumerRoot,"verify-compression.ts"), `
import { readFileSync } from "node:fs";
import { packedFiles, verifyPackagedResources } from "@reai/app-i18n-cli";
const [store,deflate] = process.argv.slice(2).map(path=>packedFiles(readFileSync(path)));
verifyPackagedResources(deflate);
if(store.size!==deflate.size || [...store].some(([path,bytes])=>!Buffer.from(bytes).equals(Buffer.from(deflate.get(path)??[])))) throw Error("installed resources differ");
`);
  run("bun",["verify-compression.ts",join(consumerRoot,"localized.reaiapp"),deflatePackage],consumerRoot);

  // Installing this toolchain cannot grant a fresh identity a privileged capability.
  const reviewedManifestBytes = readFileSync(manifestPath);
  const unapproved = structuredClone(manifest);
  unapproved.requires.hostCapabilities.push("surface.clipboard@1");
  writeFileSync(manifestPath, JSON.stringify(unapproved));
  try {
    for (const command of ["validate", "build", "pack"]) {
      const args = ["x", "--no-install", "-p", "@reai/app-i18n-cli", "reai-app-i18n", command, fixtureRoot];
      if (command === "pack") args.push("--out", join(consumerRoot, "unapproved.reaiapp"));
      const result = spawnSync("bun", args, { cwd: consumerRoot, encoding: "utf8" });
      if (result.status !== 1 || !result.stderr.includes("APP_CAPABILITY_NOT_GRANTED")) throw new Error(`packed ${command} bypassed SOURCE approval: ${result.stderr}`);
    }
    const missingEvidence = spawnSync("bun", ["x", "--no-install", "-p", "@reai/app-i18n-cli", "reai-app-i18n", "validate", fixtureRoot, "--source-review", join(consumerRoot, "missing-evidence.json")], { cwd: consumerRoot, encoding: "utf8" });
    if (missingEvidence.status !== 1 || !missingEvidence.stderr.includes("ENOENT") || !missingEvidence.stderr.includes("missing-evidence.json")) throw new Error(`missing SOURCE evidence did not report its missing file (status ${missingEvidence.status}): ${missingEvidence.stderr}`);
    const invalidEvidence = join(consumerRoot, "invalid-evidence.json");
    writeFileSync(invalidEvidence, "{}");
    for (const command of ["validate", "build", "pack"]) {
      const output = join(consumerRoot, "invalid-source.reaiapp");
      const args = ["x", "--no-install", "-p", "@reai/app-i18n-cli", "reai-app-i18n", command, fixtureRoot, "--source-review", invalidEvidence];
      if (command === "pack") args.push("--out", output);
      const result = spawnSync("bun", args, { cwd: consumerRoot, encoding: "utf8" });
      if (result.status !== 1 || !result.stderr.includes("APP_CAPABILITY_NOT_GRANTED") || !result.stderr.includes("MANIFEST_REFERENCE_INVALID") || !result.stderr.includes("sourceReview") || existsSync(output)) throw new Error(`invalid SOURCE evidence bypassed ${command}: ${result.stderr}`);
    }
  } finally { writeFileSync(manifestPath, reviewedManifestBytes); }

  // A frozen file consumer may lack the new encoder. STORE and decoding must
  // remain usable; explicit Deflate must reject a missing or wrong codec.
  writeFileSync(join(consumerRoot, "resolve-codec.ts"), [
    'import { createRequire } from "node:module";',
    'import { dirname, join } from "node:path";',
    'import { realpathSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    'const installed = createRequire(import.meta.url);',
    'const archive = realpathSync(join(dirname(installed.resolve("@reai/app-i18n-cli")), "archive.ts"));',
    'const codec = createRequire(pathToFileURL(archive));',
    'if (process.argv[2] === "missing") {',
    '  let missing = false;',
    '  try { codec.resolve("fflate/package.json"); } catch { missing = true; }',
    '  if (!missing) throw Error("encoder still resolves from installed archive");',
    '  console.log("missing");',
    '} else {',
    '  console.log(JSON.stringify({archive, metadata:realpathSync(codec.resolve("fflate/package.json")), cli:realpathSync(join(dirname(archive),"cli.ts"))}));',
    '}',
  ].join("\n"));
  const installed = JSON.parse(run("bun", ["resolve-codec.ts"], consumerRoot)) as {
    archive: string; metadata: string; cli: string;
  };
  const realConsumer = realpathSync(consumerRoot), realRepository = realpathSync(repositoryRoot);
  if (realConsumer === realRepository || realConsumer.startsWith(realRepository + sep)) {
    throw new Error("encoder isolation consumer must be outside the repository");
  }
  for (const path of [installed.archive, installed.metadata, installed.cli]) {
    if (!path.startsWith(realConsumer + sep)) throw new Error("encoder isolation resolved outside its consumer: " + path);
  }
  writeFileSync(join(consumerRoot, "verify-codec-rejection.ts"), [
    'import { PackError } from "@reai/app-cli";',
    'import { pathToFileURL } from "node:url";',
    'const archive = await import(pathToFileURL(process.argv[2]).href);',
    'try {',
    '  archive.writePackageZip([{path:"app.manifest.json",bytes:Buffer.from("{}")}],"deflate",{packageMaxCompressionRatio:100});',
    '} catch (error) {',
    '  if (!(error instanceof PackError) || !error.message.includes(process.argv[3])) throw error;',
    '  console.log("specific PackError");',
    '  process.exit(0);',
    '}',
    'throw Error("explicit Deflate accepted an invalid encoder");',
  ].join("\n"));
  const isolationFailures: string[] = [];
  const checkIsolation = (label: string, check: () => void) => {
    try { check(); } catch (error) { isolationFailures.push(label + ": " + String(error)); }
  };
  const originalStore = readFileSync(join(consumerRoot, "localized.reaiapp"));
  const checkCodecState = (label: string, expectedError: string) => {
    for (const command of ["--version", "validate", "build"]) {
      checkIsolation(label + " " + command, () => run("bun",
        [installed.cli, command, ...(command === "--version" ? [] : [fixtureRoot])], consumerRoot));
    }
    const store = join(consumerRoot, "localized-" + label + ".reaiapp");
    checkIsolation(label + " STORE bytes", () => {
      run("bun", [installed.cli, "pack", fixtureRoot, "--out", store], consumerRoot);
      if (!readFileSync(store).equals(originalStore)) throw new Error("default STORE archive bytes changed");
    });
    checkIsolation(label + " STORE/Deflate decoding", () =>
      run("bun", ["verify-compression.ts", join(consumerRoot, "localized.reaiapp"), deflatePackage], consumerRoot));
    checkIsolation(label + " Deflate CLI rejection", () => {
      const result = spawnSync("bun",
        [installed.cli, "pack", fixtureRoot, "--out", join(consumerRoot, "invalid-" + label + ".reaiapp"), "--compression", "deflate"],
        { cwd: consumerRoot, encoding: "utf8" });
      if (result.status !== 1 || !result.stderr.includes(expectedError)) {
        throw new Error("expected specific Deflate failure; status=" + result.status + ", stderr=" + result.stderr);
      }
    });
    checkIsolation(label + " Deflate PackError", () =>
      run("bun", ["verify-codec-rejection.ts", installed.archive, expectedError], consumerRoot));
  };
  const originalCodecMetadata = readFileSync(installed.metadata);
  const backupMetadata = installed.metadata + ".probe-original";
  const privateMetadata = installed.metadata + ".probe-private";
  if (existsSync(backupMetadata) || existsSync(privateMetadata)) throw new Error("encoder probe backup collision");
  renameSync(installed.metadata, backupMetadata);
  try {
    // A new inode prevents writes through a hardlink into Bun's shared cache.
    writeFileSync(privateMetadata, JSON.stringify({
      ...JSON.parse(originalCodecMetadata.toString("utf8")), version: "9.9.9",
    }), { flag: "wx" });
    renameSync(privateMetadata, installed.metadata);
    checkCodecState("wrong-version", "Deflate requires fflate 0.8.3; found 9.9.9");
  } finally {
    rmSync(installed.metadata, { force: true });
    rmSync(privateMetadata, { force: true });
    renameSync(backupMetadata, installed.metadata);
  }
  const codecRoot = dirname(installed.metadata), hiddenCodecRoot = codecRoot + ".probe-missing";
  if (existsSync(hiddenCodecRoot)) throw new Error("encoder probe directory collision");
  renameSync(codecRoot, hiddenCodecRoot);
  try {
    if (run("bun", ["resolve-codec.ts", "missing"], consumerRoot) !== "missing") {
      throw new Error("installed archive must not resolve a hidden encoder");
    }
    checkCodecState("missing", "Deflate requires fflate 0.8.3; dependency missing");
  } finally {
    renameSync(hiddenCodecRoot, codecRoot);
  }
  if (!readFileSync(installed.metadata).equals(originalCodecMetadata)) throw new Error("encoder metadata was not restored");
  if (isolationFailures.length) throw new Error("Encoder isolation regressions:\n" + isolationFailures.join("\n"));

  // Host 1.20 validation must survive installation from public tarballs, without
  // changing the legacy CLI source pinned by approved packages.
  manifest.hostApi.range = ">=1.21.0 <2.0.0";
  manifest.requires.hostCapabilities.push("apps.gateway@1", "apps.service@1");
  manifest.permissions.push({ id: "apps.gateway@1", purpose: "Local test client", required: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  runI18n(["validate", fixtureRoot]);
  runI18n(["build", fixtureRoot]);
  runI18n(["pack", fixtureRoot, "--out", join(consumerRoot, "gateway.reaiapp")]);
  for (const missing of ["permission", "capability", "service"]) {
    const invalid = structuredClone(manifest);
    if (missing === "permission") invalid.permissions = invalid.permissions.filter((p: { id: string }) => p.id !== "apps.gateway@1");
    else invalid.requires.hostCapabilities = invalid.requires.hostCapabilities.filter((id: string) => id !== (missing === "capability" ? "apps.gateway@1" : "apps.service@1"));
    writeFileSync(manifestPath, JSON.stringify(invalid));
    for (const command of ["validate", "build", "pack"]) {
      const args = ["x", "--no-install", "-p", "@reai/app-i18n-cli", "reai-app-i18n", command, fixtureRoot];
      if (command === "pack") args.push("--out", join(consumerRoot, "invalid-gateway.reaiapp"));
      const result = spawnSync("bun", args, { cwd: consumerRoot, encoding: "utf8" });
      if (result.status !== 1 || !result.stderr.includes("MANIFEST_REFERENCE_INVALID")) {
        throw new Error(`Packed gateway ${command} did not reject missing ${missing}: ${result.stderr}`);
      }
    }
  }

  const artifacts = packages.map(spec => {
    const tarball = join(packRoot, spec.filename), bytes = readFileSync(tarball);
    const sourceFiles = Object.fromEntries(run("tar", ["-tzf", tarball], temporaryRoot).split("\n")
      .filter(entry => !entry.endsWith("/"))
      .map(entry => ["packages/" + spec.directory + "/" + entry.slice("package/".length), sha256(readFileSync(join(platformRoot, spec.directory, entry.slice("package/".length))))]));
    return { name: spec.packageName, version: versions.get(spec.packageName), file: `packs/${spec.filename}`, bytes: bytes.byteLength, sha256: sha256(bytes), sourceFiles };
  });
  const receipt = { schemaVersion: 1, state: "LOCAL_TOOLCHAIN_VERIFIED", sourceHead: run("git", ["rev-parse", "HEAD"], repositoryRoot),
    sourceDirty: run("git", ["status", "--porcelain", "--", "packages", "scripts/verify-platform-packages.ts", "scripts/verify-official-plugins.ts", "scripts/verify-plugin-examples.ts", "scripts/source-review-bytes.ts"], repositoryRoot).length > 0,
    bunVersion: run("bun", ["--version"], consumerRoot), artifacts,
    compatibilityPolicy: compatibility ?? null,
    frozenDeclaredEdges: compatibility ? packedManifests
      .filter(manifest => manifest.name === "@reai/app-sdk" || manifest.name === "@reai/app-test")
      .map(manifest => ({ package: manifest.name, packageVersion: manifest.version,
        field: "dependencies", dependency: "@reai/app-contract", declaredPin: manifest.dependencies?.["@reai/app-contract"],
        selectedVersion: versions.get("@reai/app-contract") })) : [],
    installedResolution: "strict direct/transitive selected versions and one realpath-confined instance; explicit relative tarball overrides",
    consumerLockSha256: sha256(readFileSync(join(consumerRoot, "bun.lock"))),
    app: { appId, version: "1.0.0", sha256: sha256(readFileSync(appPackage)) },
    runtimeGrant: false, platformApproval: false, published: false };
  if (retainedRoot) {
    const output = resolve(retainedRoot);
    mkdirSync(output); // Exclusive creation; never overwrite another bundle.
    try {
      cpSync(packRoot, join(output, "packs"), { recursive: true });
      mkdirSync(join(output, "consumer"));
      for (const file of ["package.json", "bun.lock"]) cpSync(join(consumerRoot, file), join(output, "consumer", file));
      run("bun", ["install", "--frozen-lockfile"], join(output, "consumer"));
      assertInstalledToolchain(join(output, "consumer"), packedManifests);
      rmSync(join(output, "consumer/node_modules"), { recursive: true, force: true });
      writeFileSync(join(output, "toolchain.json"), JSON.stringify(receipt, null, 2) + "\n");
      console.log(`✓ retained portable toolchain ${output}`);
    } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  }
  console.log(JSON.stringify({ ...receipt, artifacts: artifacts.map(({ sourceFiles, ...artifact }) => artifact) }));

  console.log(`✓ platform tarballs installed and exercised outside the repository (${packages.length} packages)`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
