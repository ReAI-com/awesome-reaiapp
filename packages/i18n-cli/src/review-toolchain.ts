/** Exact local byte-construction inputs. No approval or runtime authority. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDeflateCodec, type Compression } from "./archive";
import { verifyReviewDistribution, type ReviewDistribution } from "./review-distribution";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const repository = realpathSync(resolve(import.meta.dir, "../../.."));

export interface ReviewToolchain {
  gitHead: string;
  bunVersion: string;
  bunBinarySha256: string;
  platform: string;
  arch: string;
  platformLockSha256: string;
  pluginLockSha256: string;
  pluginFileDependencyRecords: string[];
  scriptSha256: string;
  packages: Record<string, { version: string; files: Record<string, string>; resolution: "same-content" | "verified-distribution"; entry?: string }>;
  distribution?: ReviewDistribution;
  environment: Record<string, string>;
  globalBunfig: Record<string, string | null>;
}

/** A later evidence-only commit may change HEAD without changing these construction inputs. */
export function reviewToolchainInputsDigest(toolchain: ReviewToolchain): string {
  const { gitHead: _sourceCommit, ...inputs } = toolchain;
  return digest(JSON.stringify(inputs));
}

function packageRoot(entry: string, name: string): string {
  let directory = dirname(realpathSync(entry));
  for (;;) {
    const path = join(directory, "package.json");
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === name) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Review toolchain package root not found: ${name}`);
    directory = parent;
  }
}

/** Include actual exports/main targets and every package file, not just src. */
function packageFiles(root: string): Record<string, string> {
  const files: [string, string][] = [];
  const visit = (path: string): void => {
    const absolute = path ? join(root, path) : root;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("Review toolchain package contains a Symlink");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === "node_modules" || name === ".git") continue;
        visit(path ? `${path}/${name}` : name);
      }
    } else if (stat.isFile()) files.push([path, digest(readFileSync(absolute))]);
    else throw new Error("Unsupported review toolchain input");
  };
  visit("");
  return Object.fromEntries(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function collectReviewToolchain(appDirectory: string, compression: Compression = "store", receiptPath?: string): ReviewToolchain {
  const distribution = receiptPath ? verifyReviewDistribution(receiptPath, appDirectory, repository, packageFiles, packageRoot) : undefined;
  const names = ["@reai/app-i18n-cli", "@reai/app-cli", "@reai/app-contract"];
  const activeEntries = [
    resolve(import.meta.dir, "index.ts"),
    fileURLToPath(import.meta.resolve("@reai/app-cli")),
    fileURLToPath(import.meta.resolve("@reai/app-contract/host-support-matrix.json")),
  ];
  const packages: ReviewToolchain["packages"] = {};
  names.forEach((name, index) => {
    const target = name === "@reai/app-contract" ? `${name}/host-support-matrix.json` : name;
    const active = packageRoot(activeEntries[index]!, name);
    const installed = packageRoot(Bun.resolveSync(target, appDirectory), name);
    const files = packageFiles(active), installedFiles = packageFiles(installed);
    const expected = distribution?.files[name] ?? files;
    if (JSON.stringify(expected) !== JSON.stringify(installedFiles)
      || Object.entries(expected).some(([path, hash]) => files[path] !== hash)) throw new Error(`Review toolchain differs from the normal installed CLI: ${name}`);
    const metadata = JSON.parse(readFileSync(join(active, "package.json"), "utf8"));
    packages[name] = { version: String(metadata.version), files, resolution: distribution ? "verified-distribution" : "same-content" };
  });
  if (compression === "deflate") {
    const installedCli = packageRoot(Bun.resolveSync("@reai/app-i18n-cli", appDirectory), "@reai/app-i18n-cli");
    const active = resolveDeflateCodec();
    const installed = resolveDeflateCodec(pathToFileURL(join(installedCli, "src/archive.ts")));
    const files = packageFiles(active.root), installedFiles = packageFiles(installed.root);
    const entry = relative(active.root, active.entryPath).replaceAll("\\", "/");
    if (entry !== relative(installed.root, installed.entryPath).replaceAll("\\", "/")
      || JSON.stringify(files) !== JSON.stringify(installedFiles)) throw new Error("Review toolchain differs from the normal installed CLI: fflate");
    packages.fflate = { version: active.version, files, resolution: "same-content", entry };
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  if (git.status !== 0 || !/^[a-f0-9]{40}$/.test(git.stdout.trim())) throw new Error("Review toolchain Git identity unavailable");
  const lock = readFileSync(join(appDirectory, "bun.lock"));
  const environment = Object.fromEntries(Object.keys(process.env).filter(name => name === "NODE_ENV" || name.startsWith("BUN_")).sort().map(name => [name, digest(process.env[name] ?? "")]));
  const globalBunfig: Record<string, string | null> = {};
  const configDirectory = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  for (const [label, path] of [["home", join(homedir(), ".bunfig.toml")], ["config", join(configDirectory, ".bunfig.toml")]]) {
    globalBunfig[label!] = existsSync(path!) ? digest(readFileSync(path!)) : null;
  }
  return { gitHead: git.stdout.trim(), bunVersion: Bun.version, bunBinarySha256: digest(readFileSync(realpathSync(process.execPath))), platform: process.platform, arch: process.arch,
    platformLockSha256: digest(readFileSync(join(repository, "packages/bun.lock"))), pluginLockSha256: digest(lock),
    pluginFileDependencyRecords: lock.toString("utf8").split("\n").filter(line => line.includes('"@reai/') && line.includes("file:")).map(line => line.trim()),
    scriptSha256: digest(readFileSync(join(repository, "scripts/source-review-bytes.ts"))), packages, environment, globalBunfig,
    ...(distribution ? { distribution } : {}) };
}
