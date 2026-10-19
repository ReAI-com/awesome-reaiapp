import { AppError, createSurfaceLayout, type SurfaceHandle, type SurfaceNavigationInput } from "@reai/app-sdk/v1";

/** Client presentation state only. The SDK and Host own binding and dispatch validation. */
export function mountNavigation(surface: SurfaceHandle, options: {
  rootLabel(): string;
  backLabel(): string;
  rootCommand: string;
  menu(): NonNullable<SurfaceNavigationInput["menu"]>;
  onBack(): void;
}) {
  const layout = createSurfaceLayout(surface.root);
  layout.frame.style.background = "var(--bg)";
  layout.frame.style.color = "var(--text-primary)";
  Object.assign(layout.body.style, { display: "flex", flexDirection: "column", overflow: "hidden" });
  const back = surface.root.ownerDocument.createElement("button");
  back.type = "button";
  back.dataset.navigationBack = "";
  back.className = "navigation-content-back";
  back.hidden = true;
  back.onclick = () => options.onBack();
  const content = surface.root.ownerDocument.createElement("div");
  content.className = "navigation-content";
  content.dataset.navigationContent = "";
  Object.assign(content.style, { flex: "1 1 0", minHeight: "0", minWidth: "0", overflow: "hidden" });
  layout.body.append(back, content);
  content.setAttribute("aria-busy", "true");
  let revision = 0;
  let stopped = false;
  let page: { key: string; label: string } | null = null;
  let chain = Promise.resolve();
  const report = (error: unknown) => {
    if (error instanceof AppError && error.code === "SURFACE_SESSION_STALE") return;
    if (!stopped) surface.reportError(error);
  };
  const publish = (next: { key: string; label: string } | null) => {
    if (stopped) return;
    page = next;
    back.textContent = options.backLabel();
    const navigation = surface.navigation;
    back.hidden = !!navigation || page === null;
    if (!navigation) { surface.reportNav?.(page); return; }
    const input: SurfaceNavigationInput = {
      revision: ++revision,
      breadcrumbs: page
        ? [{ key: "root", label: options.rootLabel(), command: { commandId: options.rootCommand } }, { ...page }]
        : [{ key: "root", label: options.rootLabel() }],
      ...(page ? { back: { commandId: options.rootCommand } } : {}),
      menu: page ? [] : options.menu(),
    };
    chain = chain.then(async () => { if (!stopped) await navigation.register(input); }).catch(report);
  };
  return {
    content, footer: layout.footer,
    publish,
    ready() { content.removeAttribute("aria-busy"); },
    fail(message: string) { content.removeAttribute("aria-busy"); content.textContent = message; },
    dispose() {
      if (stopped) return;
      stopped = true;
      back.onclick = null;
      const navigation = surface.navigation;
      if (navigation) chain = chain.then(() => navigation.clear(++revision)).catch(report);
      layout.dispose();
    },
  };
}
