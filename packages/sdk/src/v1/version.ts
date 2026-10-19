/**
 * SDK 包身份与 Host API 合同分别维护。
 *
 * SDK_VERSION 与本包 package.json 精确一致；HOST_API_VERSION 与支持矩阵
 * hostApi 一致。候选 SDK 可以在不改变 Host API 的情况下补充 runtime 或测试能力。
 * 两组身份由 contract-constants.test.ts 分别校验，不要求两个版本相等。
 *
 * 插件构建将 SDK external，由 Host import map 提供实际 runtime。这里的常量
 * 描述正在执行的 SDK 包及其 Host API 合同，不证明插件本地依赖与任意 Host runtime
 * 具有相同版本或字节，也不授予平台能力。
 */

/** SDK 自身版本（与 package.json version 同步）。 */
export const SDK_VERSION = "1.26.0-v105.1";

/** 本版 SDK 对应的 Host API 版本（与矩阵 hostApi 同步）。 */
export const HOST_API_VERSION = "1.25.0";
