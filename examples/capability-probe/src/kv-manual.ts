/**
 * 「本地存储读写」卡片里的单步验证：写入 / 查看 / 删除一条固定的测试数据，
 * 并告诉你这条数据在硬盘上的哪个文件里，可以自己打开核对（插件读回 + 键列表 + 硬盘文件，三方对得上）。
 *
 * 插件本身读不到硬盘文件、也拿不到账号目录名，所以位置是按 Driver 的存储规则推出来的：
 * <Driver 数据目录>/accounts/<当前账号目录>/apps/kv/<编码后的 appId>.json，
 * 文件里 entries 下的键是「存储空间/键名」。
 */
import type { KvPort } from "./port";
import { PROBE_STORE_ID } from "./port";

export const MANUAL_KEY = "probe.manualCheck";

/** 核对码只能是 6 位大写十六进制：读回的值不符合就当格式不对，也绝不拼进终端命令。 */
const CODE_PATTERN = /^[0-9A-F]{6}$/;

export interface ManualValue {
  note: string;
  code: string;
  writtenAt: string;
}

/** Driver 存储文件名的编码规则：小写字母和数字原样，「.」→「-d」，「-」→「-h」，其他字节 → 「-xHH」。 */
export function kvFileName(appId: string): string {
  let out = "";
  for (const char of appId) {
    if (/[a-z0-9]/.test(char)) out += char;
    else if (char === ".") out += "-d";
    else if (char === "-") out += "-h";
    else for (const byte of new TextEncoder().encode(char)) out += `-x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${out}.json`;
}

export interface DiskLocation {
  folder: string;
  file: string;
  entryKey: string;
  command: string;
}

const ACCOUNTS = "~/Library/Application\\ Support/com.reai.board-driver-v2/accounts";

/**
 * macOS 上 Driver 的数据目录。账号目录名插件拿不到，所以不猜「哪个是当前账号」：
 * 有核对码时，按核对码在所有账号的候选文件里找，选中含这个码的那个；
 * 没有核对码（已删除）时，列出所有候选文件里还有没有这个键。
 */
export function diskLocation(appId: string, checkCode?: string): DiskLocation {
  const file = kvFileName(appId);
  const entryKey = `${PROBE_STORE_ID}/${MANUAL_KEY}`;
  const files = `${ACCOUNTS}/*/apps/kv/${file}`;
  const safeCode = checkCode !== undefined && CODE_PATTERN.test(checkCode) ? checkCode : undefined;
  // 有核对码：列出含这个码的存储文件，正好一个就让访达选中，多个就都列出来让你自己比对。
  const command = safeCode
    ? `f=$(grep -lF -- "${safeCode}" ${files} 2>/dev/null); n=$(printf '%s\n' "$f" | grep -c .); if [ "$n" = 1 ]; then open -R "$f"; elif [ "$n" = 0 ]; then echo "没有找到含核对码 ${safeCode} 的文件"; else echo "有 $n 个文件含核对码 ${safeCode}："; printf '%s\n' "$f"; fi`
    : `grep -lF -- "${entryKey}" ${files} 2>/dev/null || echo "所有账号的存储文件里都没有 ${entryKey}"`;
  return { folder: "~/Library/Application Support/com.reai.board-driver-v2/accounts/<账号目录>/apps/kv/", file, entryKey, command };
}

function code(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function manualWrite(kv: KvPort, now = new Date()): Promise<ManualValue> {
  const value: ManualValue = { note: "能力探针手动写入的测试数据，可以删除", code: code(), writtenAt: now.toISOString() };
  await kv.set(MANUAL_KEY, value);
  return value;
}

export interface ManualView {
  /** 存储里有没有这个键的值（不管格式对不对）。 */
  exists: boolean;
  /** 插件读回、格式正确的值；存在但格式不对时为 undefined。 */
  value: ManualValue | undefined;
  /** 键列表里有没有它。 */
  listed: boolean;
}

export async function manualRead(kv: KvPort): Promise<ManualView> {
  const raw = (await kv.get(MANUAL_KEY)) as Partial<ManualValue> | undefined;
  const keys = await kv.keys();
  const value = raw && typeof raw.code === "string" && CODE_PATTERN.test(raw.code) && typeof raw.writtenAt === "string"
    ? { note: String(raw.note ?? ""), code: raw.code, writtenAt: raw.writtenAt }
    : undefined;
  return { exists: raw !== undefined && raw !== null, value, listed: keys.includes(MANUAL_KEY) };
}

export async function manualDelete(kv: KvPort): Promise<void> {
  await kv.delete(MANUAL_KEY);
}
