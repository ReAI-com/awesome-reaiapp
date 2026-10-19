import { expect, test } from "bun:test";
import { isPlatformCapabilityAvailable, PLATFORM_CONTRACTS } from "@reai/app-sdk/v1";
import { unavailablePlatformSnapshot, UnavailablePlatformContractHost } from "../src/v1/platform-contracts";

test("contract fixture never turns declaration into runtime availability", async () => {
  const fixture = new UnavailablePlatformContractHost();
  for (const [id, descriptor] of Object.entries(PLATFORM_CONTRACTS.capabilities)) {
    expect(isPlatformCapabilityAvailable(fixture.snapshot, id)).toBe(false);
    for (const method of descriptor.methods) {
      await expect(fixture.request(method, {})).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE", retryable: false });
    }
  }
  await expect(fixture.request("unknown.method", {})).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE" });
});
test("each fixture owns a fresh snapshot", () => {
  const first = unavailablePlatformSnapshot();
  first.capabilities["audio.capture@1"]!.available = true;
  expect(unavailablePlatformSnapshot().capabilities["audio.capture@1"]!.available).toBe(false);
  // The shared registry may describe an implemented capability; the unavailable fixture never does.
  expect(PLATFORM_CONTRACTS.capabilities["audio.capture@1"].available).toBe(true);
});
