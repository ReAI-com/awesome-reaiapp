import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const platform = join(import.meta.dir, "../..");
const directories = ["sdk", "contract", "test-kit", "cli", "i18n-cli"];
const manifests = directories.map(directory => JSON.parse(readFileSync(join(platform, directory, "package.json"), "utf8")));
const versions = new Map(manifests.map(manifest => [manifest.name, manifest.version]));

const frozenCompatibility = "notification-provider-contract-1.25.1" as const;
const selectedCompatibility = versions.get("@reai/app-contract") === "1.25.1-notification-provider.1" ? frozenCompatibility : undefined;

test("same-batch toolchain declares exact selected or explicit frozen ReAI pins", () => {
  for (const manifest of manifests) {
    expect(() => assertPortableManifest(manifest.name, manifest, versions, selectedCompatibility)).not.toThrow();
  }
});

test("platform fixtures consume current SDK and MockHost without changing compatibility fixtures", () => {
  for (const directory of ["minimal", "install-probe"]) {
    const manifest = JSON.parse(readFileSync(join(platform, "fixtures/apps", directory, "package.json"), "utf8"));
    expect(manifest.devDependencies["@reai/app-sdk"]).toBe(versions.get("@reai/app-sdk"));
    expect(manifest.devDependencies["@reai/app-test"]).toBe(versions.get("@reai/app-test"));
  }
  const workspace = JSON.parse(readFileSync(join(platform, "package.json"), "utf8"));
  expect(workspace.overrides["@reai/app-test"]).toBe("workspace:*");
});

import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertInstalledToolchain, assertPackEntries, assertPortableManifest, toolchainPackages, type PackageManifest } from "../src/toolchain-verification";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const versionsMap = new Map<string, string>(manifests.map(manifest => [manifest.name, manifest.version]));
const cli = manifests.find(manifest => manifest.name === "@reai/app-cli") as PackageManifest;

test("tarball metadata rejects old/ranged batch edges, including devDependencies", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const value of ["1.24.0", "^1.25.0", "workspace:*", "file:/repo/sdk", "/repo/sdk", "C:\\repo\\sdk", "../sdk", "link:../sdk"]) {
      expect(() => assertPortableManifest(cli.name, { ...cli, [field]: { "@reai/app-sdk": value } }, versionsMap)).toThrow();
    }
  }
  expect(() => assertPortableManifest(cli.name, cli, versionsMap)).not.toThrow();
});

test("frozen SDK/test-kit contract pins require the exact explicit candidate policy", () => {
  // Literal original declared identities: current package metadata is not a historical fixture.
  const frozenManifests: PackageManifest[] = [
    { name: "@reai/app-sdk", version: "1.25.0", dependencies: { "@reai/app-contract": "1.25.0" } },
    { name: "@reai/app-test", version: "1.3.0", dependencies: { "@reai/app-contract": "1.25.0", "@reai/app-sdk": "1.25.0" }, devDependencies: { "@reai/app-sdk": "1.25.0" } },
  ];
  const frozenCli: PackageManifest = { name: "@reai/app-cli", version: "1.4.0-toolchain.3", dependencies: { "@reai/app-contract": "1.25.1-notification-provider.1", "@reai/app-sdk": "1.25.0", "@reai/app-test": "1.3.0" } };
  const batch = new Map<string, string>([
    ["@reai/app-sdk", "1.25.0"], ["@reai/app-test", "1.3.0"], ["@reai/app-contract", "1.25.1-notification-provider.1"],
    ["@reai/app-cli", "1.4.0-toolchain.3"], ["@reai/app-i18n-cli", "1.1.0-toolchain.3"],
  ]);
  for (const name of ["@reai/app-sdk", "@reai/app-test"]) {
    const manifest = frozenManifests.find(value => value.name === name) as PackageManifest;
    expect(() => assertPortableManifest(name, manifest, batch)).toThrow("must pin");
    expect(() => assertPortableManifest(name, manifest, batch, frozenCompatibility)).not.toThrow();
    expect(() => assertPortableManifest(name, manifest, batch, "arbitrary" as typeof frozenCompatibility)).toThrow("compatibility");
    for (const target of ["1.25.0", "1.25.1", "1.25.1-notification-provider.2", "^1.25.1-notification-provider.1"]) {
      expect(() => assertPortableManifest(name, manifest, new Map(batch).set("@reai/app-contract", target), frozenCompatibility)).toThrow("compatibility");
    }
    for (const [packageName, wrongVersion] of [["@reai/app-sdk", "1.25.1"], ["@reai/app-test", "1.3.1"]] as const) {
      expect(() => assertPortableManifest(name, manifest, new Map(batch).set(packageName, wrongVersion), frozenCompatibility)).toThrow();
    }
    for (const pin of ["1.24.0", "^1.25.0", "~1.25.0", "1.25.0-other.1", "file:../contract"]) {
      expect(() => assertPortableManifest(name, { ...manifest, dependencies: { ...manifest.dependencies, "@reai/app-contract": pin } }, batch, frozenCompatibility)).toThrow();
    }
    for (const field of ["devDependencies", "peerDependencies"] as const) {
      expect(() => assertPortableManifest(name, { ...manifest, [field]: { ...manifest[field], "@reai/app-contract": "1.25.0" } }, batch, frozenCompatibility)).toThrow("must pin");
    }
  }
  expect(() => assertPortableManifest(frozenCli.name, { ...frozenCli, dependencies: { ...frozenCli.dependencies, "@reai/app-contract": "1.25.0" } }, batch, frozenCompatibility)).toThrow("must pin");
  const sdk = frozenManifests.find(value => value.name === "@reai/app-sdk") as PackageManifest;
  expect(() => assertPortableManifest(sdk.name, { ...sdk, dependencies: { ...sdk.dependencies, "@reai/app-test": "1.2.0" } }, batch, frozenCompatibility)).toThrow("must pin");
});


