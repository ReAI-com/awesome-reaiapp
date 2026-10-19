import { defineContractSuite } from "@reai/app-test/v1";

export default defineContractSuite({
  appDirectory: "..", hostApi: "1.25.0",
  expect: {
    surfaces: ["main"], commands: [], intents: [], readySurfaces: ["main"],
    forbiddenNetworkRequests: "all", noResourcesAfterUnmount: true,
  },
  scenarios: [{
    name: "Host 未开放 resources.files@1 时说明原因，不伪造数据或原生文件选择",
    async run({ host }) {
      const surface = await host.openSurface("main");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = surface.root?.textContent ?? "";
      if (!text.includes("文件访问暂未开放") && !text.includes("File access is not available yet")) throw new Error(`Not-open state missing: ${text.slice(0, 200)}`);
      if (surface.root?.querySelector('input[type="file"]')) throw new Error("Native file input forbidden");
      if (surface.root?.querySelector(".files-row")) throw new Error("No entries may render without the Host provider");
    },
  }],
});
