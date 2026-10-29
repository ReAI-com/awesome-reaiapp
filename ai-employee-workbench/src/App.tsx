import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownUp,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Database,
  FileOutput,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type { Workspace, WorkspaceState } from "../shared/types";
import { activeStatus, request } from "./api";
import { AgentsView } from "./AgentsView";
import { AuthGate, type AuthSession } from "./AuthGate";
import { ChatPanel } from "./ChatPanel";
import { Field, InlineError, Modal, Spinner } from "./components";
import { WorkbenchContext } from "./context";
import {
  DatabaseView,
  FilesView,
  Overview,
  RunsView,
  SpecsView,
} from "./DataViews";
import { BoardsView, ChecksView, DeliverablesView } from "./WorkViews";
import { FinanceView } from './FinanceView';

const names: Record<string, string> = {
  overview: "工作总览",
  files: "资料库",
  specs: "清洗规范",
  runs: "运行记录",
  boards: "主题看板",
  deliverables: "交付台",
  checks: "规则检查",
  data: "结构化数据库",
  agents: "Agent 配置",
  finance: "财务账套",
};
const mainNav = [
  { id: "overview", label: "工作总览", icon: LayoutDashboard },
  { id: "files", label: "资料库", icon: FolderOpen },
  { id: "specs", label: "清洗规范", icon: ArrowDownUp },
  { id: "finance", label: "财务账套", icon: Database },
  { id: "deliverables", label: "交付台", icon: FileOutput },
  { id: "checks", label: "规则检查", icon: ShieldCheck },
];

export default function App() {
  return <AuthGate>{(session, logout) => <Workbench key={session.user?.sub || 'local'} session={session} logout={logout} />}</AuthGate>;
}

const managementViews = new Set(['data', 'agents', 'specs']);

