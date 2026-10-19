/** Verify local distribution inputs. This receipt grants no approval or runtime authority. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { isSafePackagePath } from "./paths";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sorted = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
// Keep this table consistent with toolchainPackages in packages/cli/src/toolchain-verification.ts.
const specs = [
  ["@reai/app-contract", "contract", "app-contract.tgz", "@reai/app-contract/host-support-matrix.json"],
  ["@reai/app-sdk", "sdk", "app-sdk.tgz", "@reai/app-sdk/v1"],
  ["@reai/app-test", "test-kit", "app-test.tgz", "@reai/app-test/v1"],
  ["@reai/app-cli", "cli", "app-cli.tgz", "@reai/app-cli"],
  ["@reai/app-i18n-cli", "i18n-cli", "app-i18n-cli.tgz", "@reai/app-i18n-cli"],
] as const;

function regular(path: string): Buffer {
  let prefix = resolve(path);
  for (;;) {
    if (lstatSync(prefix).isSymbolicLink()) throw new Error("Distribution input contains a symlink. Use the physical path from realpath.");
    const parent = dirname(prefix);
    if (parent === prefix) break;
    prefix = parent;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Distribution input is not a bounded regular file");
  return readFileSync(path);
}

/** Bun's fixed tarballs contain regular USTAR files. Reject links, PAX and ambiguous members. */
export function distributionFiles(compressed: Uint8Array): Record<string, string> {
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files: Record<string, string> = {};
  let offset = 0;
  const text = (header: Buffer, start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const octal = (value: string) => {
    if (!/^[0-7]+\s*$/.test(value)) throw new Error("Invalid distribution tar number");
    return parseInt(value.trim(), 8);
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) throw new Error("Invalid distribution tar terminator");
      return sorted(files);
    }
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== octal(text(header, 148, 8))) throw new Error("Distribution tar checksum differs");
    const prefix = text(header, 345, 155), name = text(header, 0, 100);
    const member = prefix ? `${prefix}/${name}` : name;
    const path = member.slice("package/".length);
    if (!member.startsWith("package/") || !isSafePackagePath(path) || Object.hasOwn(files, path)
      || ![0, 48].includes(header[156]!)) throw new Error("Unsafe or duplicate distribution tar member");
    const size = octal(text(header, 124, 12));
    if (offset + 512 + size > tar.length) throw new Error("Truncated distribution tar member");
    files[path] = sha(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Distribution tar has no terminator");
}

export interface ReviewDistribution {
  receiptSha256: string;
  tarballs: Record<string, string>;
  files: Record<string, Record<string, string>>;
}

/** The caller supplies its fixed repository root, never a root from the receipt. */
export function verifyReviewDistribution(receiptPath: string, appDirectory: string, repository: string,
  inventory: (root: string) => Record<string, string>, packageRoot: (entry: string, name: string) => string): ReviewDistribution {
  const bytes = regular(resolve(receiptPath)), receipt = JSON.parse(bytes.toString("utf8"));
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "packages", "scripts/verify-platform-packages.ts", "scripts/verify-official-plugins.ts", "scripts/verify-plugin-examples.ts", "scripts/source-review-bytes.ts"], { cwd: repository, encoding: "utf8" });
  if (git.status !== 0 || dirty.status !== 0 || dirty.stdout.trim() || receipt.schemaVersion !== 1
    || receipt.state !== "LOCAL_TOOLCHAIN_VERIFIED" || receipt.sourceDirty !== false || receipt.sourceHead !== git.stdout.trim()
    || receipt.bunVersion !== Bun.version || receipt.compatibilityPolicy !== null || receipt.runtimeGrant !== false
    || receipt.platformApproval !== false || receipt.published !== false || !Array.isArray(receipt.artifacts)
    || receipt.artifacts.length !== specs.length) throw new Error("Distribution receipt identity or clean source binding differs");
  const result: ReviewDistribution = { receiptSha256: sha(bytes), tarballs: {}, files: {} };
  const installed = new Map<string, string>();
  const manifests = new Map<string, Record<string, any>>();
  const app = realpathSync(appDirectory);
  for (const [name, directory, filename, entry] of specs) {
    const matches = receipt.artifacts.filter((a: any) => a?.name === name);
    if (matches.length !== 1) throw new Error("Distribution receipt package set differs");
    const artifact = matches[0];
    if (artifact.file !== `packs/${filename}`) throw new Error("Distribution artifact path differs");
    const tarball = regular(join(dirname(resolve(receiptPath)), artifact.file));
    if (artifact.bytes !== tarball.length || artifact.sha256 !== sha(tarball)) throw new Error("Distribution tarball identity differs");
    const files = distributionFiles(tarball);
    const sourceFiles = Object.fromEntries(Object.entries(files).map(([path, hash]) => [`packages/${directory}/${path}`, hash]));
    if (JSON.stringify(sorted(artifact.sourceFiles ?? {})) !== JSON.stringify(sorted(sourceFiles))) throw new Error("Distribution source inventory differs");
    for (const [path, hash] of Object.entries(sourceFiles)) {
      const committed = spawnSync("git", ["show", `HEAD:${path}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
      if (committed.status !== 0 || sha(committed.stdout) !== hash || sha(regular(join(repository, path))) !== hash) throw new Error("Distribution source bytes differ from the committed toolchain");
    }
    const root = packageRoot(Bun.resolveSync(entry, app), name);
    if (!root.startsWith(app + sep) || JSON.stringify(inventory(root)) !== JSON.stringify(files)) throw new Error("Installed distribution files differ");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== artifact.version) throw new Error("Installed distribution version differs");
    manifests.set(name, manifest); installed.set(name, root);
    result.tarballs[name] = artifact.sha256; result.files[name] = files;
  }
  for (const [name, manifest] of manifests) {
    for (const [dependency, version] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      const spec = specs.find(([id]) => id === dependency);
      if (!spec) continue;
      if (version !== manifests.get(dependency)?.version
        || packageRoot(Bun.resolveSync(spec[3], installed.get(name)!), dependency) !== installed.get(dependency)) throw new Error("Distribution dependency resolves to another version or instance");
    }
  }
  return result;
}
