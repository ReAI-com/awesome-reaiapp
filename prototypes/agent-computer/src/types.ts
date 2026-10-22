/**
 * 平台无关的两层接口：VmProvider（虚拟机生命周期）与 DisplayInput（显示与输入）。
 * 上层安全线与 HTTP API 只依赖这里，macOS / Windows 的差异全部落在实现类里。
 */
import type { ModifierMap } from "./keys";
import type { Frame } from "./rfb/client";

export type { Frame };

export interface DisplayEndpoint {
  host: string;
  port: number;
  /** 敏感信息：不得写日志、不得出现在 API 返回与错误里。 */
  password?: string;
}

export interface VmStatus {
  name: string;
  exists: boolean;
  running: boolean;
  /** 本服务是否拥有这台虚拟机（只操作、清理自己的资源）。 */
  owned: boolean;
}

export interface SharedFolders {
  /** 宿主侧收件箱，只读共享给客体。 */
  inbox: string;
  /** 宿主侧隔离暂存区，只共享给这台客体。 */
  outbox: string;
}

export interface VmProvider {
  readonly platform: "macos" | "windows";
  readonly shares: SharedFolders;
  status(): Promise<VmStatus>;
  /** 确保虚拟机在后台运行（不打开任何宿主窗口），返回显示端点。 */
  start(): Promise<DisplayEndpoint>;
  /** 先请求客体正常关机，超时后强制停止；确认进程退出后才返回，forced 表示是否强制。 */
  stop(timeoutMs?: number): Promise<{ forced: boolean }>;
}

export interface DisplayCapabilities {
  /** 键盘事件能否直接输入任意 Unicode 文字（含中文、emoji）。 */
  unicodeText: boolean;
  /** 键盘事件是否需要客户端自己为大写与符号补 Shift（物理键语义）。 */
  physicalKeys: boolean;
  /** 能否在客体登录界面操作。 */
  loginScreen: boolean;
}

/**
 * 客体内的文字输入辅助：把文字写进客体剪贴板，随后由安全线发送「粘贴」组合键。
 * 只做这一件事，不提供通用命令执行。
 */
export interface GuestTextHelper {
  /** signal 中止时必须尽快结束并保证不再写入剪贴板。 */
  setClipboard(text: string, signal: AbortSignal): Promise<void>;
}

/** 让客体系统自己正常关机（数据落盘）。 */
export interface GuestPower {
  shutdown(): Promise<void>;
}

export interface DisplayInput {
  readonly capabilities: DisplayCapabilities;
  /** 组合键里修饰键名到 keysym 的映射。 */
  readonly modifiers: ModifierMap;
  readonly width: number;
  readonly height: number;
  readonly closed: boolean;
  capture(): Promise<Frame>;
  /** buttonMask 位 0=左 1=中 2=右 3/4=滚轮上/下 5/6=滚轮左/右。 */
  pointer(x: number, y: number, buttonMask: number): void;
  key(keysym: number, down: boolean): void;
  close(): void;
}

export type DisplayFactory = () => Promise<DisplayInput>;
