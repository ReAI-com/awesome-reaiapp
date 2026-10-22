/** 导出报告：版本、档位和每个探针的结果；开发者模式下另含错误码与诊断正文（已去掉已知格式的令牌，可能仍有路径或个人信息）。 */
import { CONTRACT_HOST_API, PLUGIN_APP_ID, PLUGIN_VERSION } from "./catalog";
import { scrub } from "./errors";
import type { ProbeResult } from "./probes";
import { passed, PROBES, runnableProbes, verdictOf } from "./probes";

export interface ReportInput {
  mode: "host" | "preview";
  hostVersion: string;
  developerMode: boolean | undefined;
  results: ReadonlyMap<string, ProbeResult>;
  /** 来自上次保存、本次没重测的探针。 */
  restored?: ReadonlySet<string>;
  now?: Date;
}

export function buildReport(input: ReportInput): string {
  const results = PROBES.filter((probe) => input.results.has(probe.id)).map((probe) => {
    const result = input.results.get(probe.id)!;
    return {
      probeId: probe.id,
      title: probe.title,
      capability: probe.capability,
      level: probe.level,
      outcome: result.outcome,
      verdict: verdictOf(result),
      passed: passed(result),
      summary: scrub(result.summary, 300),
      // 错误码和原始原因属于诊断信息，只在 Host 开发者模式打开时写进报告。
      ...(input.developerMode && result.code ? { code: result.code } : {}),
      ...(input.developerMode && result.detail ? { detail: scrub(result.detail, 300) } : {}),
      ...(input.restored?.has(probe.id) ? { restored: true } : {}),
      startedAt: result.startedAt,
      durationMs: result.durationMs,
    };
  });
  const report = {
    report: "capability-probe",
    schemaVersion: 2,
    generatedAt: (input.now ?? new Date()).toISOString(),
    plugin: { appId: PLUGIN_APP_ID, version: PLUGIN_VERSION, build: "P0（本地开发包）" },
    host: { mode: input.mode, version: input.hostVersion, developerMode: input.developerMode ?? null, contractHostApi: CONTRACT_HOST_API },
    acceptance: acceptanceOf(input.results),
    note: "本报告只证明这一次、这台电脑上的运行结果，不能当作其他版本的验收证据。",
    results,
  };
  return JSON.stringify(report, null, 2);
}

function acceptanceOf(results: ReadonlyMap<string, ProbeResult>) {
  const all = runnableProbes();
  const passedIds = all.filter((probe) => { const result = results.get(probe.id); return result !== undefined && passed(result); }).map((probe) => probe.id);
  return {
    total: all.length,
    passed: passedIds.length,
    notPassed: all.filter((probe) => results.has(probe.id) && !passedIds.includes(probe.id)).map((probe) => probe.id),
    untested: all.filter((probe) => !results.has(probe.id)).map((probe) => probe.id),
  };
}
