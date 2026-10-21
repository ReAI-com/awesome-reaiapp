import { defineContractSuite } from "@reai/app-test/v1";

/**
 * 合同套件跑的是真实插件代码接在 Mock Host 上：声明的界面和命令都注册了、
 * 界面能就绪、存储只落在本插件命名空间、挂载与标题栏动作不发网络请求。
 * 探针按钮的真实结果只能在 Driver 里验收，这里不跑网络探针。
 */
export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.20.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.example.capability-probe.ping", "com.example.capability-probe.back-to-root"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.example.capability-probe",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "测试按键命令记下触发时间",
      async run({ host }) {
        await host.invokeCommand("com.example.capability-probe.ping");
        await host.invokeCommand("com.example.capability-probe.ping");
        const key = "com.example.capability-probe/probe/probe.lastPing";
        if (!host.storageKeys().includes(key)) throw new Error(`没有写入触发记录：${host.storageKeys().join(", ")}`);
      },
    },
    {
      name: "标题栏「设置」打开设置页，底部有版本和关于插件",
      async run({ host }) {
        const main = await host.openSurface("main");
        if (!main.root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "contract-settings",
          payload: { type: "open-settings" },
        });
        const footer = main.root.querySelector(".cp-settings-footer");
        if (!footer) throw new Error("设置页没有打开");
        const labels = [...footer.querySelectorAll("button")].map((button) => button.textContent ?? "");
        if (!labels.some((label) => label.startsWith("版本 0.1.0")) || !labels.includes("关于插件")) {
          throw new Error(`设置页底部入口不对：${labels.join(" / ")}`);
        }
      },
    },
  ],
});
