/** Offline review material only. Normal validators remain unchanged. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_MANIFEST_NAME, BuildError } from "@reai/app-cli";
import { compileAppArtifacts, createBuildManifest } from "./build";
import { archiveFromBuild } from "./pack";
import { parseCompression, type PackOptions } from "./archive";
import { packedFiles, verifyPackagedResources } from "./index";
import { assertSafeTree, isSafePackagePath } from "./paths";
import { validateManifest } from "./gateway";
import { validateLocaleBytes, validateLocaleDirectory } from "./resources";
import { gatedSourceChecks } from "./source-approval";
import { collectSourceReviewInputs, sourceReviewInputsDigest } from "./source-review-evidence";
import { collectReviewToolchain, reviewToolchainInputsDigest } from "./review-toolchain";

export interface ReviewInputPin { schemaVersion: 1; sourceFiles: Record<string, string>; sourceFilesSha256: string }

function assertInputs(root: string, pin: ReviewInputPin): Record<string, string> {
  if (!pin || pin.schemaVersion !== 1 || !pin.sourceFiles || typeof pin.sourceFiles !== "object" || Array.isArray(pin.sourceFiles)
    || Object.entries(pin.sourceFiles).some(([path, sha]) => !isSafePackagePath(path) || typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha))
    || !/^[a-f0-9]{64}$/.test(pin.sourceFilesSha256)) throw new Error("Review input pin is invalid");
  const files = collectSourceReviewInputs(root);
  if (sourceReviewInputsDigest(pin.sourceFiles) !== pin.sourceFilesSha256 || sourceReviewInputsDigest(files) !== pin.sourceFilesSha256
    || JSON.stringify(files) !== JSON.stringify(Object.fromEntries(Object.entries(pin.sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))) throw new Error("Review input inventory differs from the complete pin");
  return files;
}

function pendingFindings(root: string, manifest: Record<string, unknown>) {
  const findings = [...validateManifest(manifest), ...validateLocaleDirectory(root, manifest, true)];
  const checks = new Set(gatedSourceChecks(manifest as Parameters<typeof gatedSourceChecks>[0]).map(check => check.pointer));
  const blockers = findings.filter(f => f.code !== "APP_CAPABILITY_NOT_GRANTED" || !checks.has(f.pointer));
  if (blockers.length) throw new BuildError("Review byte calculation rejects non-review findings", blockers);
  return findings;
}

export async function calculateReviewBytes(appDirectory: string, pin: ReviewInputPin, expectedBun: string, options: PackOptions & { toolchainReceipt?: string } = {}) {
  const compression = parseCompression(options.compression);
  if (!expectedBun || Bun.version !== expectedBun) throw new Error("Review byte calculation requires the expected Bun version");
  const root = realpathSync(resolve(appDirectory));
  const sourceFiles = assertInputs(root, pin), toolchain = collectReviewToolchain(root, compression, options.toolchainReceipt);
  assertSafeTree(root, APP_MANIFEST_NAME);
  const manifestBytes = readFileSync(join(root, APP_MANIFEST_NAME));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const pending = pendingFindings(root, manifest);
  if (manifest.packageType === "skin") throw new Error("Review byte calculation supports ordinary Apps only");
  const { entry, skinEntry } = await compileAppArtifacts(root, manifest);
  if (!readFileSync(join(root, APP_MANIFEST_NAME)).equals(manifestBytes)) throw new Error("Manifest changed during review byte calculation");
  assertInputs(root, pin);
  pendingFindings(root, manifest);
  const built = createBuildManifest(root, manifest, entry, skinEntry);
  const { archive, archiveDigest, entryCount, bytes } = archiveFromBuild(root, built, compression);
  const actual = packedFiles(archive), archivedManifest = verifyPackagedResources(actual);
  const localeFindings = validateLocaleBytes(archivedManifest, actual, true);
  if (localeFindings.length) throw new BuildError("Review archived locale validation failed", localeFindings);
  if (!Buffer.from(actual.get(APP_MANIFEST_NAME)!).equals(manifestBytes)) throw new Error("Review archived manifest differs");
  assertInputs(root, pin);
  const finalToolchain = collectReviewToolchain(root, compression, options.toolchainReceipt);
  if (JSON.stringify(finalToolchain) !== JSON.stringify(toolchain)) throw new Error("Review toolchain changed during calculation");
  return { archive, calculation: { schemaVersion: 1, purpose: "unapproved-source-review-bytes", status: { validation: "NOT_VALIDATED", approval: "NOT_APPROVED", installation: "NOT_INSTALLABLE", publication: "NOT_PUBLISHED" }, runtimeGrant: false, platformApproval: false,
    identity: { appId: manifest.appId, publisherId: manifest.publisherId, oauthAppId: manifest.oauthAppId, version: manifest.version },
    sourceFiles, sourceFilesSha256: pin.sourceFilesSha256, toolchain, toolchainSha256: createHash("sha256").update(JSON.stringify(toolchain)).digest("hex"), toolchainInputsSha256: reviewToolchainInputsDigest(toolchain),
    pendingFindings: pending, archiveSha256: archiveDigest, bytes, entryCount, compression, entries: [...actual].map(([path, content]) => ({ path, size: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") })) } };
}
