import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.25.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.terminal.back-to-root", "com.reai.terminal.open-settings"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.terminal",
    noResourcesAfterUnmount: true,
  },
  scenarios: [{
    name: "从 Host 会话列表挂载真实终端 Surface",
    async run({ host, expect }) {
      const main = await host.openSurface("main");
      expect(main).toBeOpen();
    },
  }],
});
