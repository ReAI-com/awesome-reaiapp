/** A plugin-owned frame. Mount once at the root; do not also pad the root with safe-top. */
export interface SurfaceLayout {
  frame: HTMLDivElement;
  body: HTMLElement;
  footer: HTMLElement;
  dispose(): void;
}
export function createSurfaceLayout(root: HTMLElement): SurfaceLayout {
  const doc = root.ownerDocument;
  const frame = doc.createElement("div"); frame.className = "reai-surface-frame";
  Object.assign(frame.style, { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: "0", boxSizing: "border-box", paddingTop: "var(--reai-plugin-titlebar-safe-top, 44px)", overflow: "hidden" });
  const body = doc.createElement("main"); body.className = "main-body";
  Object.assign(body.style, { flex: "1 1 0", minHeight: "0", overflow: "auto" });
  const footer = doc.createElement("footer"); footer.className = "reai-surface-footer";
  Object.assign(footer.style, { flex: "0 0 auto", display: "none" });
  const update = () => { footer.style.display = footer.childElementCount > 0 || !!footer.textContent?.trim() ? "block" : "none"; };
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(update); observer.observe(footer, { childList: true, subtree: true, characterData: true });
  frame.append(body, footer); root.append(frame);
  return { frame, body, footer, dispose() { observer.disconnect(); frame.remove(); } };
}