test("owned-open candidate uses strict exact edges without the historical compatibility policy", () => {
  expect(versionsMap.get("@reai/app-sdk")).toBe("1.26.0-v105.1");
  expect(versionsMap.get("@reai/app-test")).toBe("1.4.0-v105.1");
  expect(versionsMap.get("@reai/app-contract")).toBe("1.25.3-v105.1");
  for (const manifest of manifests) {
    expect(() => assertPortableManifest(manifest.name, manifest, versionsMap)).not.toThrow();
    expect(() => assertPortableManifest(manifest.name, manifest, versionsMap, frozenCompatibility)).toThrow("compatibility");
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const dependency of Object.keys(manifest[field] ?? {}).filter(name => versionsMap.has(name))) {
        for (const pin of ["1.25.0", "^" + versionsMap.get(dependency)]) {
          expect(() => assertPortableManifest(manifest.name, { ...manifest, [field]: { ...manifest[field], [dependency]: pin } }, versionsMap)).toThrow("must pin");
        }
      }
    }
  }
});

test("tarballs reject nested tests, node_modules, and locks", () => {
  for (const entry of ["package/src/tests/test.ts", "package/test/file.ts", "package/src/node_modules/module.ts", "package/bun.lock", "package/tsconfig.json"]) {
    expect(() => assertPackEntries(cli.name, ["package/package.json", entry])).toThrow();
  }
  expect(() => assertPackEntries(cli.name, ["package/package.json", "package/src/index.ts"])).not.toThrow();
});

function installedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "v105-t13-installed-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  for (const spec of toolchainPackages) {
    const path = join(root, "node_modules", spec.packageName); mkdirSync(path, { recursive: true });
    const manifest = structuredClone(manifests.find(manifest => manifest.name === spec.packageName));
    const subpath = spec.entry.slice(spec.packageName.length) || ".";
    manifest.exports = { [subpath === "." ? "." : `.${subpath}`]: "./entry.ts" };
    writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(path, "entry.ts"), "export {};\n");
  }
  return root;
}

test("installed direct and transitive imports are confined to one external batch", () => {
  expect(() => assertInstalledToolchain(installedFixture(), manifests)).not.toThrow();
});

test("frozen declared pins never waive actual selected contract version or instance", () => {
  for (const manifest of manifests) assertPortableManifest(manifest.name, manifest, versionsMap, selectedCompatibility);
  const root = installedFixture();
  expect(() => assertInstalledToolchain(root, manifests)).not.toThrow();
  const contract = join(root, "node_modules/@reai/app-contract");
  const metadata = JSON.parse(readFileSync(join(contract, "package.json"), "utf8"));
  writeFileSync(join(contract, "package.json"), JSON.stringify({ ...metadata, version: "1.24.0" }));
  expect(() => assertInstalledToolchain(root, manifests)).toThrow("installed version");
  writeFileSync(join(contract, "package.json"), JSON.stringify(metadata));
  // Inspect a pre-existing nested install before resolve() can cache this fixture.
  const duplicateRoot = installedFixture();
  const nested = join(duplicateRoot, "node_modules/@reai/app-sdk/node_modules/@reai/app-contract");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(nested, "entry.ts"), "export {};\n");
  expect(() => assertInstalledToolchain(duplicateRoot, manifests)).toThrow("different @reai/app-contract instance");
});

test("installed wrong version and duplicate transitive instance are rejected", () => {
  const root = installedFixture();
  const sdk = join(root, "node_modules/@reai/app-sdk");
  const metadata = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ ...metadata, version: "1.24.0" }));
  expect(() => assertInstalledToolchain(root, manifests)).toThrow("installed version");
  writeFileSync(join(sdk, "package.json"), JSON.stringify(metadata));
  const nested = join(root, "node_modules/@reai/app-cli/node_modules/@reai/app-sdk");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(nested, "entry.ts"), "export {};\n");
  expect(() => assertInstalledToolchain(root, manifests)).toThrow("different @reai/app-sdk instance");
});

test("installed symlink escaping its consumer is rejected", () => {
  const root = installedFixture(), other = installedFixture();
  const sdk = join(root, "node_modules/@reai/app-sdk"); rmSync(sdk, { recursive: true });
  symlinkSync(join(other, "node_modules/@reai/app-sdk"), sdk);
  expect(() => assertInstalledToolchain(root, manifests)).toThrow("outside its external consumer");
});

test("consumer aliases use canonical realpaths before containment checks", () => {
  const root = installedFixture();
  const alias = root + "-alias"; roots.push(alias); symlinkSync(root, alias);
  expect(() => assertInstalledToolchain(alias, manifests)).not.toThrow();
  const differentCase = root.replace("v105-t13-installed", "V105-T13-INSTALLED");
  if (existsSync(differentCase)) expect(() => assertInstalledToolchain(differentCase, manifests)).not.toThrow();
});
