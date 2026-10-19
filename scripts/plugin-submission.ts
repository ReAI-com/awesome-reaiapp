/** Local Open Platform submission gate. No upload, review, charge or publish operations. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { packApp, packedFiles, parseCompression, verifyPackagedResources, validateManifest, validateLocaleBytes, readSourceReviewEvidence, type SourceReviewEvidence, type PackOptions } from "../packages/i18n-cli/src/index";

export interface SubmissionIdentity {
  schemaVersion: 1;
  version: string;
  appId: string;
  publisherId: string;
  oauthAppId: string;
  productId: string;
  target: "universal";
}
const identityKeys = ["schemaVersion", "version", "appId", "publisherId", "oauthAppId", "productId", "target"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The official publisher uses the reserved public identity. Other publishers use their team UUID.
const reservedPublisherId = "reai";
// The submission version follows the public semantic version format.
const submissionVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): never => { throw new Error(`SUBMISSION_PREFLIGHT: ${message}`); };
// This submission contract accepts the public metadata.i18n@1 target set.
// Update the contract when the server accepts additional targets.
export const SERVER_I18N_TARGETS = [
  "name", "description", "sidebar.label", "surface.title", "command.title", "command.bindingPickerTitle",
  "titlebarAction.label", "titlebarAction.text", "titlebarStatus.label", "scheduledTask.title", "scheduledTask.description",
] as const;

// Public submission contract: supported probes, reviewable capabilities and contribution fields.
// Historical contracts support local compatibility checks. They do not select a production server.
const PROBE_IDS_1_1_31CF8889 = [
  "codex-app-server-v1", "pi-agent-v1", "dsh-runner-v1", "audio8-helper-v1",
  "codex-app-server-v2", "pi-agent-v2", "dsh-native-v2",
] as const;
const REVIEWABLE_CAPABILITIES_HOST_1_21 = [
  "agent.codex@1", "agent.codex.tasks@1", "agent.local@1", "agent.dsh@1", "agent.session@1", "agent.session@2",
  "agent.pi-management@1", "agent.dsh-observe@1", "activation.startup@1", "voice.input@1", "voice.command@1",
  "voice.recordings@1", "voice.deliver@1", "voice.context@1", "cloud.model.invoke@1", "cloud.workflow.invoke@1",
  "system.folder-pick@1", "local.files@1", "browser.engine@1", "computer.engine@1", "tts.local@1",
  "developer.platform@1", "terminal.session@1", "surface.clipboard@1", "local.terminal.exec@1",
] as const;
// Historical submission contract: additional contribution fields are not accepted.
const CONTRIBUTES_PROPERTIES_1_1_31CF8889 = [
  "surfaces", "services", "titlebarActions", "titlebarStatus", "tabItems", "actionItems",
  "eventSubscriptions", "acceptsActionContext", "sidebarItems", "scheduledTasks", "commands",
  "intents", "recommendedBindings",
] as const;
export interface ServerContract {
  name: string;
  baseline: string;
  backend: "deployed" | "pending-rollout" | "historical";
  probeIds: readonly string[];
  reviewableCapabilities: readonly string[];
  contributesProperties: readonly string[];
}
// 2026-10-15 平台后端上线：
// REAIAPP_MANIFEST_SCHEMA_BASELINE = "1.1@005a0f63-notification-scenes"（contributes 放行 notificationScenes），
// app-capability-review.json 扩到 29 项（新增 audio.capture@1 / audio.clips@1 / surface.escape@1 / resources.files@1）。
// 原 notification-scenes-pending / v105-capabilities-pending 合入 current 并退役。
// tasks.present@1、notifications.publish@1 仍不在可批准表里，不加。
const REVIEWABLE_CAPABILITIES_HOST_1_25_V105 = [
  ...REVIEWABLE_CAPABILITIES_HOST_1_21, "audio.capture@1", "audio.clips@1", "surface.escape@1", "resources.files@1",
] as const;
export const SERVER_CONTRACTS = {
  current: {
    name: "current", baseline: "1.1@005a0f63-notification-scenes", backend: "deployed",
    probeIds: PROBE_IDS_1_1_31CF8889, reviewableCapabilities: REVIEWABLE_CAPABILITIES_HOST_1_25_V105,
    contributesProperties: [...CONTRIBUTES_PROPERTIES_1_1_31CF8889, "agentFeatures", "notificationScenes"],
  },
  "legacy-31cf8889": {
    name: "legacy-31cf8889", baseline: "1.1@31cf8889", backend: "historical",
    probeIds: PROBE_IDS_1_1_31CF8889, reviewableCapabilities: REVIEWABLE_CAPABILITIES_HOST_1_21,
    contributesProperties: CONTRIBUTES_PROPERTIES_1_1_31CF8889,
  },
} as const satisfies Record<string, ServerContract>;
export type ServerContractName = keyof typeof SERVER_CONTRACTS;
/** Contract names that used to be accepted; old command lines fail with the reason instead of a bare "unknown". */
const RETIRED_SERVER_CONTRACTS: Readonly<Record<string, string>> = {
  "notification-scenes-pending": "its baseline 1.1@005a0f63-notification-scenes was deployed on 2026-10-15 and is now current; drop --server-contract",
  "v105-capabilities-pending": "its four reviewable capabilities were deployed on 2026-10-15 and are now in current; drop --server-contract",
  "agent-features-pending": "its baseline 1.1@005a0f63-agent-features was deployed on 2026-10-02 and is now current; drop --server-contract",
  "native-v2-pending": "its baseline 1.1@31cf8889 was deployed on 2026-09-27 is included in the current contract; drop --server-contract",
};
const DEFAULT_SERVER_CONTRACT: ServerContract = SERVER_CONTRACTS.current;
export function serverContract(name: string): ServerContract {
  if (Object.hasOwn(RETIRED_SERVER_CONTRACTS, name)) fail(`--server-contract ${JSON.stringify(name)} is retired: ${RETIRED_SERVER_CONTRACTS[name]}`);
  if (!Object.hasOwn(SERVER_CONTRACTS, name)) fail(`unknown --server-contract ${JSON.stringify(name)}; expected one of ${Object.keys(SERVER_CONTRACTS).join(", ")}`);
  return SERVER_CONTRACTS[name as ServerContractName];
}
/** Capabilities the Host only grants with a platform approval (Driver host-support-matrix grantGated). */
export const HOST_GRANT_GATED: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(join(import.meta.dir, "../packages/contract/host-support-matrix.json"), "utf8")).hostCapabilities.grantGated,
);

