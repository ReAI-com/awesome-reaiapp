import { createContext, useContext } from "react";
import type { WorkspaceState } from "../shared/types";

export interface WorkbenchContextValue {
  state: WorkspaceState;
  base: string;
  refresh: () => Promise<void>;
  mutate: <T = unknown>(
    path: string,
    body?: unknown,
    method?: string,
  ) => Promise<T>;
  notify: (message: string, error?: boolean) => void;
  navigate: (view: string) => void;
  admin: boolean;
  canAdmin: boolean;
  oauthEnabled: boolean;
}
export const WorkbenchContext = createContext<WorkbenchContextValue | null>(
  null,
);
export function useWorkbench() {
  const context = useContext(WorkbenchContext);
  if (!context) throw new Error("工作区尚未加载");
  return context;
}
