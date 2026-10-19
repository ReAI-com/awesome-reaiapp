import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_PLATFORM_ERROR_CODES,
  PLUGIN_BRIDGE_ERROR_CODES,
} from "../src/v1/error-codes";
import { HOST_API_VERSION, SDK_VERSION } from "../src/v1/version";

/**
 * SDK 常量 ↔ host-support-matrix.json 的合同测试。
 *
 * SDK 运行在插件 WebView 里读不到矩阵，错误码与版本只能以源码常量第二份存在；
 * 这里锁死两份事实的一致性（Host/Rust 侧同款纪律见 support_matrix.rs）。
 */

const contractRoot = (relative: string): string =>
  fileURLToPath(new URL(`../../contract/${relative}`, import.meta.url));

interface MatrixShape {
  hostApi: string;
  pluginPermissions: { stableErrors: string[] };
  stableErrors: string[];
}

const matrix = JSON.parse(
  readFileSync(contractRoot("host-support-matrix.json"), "utf8"),
) as MatrixShape;

const sorted = (list: readonly string[]): string[] => [...list].sort();

describe("SDK 稳定错误码 ↔ 矩阵", () => {
  test("Bridge/权限域与矩阵 pluginPermissions.stableErrors 完全一致", () => {
    expect(sorted(PLUGIN_BRIDGE_ERROR_CODES)).toEqual(sorted(matrix.pluginPermissions.stableErrors));
    expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("BRIDGE_MESSAGE_TOO_LARGE");
    expect(PLUGIN_BRIDGE_ERROR_CODES).toContain("BRIDGE_TOO_MANY_INFLIGHT");
  });

  test("安装/生命周期域与矩阵顶层 stableErrors 完全一致", () => {
    expect(sorted(APP_PLATFORM_ERROR_CODES)).toEqual(sorted(matrix.stableErrors));
  });

  test("两域不相交且各自无重复", () => {
    const bridge = new Set<string>(PLUGIN_BRIDGE_ERROR_CODES);
    const platform = new Set<string>(APP_PLATFORM_ERROR_CODES);
    expect(bridge.size).toBe(PLUGIN_BRIDGE_ERROR_CODES.length);
    expect(platform.size).toBe(APP_PLATFORM_ERROR_CODES.length);
    for (const code of bridge) expect(platform.has(code)).toBe(false);
  });
});

describe("SDK 版本锚点", () => {
  test("SDK 包身份与 Host API 合同分别精确对齐事实源", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(HOST_API_VERSION).toBe(matrix.hostApi);
  });
});