export function verifyServerI18nTargets(manifest: Record<string, unknown>, contract: ServerContract = DEFAULT_SERVER_CONTRACT) {
  const declaration = manifest.i18n;
  if (!declaration || typeof declaration !== "object") return;
  const messages = (declaration as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;
  const accepted = new Set<string>(SERVER_I18N_TARGETS);
  messages.forEach((message, index) => {
    const target = message && typeof message === "object" ? (message as { target?: unknown }).target : undefined;
    if (typeof target === "string" && !accepted.has(target))
      fail(`/i18n/messages/${index}/target ${JSON.stringify(target)} is not in the Open Platform manifest contract enum (${contract.baseline}); drop metadata.i18n@2 targets (storeListing.* etc.) and declare metadata.i18n@1 — store listing text is entered in the submission form`);
  });
}

/** Lists vendored field, probe and capability differences in one failure; local full schema checks remain mandatory. */
export function verifyServerContract(manifest: Record<string, unknown>, contract: ServerContract = DEFAULT_SERVER_CONTRACT) {
  const findings: string[] = [];
  const contributes = manifest.contributes && typeof manifest.contributes === "object" && !Array.isArray(manifest.contributes)
    ? manifest.contributes as Record<string, unknown> : {};
  for (const property of Object.keys(contributes)) {
    if (!contract.contributesProperties.includes(property)) {
      const pointer = property.replace(/~/g, "~0").replace(/\//g, "~1");
      findings.push(`/contributes/${pointer} ${JSON.stringify(property)} is not in the vendored schema properties (additionalProperties=false) → upload rejected as reaiapp_manifest_schema_invalid`);
    }
  }
  const requirements = Array.isArray(manifest.requirements) ? manifest.requirements : [];
  requirements.forEach((requirement, index) => {
    const probe = requirement && typeof requirement === "object" ? (requirement as { probe?: unknown }).probe : undefined;
    const id = probe && typeof probe === "object" ? (probe as { id?: unknown }).id : undefined;
    if (typeof id === "string" && !contract.probeIds.includes(id))
      findings.push(`/requirements/${index}/probe/id ${JSON.stringify(id)} is not in the backend schema enum → upload rejected as reaiapp_manifest_schema_invalid`);
  });
  const requires = manifest.requires && typeof manifest.requires === "object" ? manifest.requires as { hostCapabilities?: unknown } : {};
  const capabilities = Array.isArray(requires.hostCapabilities) ? requires.hostCapabilities : [];
  for (const capability of capabilities)
    if (typeof capability === "string" && HOST_GRANT_GATED.has(capability) && !contract.reviewableCapabilities.includes(capability))
      findings.push(`requires.hostCapabilities ${JSON.stringify(capability)} is Host grant-gated but reviewers cannot approve it (app_capability_approval_invalid), so the Host would refuse it`);
  if (findings.length)
    fail(`Open Platform backend contract ${contract.name} (${contract.baseline}, ${contract.backend}) rejects:\n  - ${findings.join("\n  - ")}`);
}

export function readIdentity(value: unknown): SubmissionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("submission.identity.json must be an object");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== identityKeys.length || identityKeys.some(key => !Object.hasOwn(data, key)))
    fail("submission.identity.json requires exactly schemaVersion, version, appId, publisherId, oauthAppId, productId and target; never store secrets here");
  if (typeof data.version !== "string" || !data.version || data.version.trim() !== data.version) fail("submission version must be explicitly recorded without surrounding whitespace");
  if (!submissionVersion.test(data.version as string)) fail("version must match the Open Platform submission SemVer format");
  if (data.schemaVersion !== 1 || data.target !== "universal") fail("submission target must be universal (not Manifest targets)");
  if (typeof data.appId !== "string" || !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(data.appId)) fail("appId must be the existing reverse-domain plugin ID");
  if (typeof data.publisherId !== "string" || !(uuid.test(data.publisherId) || data.publisherId === reservedPublisherId))
    fail("publisherId must be the current Product Team UUID or the reserved platform identity reai");
  if (typeof data.productId !== "string" || !uuid.test(data.productId)) fail("productId must be the current Product UUID");
  if (typeof data.oauthAppId !== "string" || !/^[A-Za-z0-9._-]{8,128}$/.test(data.oauthAppId)) fail("oauthAppId must be the current OAuth Client ID");
  return data as unknown as SubmissionIdentity;
}

