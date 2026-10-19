import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS } from "../src/data";
let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDom = true;
} });
afterAll(() => { if (ownsDom)
    GlobalRegistrator.unregister(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 6000) { const end = Date.now() + ms; while (!check() && Date.now() < end)
    await sleep(10); expect(check()).toBe(true); }
for (const entry of ["intent", "history-row", "presentation", "presentation-unmount"] as const) test(`cold hidden mount twice rejected; ${entry} automatically refreshes version without copying`, async () => {
    let visible = false, reads = 0;
    const readTimes: number[] = [];
    const host = new MockHost({ manifest: structuredClone(manifest) as never,
        loadApp: async () => {
            const { default: app } = await import("../src/app?cold-host=" + crypto.randomUUID());
            return { default: { ...app, async activate(ctx: AppContext) {
                        ctx.environment.get = async () => ({ developerMode: true });
                        const actualRead = ctx.systemTasks.getVersionStatus.bind(ctx.systemTasks);
                        ctx.systemTasks.getVersionStatus = async () => { reads++; readTimes.push(Date.now()); if (!visible)
                            throw { code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" }; return actualRead(); };
                        const store = ctx.storage.private("voice-state");
                        await store.set("recognition-engine-choice-v1", "local");
                        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
                        await store.set(COMMAND_HISTORY_KEY, [{ id: "cold-result", transcript: "Synthetic task", status: "failed", commandId: "voice.command.agent", createdAt: new Date().toISOString(), errorCode: "TEST_SYNTHETIC_FAILURE" }]);
                        return app.activate(ctx);
                    } } };
        }, createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
        systemTaskVersionStatus: { firmware: { updateAvailable: false, connected: false }, app: { currentVersion: "1.0.0-rc.2.17", updateAvailable: false, installable: false }, source: "unavailable" } as never });
    try {
        await host.installAndEnable();
        const surface = await host.openSurface("main");
        if (entry.startsWith("presentation")) {
            // Set the diagnostic view while still hidden. Presentation alone must refresh it later.
            surface.root!.querySelector<HTMLElement>('[data-voice-tab="command"]')!.click();
            surface.root!.querySelector<HTMLElement>(".command-history-item")!.click();
        }
        await until(() => reads === 2).catch((cause) => {
            throw new Error(`hidden-stage ${entry}: reads=${reads}, readTimes=${JSON.stringify(readTimes)}, root=${!!surface.root}`, { cause });
        });
        visible = true;
        const intent = { source: "host.taskConversation", payload: { entityId: "cold-result" } };
        if (entry === "presentation-unmount") {
            await host.presentSurface(surface.surfaceMountId);
            await host.unmountSurface(surface.surfaceMountId);
            await sleep(2700);
            expect(reads).toBe(2);
            await expect(host.presentSurface(surface.surfaceMountId)).rejects.toThrow();
            return;
        } else if (entry === "presentation") {
            await host.presentSurface(surface.surfaceMountId);
            await host.presentSurface(surface.surfaceMountId);
        } else if (entry === "intent") {
            await host.sendIntent(surface.surfaceMountId, intent);
            await host.sendIntent(surface.surfaceMountId, intent);
        } else {
            const tab = surface.root!.querySelector<HTMLElement>('[data-voice-tab="command"]');
            expect(tab).not.toBeNull();
            tab!.click();
            const row = surface.root!.querySelector<HTMLElement>(".command-history-item");
            expect(row).not.toBeNull();
            row!.click();
        }
        await until(() => !!surface.root?.textContent?.includes("1.0.0-rc.2.17")).catch(cause => {
            throw new Error(`visible-stage ${entry}: reads=${reads}, readTimes=${JSON.stringify(readTimes)}`, { cause });
        });
        expect(reads).toBe(3);
        // Voice 的 2.5 秒间隔从「准入」时刻起算，准入后先同步发布 loading（渲染界面）才真正调用 Host；
        // 这里量的是两次 Host 调用之间的间隔，前一次的渲染若比后一次慢（CI 满载时实测慢 84ms），
        // 量到的间隔就会比 2.5 秒短同样多。所以这里只守 Host 的硬约束「同一界面 2 秒一次」，
        // 准入间隔恰为 2500ms 由 voice-host-version.test.ts 的默认间隔用例用注入时钟确定性覆盖。
        expect(readTimes[2]! - readTimes[1]!).toBeGreaterThanOrEqual(2000);
        await host.sendIntent(surface.surfaceMountId, intent);
        await sleep(30);
        expect(reads).toBe(3);
    }
    finally {
        await host.disable();
    }
}, 15000);
