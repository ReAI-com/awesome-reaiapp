import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyPublicTemplate, parseArguments } from "./scaffold";

export interface PrepareAgentOptions { templateDir: string; outputName?: string }

/** Prepare an unapproved Agent candidate inside the ignored artifact directory. */
export async function prepareAgentCandidate(options: PrepareAgentOptions): Promise<string> {
  const name = options.outputName ?? "agent-candidate";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("Use a short lowercase candidate name.");
  const output = join(resolve(options.templateDir), ".artifacts", name);
  await copyPublicTemplate(options.templateDir, output);
  const manifestPath = join(output, "app.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.hostApi.range = ">=1.21.0 <2.0.0";
  manifest.requires.hostCapabilities = [...new Set([...manifest.requires.hostCapabilities, "agent.session@2", "cloud.model.invoke@1"])];
  manifest.permissions = [
    ...manifest.permissions.filter((permission: { id: string }) => !["agent.session@2", "cloud.model.invoke@1"].includes(permission.id)),
    { id: "agent.session@2", purpose: "创建当前插件的岗位 Agent 会话", required: true },
    { id: "cloud.model.invoke@1", purpose: "通过用户已授权的外脑账号调用模型", required: true },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write("The Agent candidate needs platform approval and user permission.\nAPP_CAPABILITY_NOT_GRANTED is the expected CLI result before approval.\n");
  return output;
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    for (const key of Object.keys(args)) if (key !== "name") throw new Error(`Unknown option: --${key}`);
    const result = await prepareAgentCandidate({ templateDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."), outputName: args.name });
    process.stdout.write(`Prepared ${result}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Candidate preparation failed."}\n`);
    process.exitCode = 1;
  }
}