export function verifyIdentity(manifest: Record<string, unknown>, identity: SubmissionIdentity, version?: string, contract: ServerContract = DEFAULT_SERVER_CONTRACT, evidence?: SourceReviewEvidence, sourceRoot?: string) {
  for (const key of ["appId", "publisherId", "oauthAppId"] as const)
    if (manifest[key] !== identity[key]) fail(`Manifest ${key} is missing or differs from submission.identity.json`);
  if ("productId" in manifest || "clientId" in manifest) fail("productId belongs to submission identity; OAuth Client ID belongs to oauthAppId");
  if (manifest.version !== identity.version) fail(`submission version ${identity.version} differs from Manifest version ${String(manifest.version)}`);
  if (version !== undefined && manifest.version !== version) fail("package.json and Manifest version differ");
  const findings = validateManifest(manifest, evidence, sourceRoot);
  if (findings.length) fail(JSON.stringify(findings));
  verifyServerI18nTargets(manifest, contract);
  verifyServerContract(manifest, contract);
}

/** The form value is an explicit input; a local build cannot observe a remote draft. */
export function verifyFormVersion(identity: SubmissionIdentity, formVersion: string) {
  if (formVersion !== identity.version)
    fail(`form version ${JSON.stringify(formVersion)} differs from package/submission version ${identity.version}; correct the form or deliberately rebuild the intended release version`);
}

