/**
 * 把「文件夹任务」子页挂进插件现有导航内容区：内容区分成原主界面宿主与文件夹页宿主，
 * 两者互斥显示；子页的返回由 Host 面包屑 back（= 回主页命令）完成，Esc 同义。
 *
 * 与 dsh-agent 的同名文件逐字一致（仓库测试 `folder-task-parity` 比对）。
 */
import { FolderTaskController, mountFolderTaskView, type FolderTaskDeps, type FolderTaskView } from "./folder-task";

export interface FolderPage {
  /** 原主界面（会话列表 / 设置）挂在这里。 */
  readonly mainHost: HTMLElement;
  readonly controller: FolderTaskController;
  /** 入口是否应出现（Host 已开放且获批；未同意权限时也出现，页内引导）。 */
  available(): boolean;
  probe(): Promise<void>;
  /** 进入子页；不可用时返回 false 且不改变界面。 */
  show(): boolean;
  hide(): void;
  refreshLocale(): void;
  destroy(): void;
}

export function createFolderPage(content: HTMLElement, options: FolderTaskDeps & {
  agentName: string;
  onShow(): void;
  onAvailabilityChange(): void;
}): FolderPage {
  const doc = content.ownerDocument;
  const mainHost = doc.createElement("div");
  const folderHost = doc.createElement("div");
  mainHost.dataset.folderMainHost = "";
  folderHost.dataset.folderTaskHost = "";
  for (const host of [mainHost, folderHost]) Object.assign(host.style, { height: "100%", minHeight: "0", minWidth: "0" });
  folderHost.hidden = true;
  content.append(mainHost, folderHost);
  const controller = new FolderTaskController(options);
  let view: FolderTaskView | undefined;
  let destroyed = false;
  const entryVisible = () => {
    const availability = controller.snapshot.availability;
    return availability === "ready" || availability === "notAuthorized";
  };
  let lastVisible = false;
  const stopWatching = controller.subscribe(() => {
    const visible = entryVisible();
    if (visible !== lastVisible) { lastVisible = visible; options.onAvailabilityChange(); }
  });
  return {
    mainHost,
    controller,
    available: entryVisible,
    async probe() { if (!destroyed) await controller.probe(); },
    show() {
      if (destroyed || !entryVisible()) return false;
      view ??= mountFolderTaskView(folderHost, controller, options.agentName);
      mainHost.hidden = true;
      folderHost.hidden = false;
      options.onShow();
      return true;
    },
    hide() {
      if (destroyed) return;
      folderHost.hidden = true;
      mainHost.hidden = false;
    },
    refreshLocale() { view?.refreshLocale(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopWatching();
      view?.destroy();
      controller.dispose();
      mainHost.remove();
      folderHost.remove();
    },
  };
}
