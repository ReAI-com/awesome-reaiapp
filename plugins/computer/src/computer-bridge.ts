/**
 * Computer Use 引擎 bridge 客户端 —— 走宿主窄口 `computer.engine@1`。
 *
 * `computer.*` 方法不在 SDK 的 RequestMethod 字面量集合里（那是平台基础能力
 * 清单），与 browser 插件同款处理：取 Host bootstrap 注入的 Bridge 句柄，把
 * method 串按需 cast。Host 侧 `bridge.rs` 在分发前已校验 `computer.engine@1`
 * 的声明、安装、启用与授予；引擎内的紧急停止 / 速率上限 / 目标护栏对这里
 * 的每次调用同样生效。
 */
import { BRIDGE_GLOBAL_KEY, type HostBridge, type RequestMethod } from "@reai/app-sdk/v1";
import { t } from "./computer-i18n";

type AnyBridge = {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
};

export type ComputerMethod =
  | "computer.state"
  | "computer.stop"
  | "computer.resume"
  | "computer.permissions.status"
  | "computer.permissions.request_accessibility"
  | "computer.permissions.open_screen_settings"
  | "computer.displays.list"
  | "computer.windows.list"
  | "computer.frontmost"
  | "computer.screenshot"
  | "computer.mouse.move"
  | "computer.mouse.click"
  | "computer.mouse.drag"
  | "computer.mouse.scroll"
  | "computer.mouse.down"
  | "computer.mouse.up"
  | "computer.key.press"
  | "computer.text.type";

function bridge(): HostBridge | undefined {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const key = BRIDGE_GLOBAL_KEY as unknown as symbol;
  return g[key] as HostBridge | undefined;
}

export async function computerCall<T = unknown>(
  method: ComputerMethod,
  params: unknown = {},
): Promise<T> {
  const b = bridge();
  if (!b) {
    throw new Error(t("errors.bridgeMissing"));
  }
  return (b as unknown as AnyBridge).request<T>(method as RequestMethod, params);
}

/** Host 云 AI 通道方法（cloud.model.invoke@1 窄口；与 computer.* 同款 cast 处理）。 */
export type AiMethod = "ai.text.generate" | "ai.models.list";

export async function aiCall<T = unknown>(
  method: AiMethod,
  params: unknown = {},
): Promise<T> {
  const b = bridge();
  if (!b) {
    throw new Error(t("errors.aiBridgeMissing"));
  }
  return (b as unknown as AnyBridge).request<T>(method as RequestMethod, params);
}

/** `computer.permissions.status` 的返回。 */
export interface PermissionsStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

/**
 * `computer.screenshot` 的返回。origin 是截图左上角的屏幕坐标。
 *
 * ⚠️ `width`/`height` 是**编码后图像**的尺寸（已被 maxEdge 缩过，只用于显示）；
 * 换算点击坐标必须用 `sourceWidth`/`sourceHeight`——它们才是这张图覆盖的
 * 屏幕区域尺寸，与 origin 同一坐标空间。见 `denormalize`。
 */
export interface Screenshot {
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  originX: number;
  originY: number;
}

/** `computer.state` 的返回（trace 倒序快照）。 */
export interface ComputerState {
  stopped: boolean;
  heldButtons: string[];
  trace: Array<{
    id: string;
    action: string;
    summary: string;
    source: string;
    ok: boolean;
    atMs: number;
  }>;
}