function Workbench({ session, logout }: { session: AuthSession; logout: () => Promise<void> }) {
  const canAdmin = !session.enabled || session.user?.role === 'admin';
  const [loggingOut, setLoggingOut] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const selected = useRef("");
  const [state, setState] = useState<WorkspaceState | null>(null);
  const latest = useRef<WorkspaceState | null>(null);
  const refreshSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState("overview");
  const views = useRef<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 1200);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1050px)");
    const closeOnNarrow = (event: MediaQueryListEvent) => { if (event.matches) setChatOpen(false); };
    narrow.addEventListener("change", closeOnNarrow);
    return () => narrow.removeEventListener("change", closeOnNarrow);
  }, []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const base = `/api/workspaces/${workspaceId}`;
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimeout.current);
    toastTimeout.current = setTimeout(
      () => setToast(null),
      error ? 8000 : 4000,
    );
  }, []);
  const changeWorkspace = useCallback((id: string) => {
    selected.current = id;
    setWorkspaceId(id);
    setState(null);
    latest.current = null;
    setLoadError("");
    const remembered = views.current[id] || localStorage.getItem(`employee-workbench:view:${id}`) || 'overview';
    const restored = !canAdmin && managementViews.has(remembered) ? 'overview' : remembered;
    setView(names[restored] || restored.startsWith('board:') ? restored : 'overview');
    if (canAdmin && (restored === 'data' || restored === 'agents')) setAdmin(true);
    setWorkspaceMenu(false);
    setSidebarOpen(false);
    localStorage.setItem("employee-workbench:workspace", id);
  }, [canAdmin]);
  const bootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await request<{
        workspaces: Workspace[];
        version: string;
      }>("/api/bootstrap");
      setWorkspaces(result.workspaces);
      const remembered = localStorage.getItem("employee-workbench:workspace");
      const id =
        result.workspaces.find((item) => item.id === remembered)?.id ||
        result.workspaces[0]?.id;
      if (id) changeWorkspace(id);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [changeWorkspace]);
  useEffect(() => {
    void bootstrap();
    return () => clearTimeout(toastTimeout.current);
  }, [bootstrap]);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const sequence = ++refreshSequence.current;
    const value = await request<WorkspaceState>(
      `/api/workspaces/${workspaceId}/state`,
    );
    if (selected.current !== workspaceId || sequence !== refreshSequence.current)
      return;
    setState(value);
    latest.current = value;
    setLoadError("");
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (error) {
        if (alive && selected.current === workspaceId)
          setLoadError((error as Error).message);
      }
      if (alive)
        timer = setTimeout(
          () => void poll(),
          latest.current?.runs.some((run) => activeStatus(run.status))
            ? 2000
            : 5000,
        );
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workspaceId, refresh]);
  const mutate = useCallback(
    async <T,>(path: string, body?: unknown, method = "POST"): Promise<T> => {
      const result = await request<T>(`${base}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await refresh().catch((error) => {
        if (selected.current === workspaceId)
          setLoadError(`操作已保存，但列表刷新失败：${(error as Error).message}`);
      });
      return result;
    },
    [base, refresh, workspaceId],
  );
  const navigate = useCallback(
    (target: string) => {
      if (!canAdmin && managementViews.has(target)) { notify('该功能需要铆钉管理员权限', true); return; }
      if (target === "data" || target === "agents") setAdmin(true);
      setView(target);
      views.current[workspaceId] = target;
      localStorage.setItem(`employee-workbench:view:${workspaceId}`, target);
      setSidebarOpen(false);
    },
    [workspaceId, canAdmin, notify],
  );
  async function created(workspace: Workspace) {
    setWorkspaces((prev) => [
      ...prev.filter((w) => w.id !== workspace.id),
      workspace,
    ]);
    changeWorkspace(workspace.id);
    setCreateOpen(false);
    notify("岗位工作区已创建");
  }
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const navButton = (item: (typeof mainNav)[number]) => (
    <button
      key={item.id}
      className={`nav-item ${view === item.id ? "selected" : ""}`}
      onClick={() => navigate(item.id)}
    >
      <item.icon size={18} />
      <span>{item.label}</span>
      {item.id === "files" && !!state?.files.length && (
        <small>{state.files.length}</small>
      )}
    </button>
  );
  const readyState = state?.workspace.id === workspaceId ? state : null;
  return (
    <>
      <div
        className={`app-shell ${chatOpen && readyState ? "" : "chat-closed"}`}
      >
        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate("overview");
            }}
          >
            <span className="brand-logo">
              <i />
              <i />
              <i />
            </span>
            <span>
              铆钉<small>AI 员工工作台</small>
            </span>
            <span className="brand-version">3.0</span>
          </a>
          <div className="workspace-switch">
            <button
              onClick={() => setWorkspaceMenu(!workspaceMenu)}
              className="workspace-button"
              aria-expanded={workspaceMenu}
              aria-label="切换岗位工作区"
            >
              <span className="workspace-avatar">
                {readyState?.workspace.name[0] || "岗"}
              </span>
              <span>
                <b>{readyState?.workspace.name || "我的工作区"}</b>
                <small>岗位工作空间</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {workspaceMenu && (
              <div className="workspace-dropdown">
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    onClick={() => changeWorkspace(workspace.id)}
                  >
                    <span>{workspace.name}</span>
                    {workspace.id === workspaceId && <Check size={15} />}
                  </button>
                ))}
                {canAdmin && <button
                  onClick={() => {
                    setWorkspaceMenu(false);
                    setCreateOpen(true);
                  }}
                >
                  <Plus size={15} />
                  创建岗位工作区
                </button>}
              </div>
            )}
          </div>
          <nav className="main-nav" aria-label="工作区导航">
            <span className="nav-heading">工作空间</span>
            {mainNav.filter(item => canAdmin || !managementViews.has(item.id)).map(navButton)}
            <button
              className={`nav-item expert-nav ${chatOpen ? "selected" : ""}`}
              aria-label="打开岗位专家侧栏"
              aria-expanded={chatOpen}
              aria-controls="job-expert-panel"
              onClick={() => { setChatOpen(true); setSidebarOpen(false); }}
              disabled={!readyState}
            >
              <Sparkles size={18} />
              <span>岗位专家</span>
              <small>Agent</small>
            </button>
            <div className="nav-heading between">
              <span>主题看板</span>
              <button
                className="icon-button"
                onClick={() => navigate("boards")}
                aria-label="管理主题看板"
              >
                <Plus size={15} />
              </button>
            </div>
            <button
              className={`nav-item ${view === "boards" ? "selected" : ""}`}
              onClick={() => navigate("boards")}
            >
              <LayoutDashboard size={18} />
              <span>全部看板</span>
            </button>
            {state?.boards
              .filter((b) => b.status === "published")
              .map((board) => (
                <button
                  className={`nav-item board-nav ${view === `board:${board.id}` ? "selected" : ""}`}
                  onClick={() => navigate(`board:${board.id}`)}
                  key={board.id}
                >
                  <span className="nav-board-dot" />
                  <span>{board.name}</span>
                </button>
              ))}
            {!state?.boards.some((b) => b.status === "published") && (
              <p className="nav-empty">为岗位添加专属的工作界面</p>
            )}
            {canAdmin && admin && (
              <>
                <span className="nav-heading">管理工具</span>
                {navButton({
                  id: "data",
                  label: "结构化数据库",
                  icon: Database,
                })}
                {navButton({
                  id: "agents",
                  label: "Agent 配置",
                  icon: Settings2,
                })}
              </>
            )}
          </nav>
          <div className="sidebar-footer">
            <button
              className={`nav-item ${view === "runs" ? "selected" : ""}`}
              onClick={() => navigate("runs")}
            >
              <Workflow size={18} />
              <span>运行记录</span>
              {!!state?.runs.filter((r) => activeStatus(r.status)).length && (
                <span className="live-dot" />
              )}
            </button>
            {canAdmin && <button
              className={`admin-toggle ${admin ? "on" : ""}`}
              role="switch"
              aria-checked={admin}
              onClick={() => {
                setAdmin(!admin);
                if (admin && ["data", "agents"].includes(view))
                  navigate("overview");
              }}
            >
              <Settings2 size={16} />
              <span>管理员模式</span>
              <i />
            </button>}
            {session.user && <div className="session-user">
              <div><b>{session.user.name || session.user.email || '外脑用户'}</b><small>{session.user.role === 'admin' ? '铆钉管理员' : '工作区成员'}</small></div>
              <button className="icon-button" aria-label="退出登录" title="退出登录" disabled={loggingOut} onClick={() => { setLoggingOut(true); void logout().catch(error => { notify(error.message, true); setLoggingOut(false); }); }}>{loggingOut ? <Spinner /> : <LogOut size={16} />}</button>
            </div>}
            <div className="local-footer">
              <span className="live-dot" />
              <span>{session.enabled ? "铆钉 · 已验证身份" : "铆钉 · 单用户"}</span>
              <small>v3.0.0</small>
            </div>
          </div>
        </aside>
        {sidebarOpen && (
          <button
            className="sidebar-scrim"
            onClick={() => setSidebarOpen(false)}
            aria-label="关闭导航"
          />
        )}
        <main className="main-workspace">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>{readyState?.workspace.name || "铆钉"}</span>
              <span>/</span>
              <b>
                {view.startsWith("board:")
                  ? readyState?.boards.find((b) => `board:${b.id}` === view)
                      ?.name || "看板"
                  : names[view]}
              </b>
            </div>
            <div className="topbar-right">
              <span className="local-status">
                <span className="live-dot" />
                {session.enabled ? '云端工作区' : '本地工作区'}
              </span>
              <button
                className={`button small chat-toggle ${chatOpen ? "active" : ""}`}
                aria-label={chatOpen ? "收起岗位专家侧栏" : "打开岗位专家侧栏"}
                aria-expanded={chatOpen}
                aria-controls="job-expert-panel"
                onClick={() => setChatOpen(!chatOpen)}
              >
                <Sparkles size={15} />
                岗位专家
              </button>
            </div>
          </header>
          {loadError && (
            <div className="connection-error" role="alert">
              <CircleAlert size={16} />
              {loadError}
              <button
                className="text-button"
                onClick={() =>
                  void (workspaceId
                    ? refresh().catch((e) => notify(e.message, true))
                    : bootstrap())
                }
              >
                重新连接
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-screen">
              <Spinner />
              <span>正在打开工作台…</span>
            </div>
          ) : !workspaceId ? (
            <div className="onboarding">
              <span className="eyebrow">A NEW WAY TO WORK</span>
              <div className="onboarding-mark">
                <Sparkles size={35} />
              </div>
              <h1>
                给你的 AI 员工，
                <br />
                <span>一个自己的工作空间。</span>
              </h1>
              <p>
                资料、数据、看板与岗位经验，都在{session.enabled ? '工作区' : '本地'}有序保存。
                <br />
                {canAdmin ? '从创建第一个岗位开始。' : '请联系管理员创建岗位工作区。'}
              </p>
              {canAdmin && <button
                className="button primary large"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={18} />
                创建岗位工作区
                <ArrowRight size={17} />
              </button>}
              <div className="onboarding-features">
                <span>
                  <FolderOpen size={17} />
                  {session.enabled ? '上传资料与原件' : '本地目录与原件'}
                </span>
                <span>
                  <Database size={17} />
                  可追溯的数据
                </span>
                <span>
                  <Bot size={17} />
                  专属岗位 Agent
                </span>
              </div>
            </div>
          ) : readyState ? (
            <WorkbenchContext.Provider
              value={{
                state: readyState,
                base,
                refresh,
                mutate,
                notify,
                navigate,
                admin: canAdmin && admin,
                canAdmin,
                oauthEnabled: session.enabled,
              }}
            >
              <div className="content-scroll">
                {view === "overview" ? (
                  <Overview />
                ) : view === "files" ? (
                  <FilesView key={workspaceId} />
                ) : view === "specs" && canAdmin ? (
                  <SpecsView key={workspaceId} />
                ) : view === "finance" ? (
                  <FinanceView key={workspaceId} />
                ) : view === "data" && canAdmin ? (
                  <DatabaseView key={workspaceId} />
                ) : view === "agents" && canAdmin ? (
                  <AgentsView key={workspaceId} />
                ) : view === "runs" ? (
                  <RunsView key={workspaceId} />
                ) : view === "deliverables" ? (
                  <DeliverablesView key={workspaceId} />
                ) : view === "checks" ? (
                  <ChecksView key={workspaceId} />
                ) : (
                  <BoardsView
                    key={workspaceId}
                    boardId={
                      view.startsWith("board:") ? view.slice(6) : undefined
                    }
                  />
                )}
              </div>
            </WorkbenchContext.Provider>
          ) : (
            <div className="loading-screen">
              <Spinner />
              <span>正在读取岗位资料…</span>
            </div>
          )}
        </main>
        {readyState && chatOpen && (
          <WorkbenchContext.Provider
            value={{
              state: readyState,
              base,
              refresh,
              mutate,
              notify,
              navigate,
              admin: canAdmin && admin,
              canAdmin,
              oauthEnabled: session.enabled,
            }}
          >
            <ChatPanel
              key={workspaceId}
              draft={drafts[workspaceId] || ""}
              setDraft={(value) =>
                setDrafts((prev) => ({ ...prev, [workspaceId]: value }))
              }
              onClose={() => setChatOpen(false)}
            />
          </WorkbenchContext.Provider>
        )}
      </div>
      {createOpen && canAdmin && (
        <CreateWorkspace remote={session.enabled} onClose={closeCreate} onCreated={created} />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleAlert size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}

function CreateWorkspace({
  remote,
  onClose,
  onCreated,
}: {
  remote: boolean;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await request<{ workspace: Workspace } | Workspace>(
        "/api/workspaces",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            role,
            ...(!remote && directory.trim() ? { directory: directory.trim() } : {}),
          }),
        },
      );
      onCreated("workspace" in result ? result.workspace : result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="创建岗位工作区"
      subtitle="每个岗位拥有自己的资料、数据、看板和 Agent 配置。"
      onClose={onClose}
    >
      <form onSubmit={create}>
        <Field label="岗位名称">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：财务助理"
            maxLength={80}
          />
        </Field>
        <Field label="岗位职责">
          <textarea
            required
            rows={4}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="例如：整理收支资料，分析经营状况，并协助核对财务数据。"
          />
        </Field>
        {remote ? <p className="footnote">应用会在服务器上创建独立工作目录。上传的文件与原件版本保存在该目录。</p> : <Field
          label="本地工作目录"
          hint="填写本机绝对路径；留空由应用创建独立目录。上传文件和原件版本保存在该工作区。"
        >
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/absolute/path/to/workspace"
          />
        </Field>}
        <InlineError>{error}</InlineError>
        <div className="form-footer">
          <button type="button" className="button subtle" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? <Spinner /> : <Plus size={16} />}创建工作区
          </button>
        </div>
      </form>
    </Modal>
  );
}
