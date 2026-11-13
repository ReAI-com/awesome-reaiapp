import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.25.0",
  expect: {
    surfaces: ["main"],
    commands: [
      "com.reai.voice-chat.toggle-call",
      "com.reai.voice-chat.back-to-root",
      "com.reai.voice-chat.open-settings",
    ],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    storageNamespace: "com.reai.voice-chat",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "挂载极简语音对话主界面并正常卸载释放资源",
      async run({ host, expect }) {
        const main = await host.openSurface("main");
        expect(main).toBeOpen();
      },
    },
  ],
});
