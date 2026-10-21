/** Bridge 拒绝可能是 `{code, userMessage}`、`{code, message}`、Error 或字符串，统一成码 + 原文。 */
export interface DescribedError {
  code: string;
  message: string;
}

export function describeError(error: unknown): DescribedError {
  if (typeof error === "string") return { code: "NO_CODE", message: error };
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; userMessage?: unknown; message?: unknown; name?: unknown };
    const code = typeof e.code === "string" && e.code ? e.code : typeof e.name === "string" && e.name ? e.name : "NO_CODE";
    const message = typeof e.userMessage === "string" ? e.userMessage : typeof e.message === "string" ? e.message : String(error);
    return { code, message };
  }
  return { code: "NO_CODE", message: String(error) };
}

const SENSITIVE = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bwno-[A-Za-z0-9._-]+/g,
  /([?&](?:token|access_token|signature|sig|key)=)[^&\s]+/gi,
];

/** 拼进诊断或报告前去掉令牌、签名参数，并限制长度。 */
export function scrub(text: string, max = 600): string {
  let result = text;
  for (const pattern of SENSITIVE) result = result.replace(pattern, (match, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[已隐藏]` : "[已隐藏]"));
  return result.length > max ? `${result.slice(0, max)}…（已截断，原长 ${result.length} 字）` : result;
}

/** 用户没点同意 / 系统没授权 / Host 没这项能力：这些都是「被拦下」，不是插件出错。 */
export function isGateCode(code: string): boolean {
  return (
    code.startsWith("PLUGIN_PERMISSION_") ||
    code.startsWith("SYSTEM_NOTIFICATION_PERMISSION_") ||
    code === "HOST_CAPABILITY_NOT_AVAILABLE" ||
    code === "APP_CAPABILITY_NOT_GRANTED" ||
    code.startsWith("NETWORK_")
  );
}

export function gateHint(code: string): string {
  if (code.startsWith("PLUGIN_PERMISSION_")) return "还没同意这项权限：到「App Store → 已安装 → 能力探针 → 权限」里点允许，再测一次。";
  if (code.startsWith("SYSTEM_NOTIFICATION_PERMISSION_")) return "Driver 自己还没有系统通知权限：到 Driver 设置里开启通知。";
  if (code === "HOST_CAPABILITY_NOT_AVAILABLE") return "当前 Driver 版本还没有这项能力。";
  if (code === "APP_CAPABILITY_NOT_GRANTED") return "这项能力需要平台批准。";
  if (code.startsWith("NETWORK_")) return "Driver 的网络代理拦下了这个请求。";
  return "被拦下。";
}