export function verifyIcon(path: unknown, bytes: Uint8Array | undefined) {
  if (typeof path !== "string" || !path.endsWith(".png") || !bytes) return fail("Manifest icon must reference a packaged PNG");
  const png = Buffer.from(bytes);
  if (png.length < 33 || png.length > 256 * 1024 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.toString("ascii", 12, 16) !== "IHDR")
    fail("icon must be a PNG no larger than 256 KiB");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 512 || height > 512) fail("icon dimensions must be between 1 and 512 pixels");
}

export function verifySource(root: string, contract: ServerContract = DEFAULT_SERVER_CONTRACT, evidence?: SourceReviewEvidence) {
  const identity = readIdentity(JSON.parse(readFileSync(join(root, "submission.identity.json"), "utf8")));
  const manifest = JSON.parse(readFileSync(join(root, "app.manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string") fail("package.json version is required");
  verifyIdentity(manifest, identity, pkg.version, contract, evidence, root);
  const icon = typeof manifest.icon === "string" && !manifest.icon.startsWith("/") && !manifest.icon.split("/").includes("..") ? manifest.icon : fail("invalid icon resource path");
  if (!existsSync(join(root, icon))) fail("Manifest icon resource is missing");
  verifyIcon(icon, readFileSync(join(root, icon)));
  return { identity, manifest };
}

export function verifyArchive(bytes: Buffer, identity: SubmissionIdentity, version: string, contract: ServerContract = DEFAULT_SERVER_CONTRACT, evidence?: SourceReviewEvidence, sourceRoot?: string) {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) fail("archive size must be between 1 byte and 64 MiB");
  const files = packedFiles(bytes);
  const manifest = verifyPackagedResources(files);
  verifyIdentity(manifest, identity, version, contract, evidence, sourceRoot);
  if (evidence && sha256(bytes) !== evidence.expectedPackageSha256) fail("source-review expected package digest mismatch");
  verifyIcon(manifest.icon, files.get(String(manifest.icon)));
  const findings = validateLocaleBytes(manifest, files, true);
  if (findings.length) fail(JSON.stringify(findings));
  return { manifest, sha256: sha256(bytes), sizeBytes: bytes.length, entries: files.size };
}

/** Also guard concurrent invocations after the initial existence check. */
export function writeNewOrIdentical(path: string, bytes: Buffer) {
  try { writeFileSync(path, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(bytes)) fail(`different output already exists: ${basename(path)}; use a new filename`);
  }
}

/** Only the deployed current contract yields plain passed; historical checks reproduce old failures. */
export function preflightStatus(contract: ServerContract) {
  if (contract.backend === "historical") return "local-preflight-passed-historical-server-contract";
  return contract.backend === "deployed" ? "local-preflight-passed" : "local-preflight-passed-pending-backend-contract";
}
const contractReceipt = (contract: ServerContract) => ({ name: contract.name, baseline: contract.baseline, backend: contract.backend });

export async function packSubmission(root: string, output: string, contract: ServerContract = DEFAULT_SERVER_CONTRACT, evidence?: SourceReviewEvidence, options: PackOptions = {}) {
  const compression = parseCompression(options.compression);
  const { identity, manifest } = verifySource(root, contract, evidence);
  if (!output.endsWith(".reaiapp")) fail("output must end in .reaiapp");
  mkdirSync(dirname(output), { recursive: true });
  const temp = mkdtempSync(join(dirname(output), ".plugin-submission-"));
  try {
    const first = join(temp, "first.reaiapp"), second = join(temp, "second.reaiapp");
    await packApp(root, first, true, evidence, { compression });
    await packApp(root, second, true, evidence, { compression });
    const bytes = readFileSync(first);
    if (!bytes.equals(readFileSync(second))) fail("two builds produced different package bytes");
    const checked = verifyArchive(bytes, identity, manifest.version, contract, evidence, root);
    const receipt = {
      status: preflightStatus(contract), remoteSubmission: "not-performed", serverContract: contractReceipt(contract),
      ...identity, version: manifest.version, packageFile: basename(output),
      sourceReviewEvidence: evidence ? { purpose: evidence.purpose, sha256: sha256(Buffer.from(JSON.stringify(evidence))), runtimeGrant: false, platformApproval: false } : null,
      sha256: checked.sha256, sizeBytes: checked.sizeBytes,
      ...(compression === "deflate" ? { compression } : {}),
      sourceManifestSha256: sha256(readFileSync(join(root, "app.manifest.json"))),
      checks: ["identity", "manifest-schema", "server-contract", "locale-resources", "packaged-png-icon", "resource-hashes", "two-identical-builds", ...(compression === "deflate" ? ["deterministic-deflate"] : [])],
      note: "Product ID is submission metadata, not a Manifest field. Upload requires a real CAS fileId and a fresh review quote."
        + (contract.backend === "deployed" ? "" : ` Checked against the pending backend contract ${contract.baseline}: do not upload until that backend rollout is deployed.`),
    };
    const receiptPath = `${output}.submission.json`, receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    for (const [path, content] of [[output, bytes], [receiptPath, receiptBytes]] as const)
      if (existsSync(path) && !readFileSync(path).equals(content)) fail(`different output already exists: ${basename(path)}; use a new filename`);
    writeNewOrIdentical(output, bytes); writeNewOrIdentical(receiptPath, receiptBytes);
    return receipt;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function parseSubmissionArgs(args: string[]) {
  const [command, directory, ...options] = args;
  const usage = "usage: bun scripts/plugin-submission.ts check <pluginDir> [--package file.reaiapp] [--form-version version] [--server-contract name] [--source-review file.json] | pack <pluginDir> --out file.reaiapp [--form-version version] [--server-contract name] [--source-review file.json] [--compression store|deflate]";
  if (!directory || !["check", "pack"].includes(command) || options.length % 2) fail(usage);
  const parsed = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index], value = options[index + 1];
    if (!["--form-version", "--server-contract", "--source-review", ...(command === "pack" ? ["--out", "--compression"] : ["--package"])].includes(key) || !value || value.startsWith("--") || parsed.has(key)) fail(usage);
    parsed.set(key, value);
  }
  if (command === "pack" && !parsed.has("--out")) fail(usage);
  const contract = serverContract(parsed.get("--server-contract") ?? DEFAULT_SERVER_CONTRACT.name);
  return { command, directory, target: parsed.get(command === "pack" ? "--out" : "--package"), formVersion: parsed.get("--form-version"), sourceReview: parsed.get("--source-review"), contract, compression: parseCompression(parsed.get("--compression")) };
}

if (import.meta.main) {
  try {
    const { command, directory, target, formVersion, sourceReview, contract, compression } = parseSubmissionArgs(process.argv.slice(2));
    const root = resolve(directory);
    const evidence: SourceReviewEvidence | undefined = sourceReview ? readSourceReviewEvidence(resolve(sourceReview)) : undefined;
    const { identity, manifest } = verifySource(root, contract, evidence);
    if (formVersion !== undefined) verifyFormVersion(identity, formVersion);
    if (command === "pack") console.log(JSON.stringify(await packSubmission(root, resolve(target!), contract, evidence, { compression }), null, 2));
    else {
      const packed = target ? verifyArchive(readFileSync(resolve(target)), identity, manifest.version, contract, evidence, root) : undefined;
      console.log(JSON.stringify({ status: preflightStatus(contract), serverContract: contractReceipt(contract), ...identity, formVersionCheck: formVersion === undefined ? "not-provided" : "matched-explicit-input", ...(packed ? { sha256: packed.sha256, sizeBytes: packed.sizeBytes } : {}) }, null, 2));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
