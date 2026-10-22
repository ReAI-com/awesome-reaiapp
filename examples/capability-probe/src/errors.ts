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

const HIDDEN = "[已隐藏]";
const SECRET_NAME = "(?:token|secret|signature|sig|key|code|password|passwd|credential|session|cookie|auth)";

const SENSITIVE: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // 整行的凭据头：Authorization / Cookie / Set-Cookie / Proxy-Authorization
  [/\b((?:proxy-)?authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, (_match, name) => `${name}: ${HIDDEN}`],
  // 行内的 Bearer / Basic 凭据
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_match, scheme) => `${scheme} ${HIDDEN}`],
  // 外脑访问令牌形状
  [/\bwno-[A-Za-z0-9._-]+/g, () => HIDDEN],
  // URL 查询参数里名字带 token / secret / signature / key / code / password 等的值
  [new RegExp(`([?&][^=&\\s]*${SECRET_NAME}[^=&\\s]*=)[^&\\s#]+`, "gi"), (_match, prefix) => `${prefix}${HIDDEN}`],
  // JSON 里名字带上述词的字符串字段
  // 值按 JSON 字符串规则匹配（认得 \" 等转义），不会在转义引号处提前结束、留下凭据尾段
  [new RegExp(`("[^"]*${SECRET_NAME}[^"]*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), (_match, prefix) => `${prefix}"${HIDDEN}"`],
];

/** 拼进诊断或报告前去掉令牌、签名参数、Cookie 等凭据，并限制长度。 */
export function scrub(text: string, max = 600): string {
  let result = text;
  for (const [pattern, replace] of SENSITIVE) result = result.replace(pattern, replace as (match: string, ...args: unknown[]) => string);
  return result.length > max ? `${result.slice(0, max)}…（已截断，原长 ${result.length} 字）` : result;
}

/** Driver 网络代理按规则拦下（不是超时、限流这类临时失败）。 */
const NETWORK_GATE_CODES = new Set([
  "NETWORK_PERMISSION_REQUIRED",
  "NETWORK_ENDPOINT_NOT_DECLARED",
  "NETWORK_SCHEME_DENIED",
  "NETWORK_PATH_DENIED",
  "NETWORK_METHOD_DENIED",
  "NETWORK_HEADER_DENIED",
  "NETWORK_PRIVATE_ADDRESS_DENIED",
  "NETWORK_REDIRECT_DENIED",
]);

/** 用户没同意 / 系统没授权 / Host 没这项能力 / 网络规则拦下：这些是「被拦下」，不是插件出错。 */
export function isGateCode(code: string): boolean {
  return (
    code.startsWith("PLUGIN_PERMISSION_") ||
    code.startsWith("SYSTEM_NOTIFICATION_PERMISSION_") ||
    code === "HOST_CAPABILITY_NOT_AVAILABLE" ||
    code === "APP_CAPABILITY_NOT_GRANTED" ||
    NETWORK_GATE_CODES.has(code)
  );
}

export function gateHint(code: string): string {
  if (code.startsWith("PLUGIN_PERMISSION_") || code === "NETWORK_PERMISSION_REQUIRED") return "还没同意这项权限：到「已安装」点开能力探针，在「权限」里点允许，再测一次。";
  if (code.startsWith("SYSTEM_NOTIFICATION_PERMISSION_")) return "Driver 自己还没有系统通知权限：到 Driver 设置里开启通知。";
  if (code === "HOST_CAPABILITY_NOT_AVAILABLE") return "当前 Driver 版本还没有这项能力。";
  if (code === "APP_CAPABILITY_NOT_GRANTED") return "这项能力需要平台批准。";
  if (NETWORK_GATE_CODES.has(code)) return "Driver 的网络规则拦下了这个请求。";
  return "被拦下。";
}
