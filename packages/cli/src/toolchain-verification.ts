/** Internal tarball verification shared by repository acceptance scripts. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";

export const toolchainPackages = [
  { directory: "contract", filename: "app-contract.tgz", packageName: "@reai/app-contract", entry: "@reai/app-contract/host-support-matrix.json" },
  { directory: "sdk", filename: "app-sdk.tgz", packageName: "@reai/app-sdk", entry: "@reai/app-sdk/v1" },
  { directory: "test-kit", filename: "app-test.tgz", packageName: "@reai/app-test", entry: "@reai/app-test/v1" },
  { directory: "cli", filename: "app-cli.tgz", packageName: "@reai/app-cli", entry: "@reai/app-cli" },
  { directory: "i18n-cli", filename: "app-i18n-cli.tgz", packageName: "@reai/app-i18n-cli", entry: "@reai/app-i18n-cli" },
] as const;

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// Only this frozen source cohort can declare the old exact contract pin while
// resolving the selected candidate through explicit tarball overrides.
export const notificationProviderCompatibility = "notification-provider-contract-1.25.1" as const;
const selectedNotificationContract = "1.25.1-notification-provider.1";
type ToolchainCompatibility = typeof notificationProviderCompatibility;

export function assertPortableManifest(name: string, manifest: PackageManifest, versions: ReadonlyMap<string, string>, compatibility?: ToolchainCompatibility): void {
  if (manifest.name !== name || manifest.version !== versions.get(name)) {
    throw new Error(`${name} package identity differs from the fixed batch`);
  }
  if (compatibility !== undefined && (
    compatibility !== notificationProviderCompatibility
    || versions.get("@reai/app-contract") !== selectedNotificationContract
    || versions.get("@reai/app-sdk") !== "1.25.0"
    || versions.get("@reai/app-test") !== "1.3.0"
  )) throw new Error("Unknown or mismatched frozen toolchain compatibility identity");
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    for (const [dependency, value] of Object.entries(manifest[field] ?? {})) {
      if (typeof value !== "string" || /^(?:workspace:|file:|link:|\/|\.\.?[\\/]|[A-Za-z]:[\\/]|\\)/.test(value)) {
        throw new Error(`${name} ${field}.${dependency} leaks a nonportable dependency: ${value}`);
      }
      if (versions.has(dependency) && value !== versions.get(dependency)) {
        const frozenContractEdge = compatibility === notificationProviderCompatibility
          && field === "dependencies" && dependency === "@reai/app-contract" && value === "1.25.0"
          && ((name === "@reai/app-sdk" && manifest.version === "1.25.0")
            || (name === "@reai/app-test" && manifest.version === "1.3.0"));
        if (!frozenContractEdge) throw new Error(`${name} ${field}.${dependency} must pin ${versions.get(dependency)}; found ${value}`);
      }
    }
  }
}

export function assertPackEntries(name: string, entries: string[]): void {
  const forbidden = entries.filter(entry => /(?:^|\/)(?:tests?|node_modules)(?:\/|$)|(?:^|\/)(?:tsconfig\.json|bun\.lockb?)$/.test(entry));
  if (forbidden.length) throw new Error(`${name} contains development-only files: ${forbidden.join(", ")}`);
  if (!entries.includes("package/package.json")) throw new Error(`${name} tarball has no package.json`);
}

function packageRoot(entry: string, name: string): string {
  let current = dirname(realpathSync(entry));
  for (;;) {
    const metadata = join(current, "package.json");
    if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).name === name) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot locate installed metadata for ${name}`);
    current = parent;
  }
}

/** Verify direct AND transitive imports, including nested installs and symlinks. */
export function assertInstalledToolchain(consumer: string, manifests: PackageManifest[]): void {
  const root = realpathSync(consumer);
  const expected = new Map(manifests.map(manifest => [manifest.name, manifest.version]));
  const installed = new Map<string, string>();
  const resolveFrom = (entry: string, from: string, name: string): string => {
    const resolved = packageRoot(createRequire(from).resolve(entry), name);
    if (!resolved.startsWith(root + sep)) throw new Error(`${name} resolves outside its external consumer`);
    const metadata = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8")) as PackageManifest;
    if (metadata.version !== expected.get(name)) throw new Error(`${name} installed version ${metadata.version} differs from ${expected.get(name)}`);
    return resolved;
  };
  for (const spec of toolchainPackages) {
    if (expected.has(spec.packageName)) installed.set(spec.packageName, resolveFrom(spec.entry, join(root, "package.json"), spec.packageName));
  }
  for (const manifest of manifests) {
    const from = installed.get(manifest.name);
    if (!from) throw new Error(`Missing installed toolchain package ${manifest.name}`);
    // Development dependencies are not part of installed dependency resolution.
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      const spec = toolchainPackages.find(spec => spec.packageName === name);
      if (!spec || !expected.has(name)) continue;
      const resolved = resolveFrom(spec.entry, join(from, "package.json"), name);
      if (resolved !== installed.get(name)) throw new Error(`${manifest.name} resolves a different ${name} instance`);
    }
  }
}
