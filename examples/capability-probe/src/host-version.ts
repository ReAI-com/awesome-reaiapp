import { describeError } from "./errors";
import { sleep } from "./probes";
import type { HostVersion } from "./view";

/** 界面刚显示时 Driver 可能还没把它记为可见（SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED），或刚查过被限频；隔一会儿再试，最多 5 次。 */
export async function readHostVersion(read: () => Promise<{ app: { currentVersion: string } }>, waitMs = 1000, signal?: AbortSignal): Promise<HostVersion> {
  let code = "NO_CODE";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 界面卸载后不再重试。
    if (signal?.aborted) return { ok: false, code: "SURFACE_CLOSED" };
    try {
      const status = await read();
      return { ok: true, version: status.app.currentVersion };
    } catch (error) {
      code = describeError(error).code;
      if (code !== "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" && code !== "SYSTEM_TASK_RATE_LIMITED") break;
      await sleep(code === "SYSTEM_TASK_RATE_LIMITED" ? Math.max(waitMs, 2100) : waitMs, signal);
    }
  }
  return { ok: false, code };
}
