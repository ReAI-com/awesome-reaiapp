/** 视图层共享类型（避免 view 直接依赖 bridge/agent-loop 的实现细节）。 */
import type { ComputerState, PermissionsStatus } from "./computer-bridge";
import type { UiMessage } from "./computer-i18n";

export type { ComputerState, PermissionsStatus };

export interface StepLike {
  step: number;
  thought?: string;
  action: {
    action: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    dx?: number;
    dy?: number;
    detail?: string;
  };
  ok: boolean;
  /** 失败原因：key 按当前语言渲染，raw 为宿主或模型原文。 */
  error?: UiMessage;
}
