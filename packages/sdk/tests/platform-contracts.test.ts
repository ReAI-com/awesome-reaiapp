import { describe, expect, test } from "bun:test";
import {
  PLATFORM_CONTRACTS,
  PLATFORM_CONTRACT_LIMITS,
  isPlatformCapabilityAvailable,
} from "../src/v1/platform-contracts";

describe("versioned platform contracts admission", () => {
  test("only implemented capabilities are available; declarations do not imply consent", () => {
    for (const [capability, descriptor] of Object.entries(PLATFORM_CONTRACTS.capabilities)) {
      expect(isPlatformCapabilityAvailable(undefined, capability)).toBe(false);
      expect(isPlatformCapabilityAvailable({}, capability)).toBe(false);
      expect(isPlatformCapabilityAvailable(PLATFORM_CONTRACTS, capability)).toBe(descriptor.available === true);
    }
    // v1.0.5 opened as grant-gated: still need per-call Host descriptor, approval and consent.
    for (const capability of ["surface.navigation@1", "audio.capture@1", "tasks.present@1", "notifications.publish@1", "resources.files@1"] as const) {
      expect(PLATFORM_CONTRACTS.capabilities[capability].available).toBe(true);
    }
  });
  test("missing, malformed and unknown descriptors fail closed", () => {
    const id = "audio.capture@1";
    for (const descriptor of [null, {}, { version: 2 }, { version: 1, capabilities: [] },
      { version: 1, capabilities: { [id]: { available: true } } },
      { version: 1, capabilities: { [id]: { version: 1, available: "true" } } }]) {
      expect(isPlatformCapabilityAvailable(descriptor, id)).toBe(false);
    }
    expect(isPlatformCapabilityAvailable({ version: 1, capabilities: {
      "attacker.unknown@1": { version: 1, available: true, methods: [] },
    } }, "attacker.unknown@1")).toBe(false);
    expect(isPlatformCapabilityAvailable({ version: 1, capabilities: Object.create({
      [id]: { version: 1, available: true, methods: PLATFORM_CONTRACTS.capabilities[id].methods },
    }) }, id)).toBe(false);
  });
  test("requires explicit matching version and the complete implemented method set", () => {
    const id = "audio.capture@1";
    const methods = [...PLATFORM_CONTRACTS.capabilities[id].methods];
    expect(isPlatformCapabilityAvailable({ version: 1, capabilities: {
      [id]: { version: 1, available: true, methods },
    } }, id)).toBe(true);
    expect(isPlatformCapabilityAvailable({ version: 1, capabilities: {
      [id]: { version: 1, available: true, methods: methods.slice(1) },
    } }, id)).toBe(false);
  });
  test("ten-minute mono f32 clip fits the bounded budget; queues and HTTP stay bounded", () => {
    expect(PLATFORM_CONTRACT_LIMITS.audio.maxRangeMs).toBe(600_000);
    const bytes = PLATFORM_CONTRACT_LIMITS.audio.sampleRate * 600 * 4;
    expect(bytes).toBeLessThanOrEqual(PLATFORM_CONTRACT_LIMITS.audio.maxClipBytes);
    expect(PLATFORM_CONTRACT_LIMITS.audio.maxClipBytes).toBeLessThanOrEqual(PLATFORM_CONTRACT_LIMITS.audio.maxBytesPerApp);
    expect(PLATFORM_CONTRACT_LIMITS.resources.maxChunkBytes).toBe(262_144);
    expect(PLATFORM_CONTRACTS.network.protocols).toEqual(["https:"]);
    expect(PLATFORM_CONTRACTS.network.lan).toBe(false);
    expect(PLATFORM_CONTRACTS.network.websocket).toBe(false);
    expect(PLATFORM_CONTRACTS.network.sse).toBe(false);
  });
});
