import { defineContractSuite } from "@reai/app-test/v1";
export default defineContractSuite({
  appDirectory: "..", hostApi: "1.24.0",
  expect: { surfaces: ["main"], commands: [], intents: [], readySurfaces: ["main"], forbiddenNetworkRequests: "all", noResourcesAfterUnmount: true },
  scenarios: [{ name: "未配置client的示例默认关闭云请求", async run({ host }) {
    const surface = await host.openSurface("main");
    const start = surface.root?.querySelector<HTMLButtonElement>('[data-action="start"]');
    if (!start?.disabled) throw new Error("Placeholder OAuth client must fail closed");
    start.click();
    if (host.networkRequests.length) throw new Error("Idle Surface issued a cloud request");
  } }],
});
