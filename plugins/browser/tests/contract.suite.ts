import { BRIDGE_GLOBAL_KEY } from "@reai/app-sdk/v1";
import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件跑的是**真实 App 代码**接在 Mock Host 上。
 *
 * `expect.commands` 已断言 `com.reai.browser.open` 的声明与注册一致；浏览器引擎
 * （browser.* bridge 方法）默认在 Mock Host 里不存在——挂载路径对引擎调用全部
 * 容错降级（主页显示错误提示而不是白屏），真实引擎链路由 Host 侧测试与人工验收
 * 覆盖。locale 场景直接写入 Host bootstrap 同款 bridge 全局键，注入受控的
 * `browser.state` fixture（成功/空/失败），验证双语 DOM、状态保留与「切语言
 * 桥接零调用」；用完必须卸载，不污染后续场景。
 */

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FixtureTab {
  tabId: number;
  url: string;
  title: string;
  loading: boolean;
  openedByAgent: boolean;
}

interface FixtureState {
  tabs: FixtureTab[];
  activeTabId: number | null;
  agentTabId: number | null;
}

/** 受控引擎 fixture：写入 bridge 全局，记录全部调用，返回恢复函数。 */
function installEngineFixture(
  state: FixtureState | null,
  failure?: Error,
): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const global = globalThis as unknown as Record<string, unknown>;
  const previous = global[BRIDGE_GLOBAL_KEY];
  global[BRIDGE_GLOBAL_KEY] = {
    request: async <T,>(method: string, _params: unknown): Promise<T> => {
      calls.push(method);
      if (method === "browser.state") {
        if (failure) throw failure;
        return (state ? { ...state, tabs: [...state.tabs] } : null) as T;
      }
      throw new Error(`fixture-unknown-method: ${method}`);
    },
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete global[BRIDGE_GLOBAL_KEY];
      else global[BRIDGE_GLOBAL_KEY] = previous;
    },
  };
}

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.19.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.browser.open"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.browser",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "主页挂载后 ready（引擎不可用时降级为提示，不白屏）",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
      },
    },
    {
      name: "双语首屏与 zh→en→zh 切换保留节点/焦点，桥接调用为 0",
      async run({ host }) {
        const { calls, restore } = installEngineFixture({
          tabs: [
            { tabId: 1, url: "https://example.com/a", title: "Example Domain", loading: false, openedByAgent: true },
            { tabId: 2, url: "", title: "", loading: true, openedByAgent: false },
          ],
          activeTabId: 1,
          agentTabId: 2,
        });
        try {
        host.setLocale("en");
        const surface = await host.openSurface("main");
        const root = surface.root!;
        document.body.append(root);
        await pause();
        // 英文冷启动：首屏直接英文，真实网页标题与品牌名保持原文。
        if (root.querySelector<HTMLElement>(".rb-sub")?.textContent !== "Agent web actions appear in a half-screen drawer; the engine allows https only.") {
          throw new Error("Cold start was not English");
        }
        const rows = root.querySelectorAll<HTMLElement>(".rb-tab");
        if (rows.length !== 2) throw new Error(`Expected 2 tab rows, got ${rows.length}`);
        if (!rows[0]!.classList.contains("active")) throw new Error("Active tab marker lost");
        const titles = Array.from(root.querySelectorAll<HTMLElement>(".rb-tab-title")).map((n) => n.textContent);
        if (!titles[0]?.includes("Example Domain")) throw new Error("Real page title was replaced");
        if (titles[1] !== "Tab 2") throw new Error(`Fallback title not localized: ${titles[1]}`);
        if (root.querySelector<HTMLElement>(".rb-tab-badge.work")?.textContent !== "Working tab") {
          throw new Error("Work badge not localized");
        }
        const close = root.querySelector<HTMLElement>(".rb-tab-close");
        if (close?.getAttribute("title") !== "Close tab" || close.getAttribute("aria-label") !== "Close tab") {
          throw new Error("Close tooltip not localized");
        }
        // 焦点落在第二行标签上后切语言：节点、焦点、活动标记都保留。
        const focused = rows[1]!.querySelector<HTMLButtonElement>(".rb-tab-select")!;
        focused.focus();
        if (document.activeElement !== focused) throw new Error("Fixture row is not focusable");
        const before = calls.length;
        host.setLocale("zh"); await pause();
        if (root.querySelector<HTMLElement>(".rb-sub")?.textContent !== "Agent 的网页操作会以半屏抽屉呈现；引擎只放行 https。") {
          throw new Error("Locale did not switch to Chinese");
        }
        const rowsAfter = root.querySelectorAll<HTMLElement>(".rb-tab");
        if (rowsAfter[0] !== rows[0] || rowsAfter[1] !== rows[1]) throw new Error("Locale rebuilt tab rows");
        if (!rowsAfter[0]!.classList.contains("active")) throw new Error("Active tab marker lost on locale switch");
        if (Array.from(root.querySelectorAll<HTMLElement>(".rb-tab-title"))[1]?.textContent !== "标签 2") {
          throw new Error("Fallback title did not re-localize in place");
        }
        if (root.querySelector<HTMLElement>(".rb-tab-badge.work")?.textContent !== "工作标签") {
          throw new Error("Work badge did not re-localize");
        }
        if (root.querySelector<HTMLElement>(".rb-tab-close")?.getAttribute("title") !== "关闭标签") {
          throw new Error("Close tooltip did not re-localize");
        }
        if (document.activeElement !== focused) throw new Error("Locale switch lost focus");
        // 订阅回放与同值 setLocale（MockHost 对同值 no-op）下文字均幂等，
        // 且切语言不新增任何 browser.* 调用。
        host.setLocale("en"); await pause();
        host.setLocale("zh"); await pause();
        if (calls.length !== before) {
          throw new Error(`Locale switches issued bridge calls: ${calls.slice(before).join(", ")}`);
        }
        if (root.querySelectorAll<HTMLElement>(".rb-tab-title")[1]?.textContent !== "标签 2") {
          throw new Error("Repeated notifications broke idempotent text");
        }
        await host.unmountSurface(surface.surfaceMountId);
        root.remove();
        const afterUnmount = calls.length;
        host.setLocale("en"); await pause();
        if (calls.length !== afterUnmount) {
          throw new Error("Unmount left a locale subscription issuing bridge calls");
        }
        const reopened = await host.openSurface("main");
        await pause();
        const reopenedText = reopened.root?.querySelector<HTMLElement>(".rb-sub")?.textContent;
        if (reopenedText !== "Agent web actions appear in a half-screen drawer; the engine allows https only.") {
          throw new Error("Reopened surface used a stale locale");
        }
        await host.unmountSurface(reopened.surfaceMountId);
        reopened.root?.remove();
        } finally {
          restore();
        }
      },
    },
    {
      name: "空列表状态的空态文案跟随语言，切语言零调用",
      async run({ host }) {
        const { calls, restore } = installEngineFixture({ tabs: [], activeTabId: null, agentTabId: null });
        try {
        const surface = await host.openSurface("main");
        const root = surface.root!;
        document.body.append(root);
        await pause();
        if (root.querySelector<HTMLElement>(".rb-status")?.textContent !== "还没有打开的标签。") {
          throw new Error("Empty state was not Chinese");
        }
        const before = calls.length;
        host.setLocale("en"); await pause();
        if (root.querySelector<HTMLElement>(".rb-status")?.textContent !== "No tabs are open yet.") {
          throw new Error("Empty state did not follow the locale");
        }
        if (calls.length !== before) throw new Error("Empty-state locale switch issued bridge calls");
        await host.unmountSurface(surface.surfaceMountId);
        root.remove();
        } finally {
          restore();
        }
      },
    },
    {
      name: "多实例并发挂载各自跟随语言，逐个销毁不串扰",
      async run({ host }) {
        const { calls, restore } = installEngineFixture({
          tabs: [{ tabId: 1, url: "", title: "", loading: false, openedByAgent: false }],
          activeTabId: 1,
          agentTabId: null,
        });
        try {
          host.setLocale("en");
          const first = await host.openSurface("main");
          const second = await host.openSurface("main");
          const firstRoot = first.root!;
          const secondRoot = second.root!;
          document.body.append(firstRoot, secondRoot);
          await pause();
          if (firstRoot.querySelector<HTMLElement>(".rb-tab-title")?.textContent !== "Tab 1"
            || secondRoot.querySelector<HTMLElement>(".rb-tab-title")?.textContent !== "Tab 1") {
            throw new Error("Concurrent mounts did not share the current locale");
          }
          const before = calls.length;
          host.setLocale("zh"); await pause();
          if (firstRoot.querySelector<HTMLElement>(".rb-tab-title")?.textContent !== "标签 1"
            || secondRoot.querySelector<HTMLElement>(".rb-tab-title")?.textContent !== "标签 1") {
            throw new Error("A concurrent mount missed the locale change");
          }
          if (calls.length !== before) throw new Error("Locale switch issued bridge calls");
          // 只销毁第一个：第二个继续跟随语言，且不代领已销毁实例的更新。
          await host.unmountSurface(first.surfaceMountId); firstRoot.remove();
          host.setLocale("en"); await pause();
          if (secondRoot.querySelector<HTMLElement>(".rb-tab-title")?.textContent !== "Tab 1") {
            throw new Error("Surviving mount stopped following the locale");
          }
          if (calls.length !== before) throw new Error("Unmounted mount still issued bridge calls");
          await host.unmountSurface(second.surfaceMountId); secondRoot.remove();
        } finally {
          restore();
        }
      },
    },
    {
      name: "引擎失败时普通模式显示恢复动作并隐藏技术诊断",
      async run({ host }) {
        const { restore } = installEngineFixture(null, new Error("engine-offline-diagnostic"));
        try {
        host.setLocale("en");
        const surface = await host.openSurface("main");
        const root = surface.root!;
        document.body.append(root);
        await pause();
        const status = root.querySelector<HTMLElement>(".rb-status");
        if (status?.textContent !== "Cannot connect to Browser. Refresh to retry.") {
          throw new Error("Failure prefix not localized");
        }
        if (root.textContent?.includes("engine-offline-diagnostic")) throw new Error("Technical diagnostic visible in normal mode");
        if (!status?.classList.contains("error")) throw new Error("Error style class lost");
        host.setLocale("zh"); await pause();
        if (root.querySelector<HTMLElement>(".rb-status")?.textContent !== "浏览器暂时无法连接，请刷新重试。") {
          throw new Error("Failure prefix did not follow the locale");
        }
        await host.unmountSurface(surface.surfaceMountId);
        root.remove();
        } finally {
          restore();
        }
      },
    },
  ],
});
