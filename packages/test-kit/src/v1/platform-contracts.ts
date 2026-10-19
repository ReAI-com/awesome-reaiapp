/** Contract-only fixture. It cannot prove any real Host implementation or authorization. */
import { AppError, PLATFORM_CONTRACTS, type PlatformCapabilitySnapshot } from "@reai/app-sdk/v1";

export function unavailablePlatformSnapshot(): PlatformCapabilitySnapshot {
  return {
    version: 1,
    capabilities: Object.fromEntries(Object.entries(PLATFORM_CONTRACTS.capabilities).map(([id, descriptor]) => [
      id, { version: 1 as const, available: false, methods: [...descriptor.methods] },
    ])),
  };
}
export class UnavailablePlatformContractHost {
  readonly snapshot = unavailablePlatformSnapshot();
  async request(_method: string, _input: unknown): Promise<never> {
    throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "合同已冻结，Host 尚未实现该能力", retryable: false });
  }
}
