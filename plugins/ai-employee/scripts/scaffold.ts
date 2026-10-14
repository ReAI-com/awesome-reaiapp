import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProfile } from "../src/domain";
import { validateScopedCss } from "../src/template";

export interface ScaffoldOptions {
  templateDir: string;
  profilePath: string;
  appId: string;
  name: string;
  publisherId: string;
  outDir: string;
}

const PUBLIC_DIRECTORIES = ["src", "tests", "preview", "scripts"];
const PUBLIC_FILES = ["app.manifest.json", "package.json", "tsconfig.json", "bunfig.toml", "vite.config.ts", "index.html", "preview.html", "README.md", "CHANGELOG.md", "I18N.md", "LICENSE", ".gitignore", "assets/icon.png", "assets/icon.svg", "assets/sample-finance.csv", "assets/sample-hr.csv", "assets/skills/employee-sop/SKILL.md"];
const EXCLUDED_SEGMENTS = new Set(["node_modules", "private", ".artifacts", "dist", ".git", ".env", "submission.identity.json", "build-manifest.json"]);
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|css|html|json|svg|png|jpg|jpeg|webp|md|toml|txt|woff2)$/i;

/** Copy public template files. Reject links and existing output directories. */
export async function copyPublicTemplate(templateDir: string, outDir: string): Promise<void> {
  const source = resolve(templateDir);
  const output = resolve(outDir);
  if (existsSync(output)) throw new Error("The output directory already exists.");
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const collect = (path: string, insideDirectory: boolean) => {
    const absolute = join(source, path);
    if (!existsSync(absolute)) return;
    const parts = path.split(sep);
    if (parts.some((part) => EXCLUDED_SEGMENTS.has(part) || (part.startsWith(".") && part !== ".gitignore"))) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("The template must not contain symbolic links.");
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) collect(join(path, entry), true);
    } else if (stat.isFile() && (!insideDirectory || SOURCE_EXTENSIONS.test(path))) {
      if (/(?:^|[./_-])(?:secret|credentials|password|company-data|user-data)(?:[./_-]|$)/i.test(path)) return;
      files.push({ path, bytes: readFileSync(absolute) });
    }
  };
  for (const name of PUBLIC_FILES) collect(name, false);
  for (const name of PUBLIC_DIRECTORIES) collect(name, true);
  if (!files.some((file) => file.path === "package.json") || !files.some((file) => file.path === "app.manifest.json")) {
    throw new Error("The template needs package.json and app.manifest.json.");
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  for (const file of files) {
    const target = join(output, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  relocateFileDependencies(source, output);
  if (!existsSync(join(output, ".gitignore"))) {
    writeFileSync(join(output, ".gitignore"), "node_modules/\ndist/\nbuild-manifest.json\n*.reaiapp\n.artifacts/\nprivate/\n.env\nsubmission.identity.json\n");
  }
}

function relocateFileDependencies(source: string, output: string): void {
  const packagePath = join(output, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    const entries = packageJson[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value !== "string" || !value.startsWith("file:")) continue;
      const target = resolve(source, value.slice(5));
      const path = relative(output, target).split(sep).join("/");
      (entries as Record<string, string>)[name] = `file:${path || "."}`;
    }
  }
  writeJson(packagePath, packageJson);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceStrings(value: unknown, previous: string, next: string): unknown {
  if (typeof value === "string") return value.split(previous).join(next);
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, previous, next));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, previous, next)]));
  return value;
}

/** Create a new plugin identity and install its default profile. */
export async function scaffoldPlugin(options: ScaffoldOptions): Promise<string> {
  const output = resolve(options.outDir);
  if (existsSync(output)) throw new Error("The output directory already exists.");
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/.test(options.appId)) throw new Error("Use a reverse-domain app ID.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.publisherId)) throw new Error("Use your registered publisher ID.");
  if (!options.name.trim() || options.name.length > 80) throw new Error("The plugin name must contain 1 to 80 characters.");
  const profile = validateProfile(JSON.parse(readFileSync(options.profilePath, "utf8")));
  validateScopedCss(profile.ui.css);
  const previousManifest = JSON.parse(readFileSync(join(options.templateDir, "app.manifest.json"), "utf8"));
  if (previousManifest.appId === options.appId) throw new Error("Use a new app ID for the generated plugin.");
  await copyPublicTemplate(options.templateDir, output);
  const manifest = replaceStrings(replaceStrings(previousManifest, previousManifest.appId, options.appId), previousManifest.name, options.name.trim()) as typeof previousManifest;
  manifest.appId = options.appId;
  manifest.publisherId = options.publisherId;
  manifest.name = options.name.trim();
  manifest.description = profile.description;
  if (manifest.storeListing) {
    manifest.storeListing.tagline = profile.name;
    manifest.storeListing.longDescription = `${profile.description} 开发模板。平台审核、真实 Host 安装和公开发布需要单独验证。`;
  }
  if (manifest.contributes?.surfaces) for (const surface of manifest.contributes.surfaces) surface.title = options.name.trim();
  if (manifest.contributes?.sidebarItems) for (const item of manifest.contributes.sidebarItems) item.label = options.name.trim();
  delete manifest.oauthAppId;
  writeJson(join(output, "app.manifest.json"), manifest);
  const previewPath = join(output, "preview.html");
  if (existsSync(previewPath)) {
    const title = options.name.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    writeFileSync(previewPath, readFileSync(previewPath, "utf8").replace(/<title>[\s\S]*?<\/title>/i, `<title>${title} · Demo</title>`));
  }
  mkdirSync(join(output, "src", "profiles"), { recursive: true });
  writeJson(join(output, "src", "profiles", "default-profile.json"), profile);
  const updateSource = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (lstatSync(path).isDirectory()) updateSource(path);
      else if (/\.(?:ts|tsx|js|mjs|html|css|md|json)$/.test(path) && basename(path) !== "default-profile.json") {
        const text = readFileSync(path, "utf8").split(previousManifest.appId).join(options.appId);
        writeFileSync(path, text);
      }
    }
  };
  for (const name of PUBLIC_DIRECTORIES) updateSource(join(output, name));
  for (const name of ["README.md", "CHANGELOG.md", "I18N.md"]) {
    const path = join(output, name);
    if (existsSync(path)) writeFileSync(path, readFileSync(path, "utf8").split(previousManifest.appId).join(options.appId).split(previousManifest.name).join(options.name.trim()));
  }
  const packagePath = join(output, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const slug = options.appId.split(".").at(-1)!;
  packageJson.name = `reai-${slug}`;
  if (typeof packageJson.scripts?.pack === "string") {
    packageJson.scripts.pack = packageJson.scripts.pack.replace(/(--out\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/, (_match: string, option: string) => `${option}${slug}-${manifest.version}.reaiapp`);
  }
  writeJson(packagePath, packageJson);
  return output;
}

export function parseArguments(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Each option needs a value.");
    if (args[name.slice(2)] !== undefined) throw new Error("Do not repeat an option.");
    args[name.slice(2)] = value;
  }
  return args;
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const allowed = new Set(["profile", "app-id", "name", "publisher-id", "out"]);
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    for (const key of allowed) if (!args[key]) throw new Error(`Missing option: --${key}`);
    const result = await scaffoldPlugin({ templateDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."), profilePath: resolve(args.profile!), appId: args["app-id"]!, name: args.name!, publisherId: args["publisher-id"]!, outDir: resolve(args.out!) });
    process.stdout.write(`Created ${result}\nInstall dependencies to create a new lockfile.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Scaffold failed."}\n`);
    process.exitCode = 1;
  }
}
