import { defineContractSuite } from "@reai/app-test/v1";
export default defineContractSuite({
  appDirectory: "..", hostApi: "1.25.0",
  expect: { surfaces: ["main"], commands: [], intents: [], readySurfaces: ["main"], forbiddenNetworkRequests: "all", noResourcesAfterUnmount: true },
  scenarios: [{ name: "default OAuth placeholder stays closed through the Surface lifecycle", async run({ host }) {
    const surface = await host.openSurface("main"); const load = surface.root?.querySelector<HTMLButtonElement>('[data-action="load"]');
    if (!load?.disabled) throw new Error("Placeholder OAuth client must fail closed"); load.click(); host.setLocale("en");
    if (host.networkRequests.length) throw new Error("Default Surface issued a cloud request");
  } }],
});
