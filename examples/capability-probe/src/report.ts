/** 导出报告：只含版本、档位和每个探针的结果，不含令牌、绝对路径和用户数据正文。 */
import { CONTRACT_HOST_API, PLUGIN_APP_ID, PLUGIN_VERSION } from "./catalog";
import { scrub } from "./errors";
import type { ProbeResult } from "./probes";
import { PROBES } from "./probes";

export interface ReportInput {
  mode: "host" | "preview";
  hostVersion: string;
  developerMode: boolean | undefined;
  results: ReadonlyMap<string, ProbeResult>;
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
      summary: scrub(result.summary, 300),
      ...(result.code ? { code: result.code } : {}),
      ...(result.detail ? { detail: scrub(result.detail, 300) } : {}),
      startedAt: result.startedAt,
      durationMs: result.durationMs,
    };
  });
  const report = {
    report: "capability-probe",
    schemaVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    plugin: { appId: PLUGIN_APP_ID, version: PLUGIN_VERSION, build: "P0（本地开发包）" },
    host: { mode: input.mode, version: input.hostVersion, developerMode: input.developerMode ?? null, contractHostApi: CONTRACT_HOST_API },
    note: "本报告只证明这一次、这台电脑上的运行结果，不能当作其他版本的验收证据。",
    results,
  };
  return JSON.stringify(report, null, 2);
}
