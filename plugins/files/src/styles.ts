/** Host tokens own color and theme; SurfaceLayout alone owns the titlebar safe-top. */
export const FILES_STYLES = `
html, body, #app { height:100%; margin:0; overflow:hidden; }
.files-app { position:relative; background:var(--bg); color:var(--text-primary); font:14px/20px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.files-app *, .files-app *::before, .files-app *::after { box-sizing:border-box; }
.files-app button { font:inherit; color:inherit; border:0; background:transparent; cursor:pointer; -webkit-appearance:none; appearance:none; text-align:inherit; }
.files-app button:focus-visible, .files-app textarea:focus-visible, .files-app input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.files-app button:disabled { cursor:not-allowed; opacity:.45; }
.files-app [hidden] { display:none !important; }
.files-app .files-main { position:relative; padding:16px; background:var(--bg); overscroll-behavior:contain; }
.files-stack { display:flex; flex-direction:column; gap:16px; min-width:0; max-width:1120px; margin:0 auto; }
.files-card { min-width:0; padding:16px; border:1px solid var(--card-border); border-radius:14px; background:var(--card-bg); }
.files-card h2, .files-dialog h2 { margin:0 0 4px; font:600 14px/20px system-ui,sans-serif; color:var(--text-primary); overflow-wrap:anywhere; }
.files-app p { margin:0; overflow-wrap:anywhere; }
.files-muted { color:var(--text-secondary); font-size:12px; line-height:20px; }
.files-label { color:var(--text-secondary); font-size:12px; font-weight:600; }
.files-toolbar { display:flex; flex-direction:column; gap:8px; }
.files-toolbar-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; }
.files-chips { display:flex; flex-wrap:wrap; gap:8px; min-width:0; }
.files-chip { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; padding:0 4px 0 0; border:1px solid var(--card-border); border-radius:10px; }
.files-chip.is-active { background:var(--accent-soft); border-color:var(--accent); }
.files-chip-main, .files-chip-solo { display:inline-flex; align-items:center; gap:8px; min-height:32px; min-width:0; padding:4px 8px 4px 12px; border-radius:10px; overflow-wrap:anywhere; }
.files-chip .files-chip-main { border:0 !important; }
.files-chip-solo { border:1px solid var(--card-border) !important; padding:4px 12px; }
.files-chip-solo[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent) !important; }
.files-chip-main:hover:enabled, .files-chip-solo:hover:enabled { background:var(--accent-soft); }
.files-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:36px; padding:4px 16px; border:1px solid var(--card-border) !important; border-radius:10px; color:var(--text-primary); line-height:20px; }
.files-btn:hover:enabled { background:var(--accent-soft); border-color:var(--accent) !important; }
.files-btn-primary { background:var(--accent) !important; border-color:var(--accent) !important; color:var(--bg) !important; }
.files-btn-primary:hover:enabled { filter:brightness(.94); }
.files-cloud { color:var(--text-secondary); }
.files-icon-btn { position:relative; display:inline-grid; place-items:center; width:32px; height:32px; flex:none; border-radius:8px; color:var(--text-secondary); }
.files-icon-btn:hover:enabled { background:var(--accent-soft); color:var(--text-primary); }
.files-chip .files-icon-btn { width:28px; height:28px; }
/* Standalone icon buttons: 32px visual, 44px hit area (design §3.3); dense chip buttons stay 28px. */
.files-icon-btn:not(.files-chip .files-icon-btn)::after { content:""; position:absolute; inset:-6px; }
.files-icon { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; flex:none; }
.files-status { display:flex; flex-direction:column; gap:4px; min-height:44px; padding:12px; border:1px solid var(--divider); border-radius:10px; background:var(--bg); overflow-wrap:anywhere; }
.files-status[data-tone="error"] { background:var(--alert-soft); border-color:var(--alert-line); }
.files-status[data-tone="warn"] { background:var(--warn-soft); border-color:var(--warn-line); }
.files-status[data-tone="success"] { background:var(--bound-soft); border-color:var(--bound-line); }
.files-status-line { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.files-status-line .files-btn { margin-left:auto; min-height:32px; }
.files-spinner { animation:files-spin 1s linear infinite; color:var(--accent); }
.files-diagnostic { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.files-content { display:flex; flex-direction:column; gap:12px; min-width:0; }
.files-empty-state { display:flex; flex-direction:column; gap:8px; padding:24px; }
.files-empty-state .files-actions { margin-top:8px; }
.files-version { margin-top:8px !important; }
.files-path { display:flex; align-items:center; gap:8px; min-width:0; }
.files-crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:0; padding:0; list-style:none; min-width:0; }
.files-crumbs li { display:inline-flex; align-items:center; gap:4px; min-width:0; }
.files-crumb { padding:4px 8px; border-radius:6px; color:var(--text-secondary); overflow-wrap:anywhere; }
.files-crumb:hover:enabled { background:var(--accent-soft); color:var(--text-primary); }
.files-crumb-current { padding:4px 8px; font-weight:600; overflow-wrap:anywhere; }
.files-crumb-sep { width:14px; height:14px; color:var(--text-secondary); }
.files-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.files-columns { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.3fr); gap:16px; align-items:start; min-width:0; }
.files-list { display:flex; flex-direction:column; gap:8px; margin:0; padding:0; list-style:none; }
.files-list-card .files-actions { margin-top:12px; }
.files-row { display:flex; width:100%; align-items:center; gap:12px; padding:8px 12px; border:1px solid var(--card-border) !important; border-radius:10px; color:var(--text-secondary); }
.files-row:hover:enabled { background:var(--accent-soft); }
.files-row[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent) !important; }
.files-row-text { display:flex; flex-direction:column; min-width:0; }
.files-row-name { color:var(--text-primary); font-weight:500; overflow-wrap:anywhere; }
.files-empty { min-height:88px; display:flex; flex-direction:column; justify-content:center; gap:4px; }
.files-empty-title { font-weight:600; }
.files-detail { display:flex; flex-direction:column; gap:8px; }
.files-detail > .files-actions { margin-top:4px; }
.files-editor-label { display:block; margin-top:8px; font-weight:600; }
.files-editor { display:block; width:100%; min-width:0; min-height:240px; max-height:60vh; resize:vertical; padding:12px; border:1px solid var(--card-border); border-radius:10px; background:var(--bg); color:var(--text-primary); font:13px/20px ui-monospace,SFMono-Regular,Menlo,monospace; }
.files-editor:disabled { cursor:not-allowed; opacity:.7; }
.files-recovered { display:flex; flex-direction:column; gap:8px; border-color:var(--warn-line); background:var(--warn-soft); }
.files-recovered-text { min-height:120px; }
.files-conflict { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid var(--warn-line); border-radius:10px; background:var(--warn-soft); }
.files-dialog-layer { position:absolute; top:var(--reai-plugin-titlebar-safe-top,44px); right:0; bottom:0; left:0; z-index:30; display:flex; align-items:flex-start; justify-content:center; padding:24px 16px; background:rgba(20,18,40,.3); backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); overflow:auto; }
.files-dialog { display:flex; flex-direction:column; gap:12px; width:min(560px,100%); padding:24px; border:1px solid var(--card-border); border-radius:14px; background:var(--bg); color:var(--text-primary); box-shadow:0 12px 32px rgba(20,18,40,.18); }
.files-dialog-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.files-chooser-list { max-height:320px; overflow:auto; }
.files-cloud-section { display:flex; flex-direction:column; gap:8px; }
.files-cloud-manual { display:flex; flex-direction:column; gap:8px; padding-top:12px; border-top:1px solid var(--divider); }
.files-cloud-manual .files-editor-label { margin-top:0; }
.files-input { width:100%; min-height:36px; padding:4px 12px; border:1px solid var(--card-border); border-radius:10px; background:var(--card-bg); color:var(--text-primary); font:inherit; }
.files-field-error { color:var(--text-primary); font-size:12px; padding:4px 8px; border-radius:6px; background:var(--alert-soft); }
@keyframes files-spin { to { transform:rotate(360deg); } }
@media (max-width:640px) { .files-columns { grid-template-columns:minmax(0,1fr); } }
@media (max-width:400px) { .files-app .files-main { padding:12px; } .files-actions > .files-btn { flex:1 1 auto; } .files-dialog { padding:16px; } }
@media (prefers-reduced-motion:reduce) { .files-spinner { animation:none; } }
`;

export function installFilesStyles(document: Document): () => void {
  const style = document.createElement("style");
  const hostStyle = document.querySelector<HTMLStyleElement>("style[nonce]");
  if (hostStyle?.nonce) style.nonce = hostStyle.nonce;
  style.textContent = FILES_STYLES;
  document.head.append(style);
  return () => style.remove();
}
