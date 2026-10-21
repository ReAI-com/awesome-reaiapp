import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 样例合同的唯一路径入口：插件仓根下的 `examples/<slug>`。
 * 只读样例源码；Host 承诺只经 `@reai/app-contract` 包入口取得。
 */
export const examplePluginsRoot = resolve(import.meta.dir, "../../../examples");

export const exampleRoot = (slug: string) => join(examplePluginsRoot, slug);
export const exampleFile = (slug: string, path: string) => join(exampleRoot(slug), path);
export const readExample = (slug: string, path: string) => readFileSync(exampleFile(slug, path), "utf8");
export const exampleJson = <T = any>(slug: string, path: string): T => JSON.parse(readExample(slug, path)) as T;
export const exampleManifest = <T = any>(slug: string): T => exampleJson<T>(slug, "app.manifest.json");
