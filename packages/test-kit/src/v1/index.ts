/** `@reai/app-test/v1` —— 合同测试工具公开面。 */

export { MockHost, MockHostError, flush } from "./mock-host";
export type {
  AppManifestLike,
  DeveloperPlatformMockHandler,
  MockHostOptions,
  MockNetworkResponse,
  MockNetworkHandler,
  SurfaceObservation,
} from "./mock-host";
export { defineContractSuite } from "./contract";
export type {
  CheckResult,
  ContractExpectations,
  ContractResult,
  ContractRuntime,
  ContractScenario,
  ContractSuite,
  ContractSuiteConfig,
  ScenarioApi,
  SurfaceMatchers,
} from "./contract";
export { unavailablePlatformSnapshot, UnavailablePlatformContractHost } from "./platform-contracts";
export { MockPlatformServices } from "./mock-platform-services";
export type { MockPlatformServicesFixture, MockPermissionDecision, MockNotificationLevel } from "./mock-platform-services";
