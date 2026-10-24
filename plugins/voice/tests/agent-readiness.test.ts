import { describe, expect, test } from "bun:test";
import type { AgentBackendStatus } from "@reai/app-sdk/v1";
import { agentReadiness } from "../src/agent-readiness";
import manifest from "../app.manifest.json";

const status = (backend: AgentBackendStatus["backend"], available = false, downloadRequired = true): AgentBackendStatus =>
  ({ backend, available, downloadRequired, detail: "" });

describe("Voice follows the Host Agent selection and never ranks engines itself", () => {
  test("auto blocks on the first backend the Host lists when none is ready for Voice", () => {
    const pi = status("pi");
    expect(agentReadiness("auto", { backends: [pi, status("dsh")] })).toEqual({ kind: "blocked", status: pi });
  });

  test("auto uses whichever backend the Host reports ready, in Host order", () => {
    expect(agentReadiness("auto", { backends: [status("pi"), status("dsh", true, false), status("codex")] }))
      .toEqual({ kind: "ready", backend: "dsh" });
    expect(agentReadiness("auto", { backends: [status("pi", true, false)] }))
      .toEqual({ kind: "ready", backend: "pi" });
  });

  test("Host's explicit default cannot silently fall back to another ready runtime", () => {
    const pi = status("pi");
    const backends = [pi, status("dsh", true, false), status("codex")];
    expect(agentReadiness("auto", { backends, defaultBackend: "pi" })).toEqual({ kind: "blocked", status: pi });
    expect(agentReadiness("dsh", { backends, defaultBackend: "pi" })).toEqual({ kind: "ready", backend: "dsh" });
  });

  test("corrupt Host preferences block auto, but do not override an explicit plugin selection", () => {
    const snapshot = { backends: [status("pi", true, false)], defaultBackendError: "AGENT_PREFERENCE_INVALID" };
    expect(agentReadiness("auto", snapshot)).toEqual({ kind: "preference-invalid" });
    expect(agentReadiness("pi", snapshot)).toEqual({ kind: "ready", backend: "pi" });
  });

  test("the only runtime requirement left is the Agent runtime, consent-gated and optional", () => {
    expect(manifest.requirements.map((item) => item.provision.resourceId)).toEqual(["com.reai.runtime.pi"]);
    expect(manifest.requirements[0]).toMatchObject({
      required: false,
      requiredFor: ["capability:agent.session@1", "capability:agent.session@2"],
      provision: { installPolicy: "optional_on_demand", requiresConsent: true },
    });
  });

  test("unknown or absent backend status stays blocked; a runtime fault is not recast as installation", () => {
    expect(agentReadiness("dsh", { backends: [status("pi", true, false)] })).toEqual({ kind: "blocked", status: undefined });
    expect(agentReadiness("auto", { backends: [] })).toEqual({ kind: "blocked", status: undefined });
    const broken = status("pi", false, false);
    expect(agentReadiness("pi", { backends: [broken, status("dsh")] })).toEqual({ kind: "blocked", status: broken });
  });
});
