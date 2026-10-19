import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/data";
import { createVoiceConfiguration, preparedVoiceSettings, withExplicitVoiceSource } from "../src/voice-configuration";

test("preparation does not repeat a successful configure, while explicit saves always apply", async () => {
  const calls: unknown[] = []; const configuration = createVoiceConfiguration(async settings => { calls.push(settings); });
  const settings = { ...DEFAULT_SETTINGS, audioSourcePreference: { kind: "prefer_computer" as const } };
  await configuration.apply(settings); await configuration.prepare(structuredClone(settings)); await configuration.prepare(settings);
  expect(calls).toHaveLength(1);
  await configuration.apply(settings); expect(calls).toHaveLength(2);
  await configuration.prepare({ ...settings, language: "en-US" }); expect(calls).toHaveLength(3);
});

test("failed writes are retried; request snapshots cannot borrow later mutations", async () => {
  const calls: any[] = []; let fail = true; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const configuration = createVoiceConfiguration(async settings => { calls.push(settings); if (fail) throw new Error("synthetic failure"); await gate; });
  await expect(configuration.prepare(DEFAULT_SETTINGS)).rejects.toThrow("synthetic failure");
  fail = false; const settings = structuredClone(DEFAULT_SETTINGS);
  const pending = configuration.prepare(settings); settings.language = "en-US";
  const newer = configuration.apply(settings); release(); await Promise.all([pending, newer]);
  expect(calls.slice(-2).map(item => item.language)).toEqual(["auto", "en-US"]);
  await configuration.prepare(settings); expect(calls).toHaveLength(3);
});

test("a hung preparation cannot block a fresh attempt or overwrite its cache when it completes late", async () => {
  const calls: any[] = []; let release!: () => void;
  const configuration = createVoiceConfiguration(async settings => { calls.push(settings); if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; }); });
  const old = configuration.prepare(DEFAULT_SETTINGS);
  const current = { ...DEFAULT_SETTINGS, language: "en-US" };
  await configuration.prepare(current);
  release(); await old; await configuration.prepare(current);
  expect(calls).toHaveLength(2);
});

test("explicit legacy source/endpoint choices remove stale automatic preference; ordinary edits preserve it", () => {
  const previous = { ...DEFAULT_SETTINGS, audioSourcePreference: { kind: "prefer_computer" as const } };
  expect(withExplicitVoiceSource(previous, { language: "en-US" }).audioSourcePreference).toEqual({ kind: "prefer_computer" });
  expect(withExplicitVoiceSource(previous, { source: "board" }).audioSourcePreference).toBeUndefined();
  expect(withExplicitVoiceSource(previous, { systemEndpointId: "synthetic-input" }).audioSourcePreference).toBeUndefined();
});

test("prepare never writes the audio source mode; explicit source saves do, ordinary saves do not", async () => {
  const calls: any[] = []; const configuration = createVoiceConfiguration(async settings => { calls.push(settings); });
  const settings = { ...DEFAULT_SETTINGS, audioSourcePreference: { kind: "board_only" as const } };
  await configuration.prepare(settings);
  expect(calls[0].audioSourcePreference).toBeUndefined();
  expect(calls[0].preserveAudioSourcePreference).toBe(true);
  await configuration.apply(settings);
  expect(calls[1]).toMatchObject({ audioSourcePreference: { kind: "board_only" } });
  expect(calls[1].preserveAudioSourcePreference).toBeUndefined();
  await configuration.apply({ ...settings, language: "en-US" }, { writeSource: false });
  expect(calls[2].audioSourcePreference).toBeUndefined();
  expect(calls[2].preserveAudioSourcePreference).toBe(true);
  // 旧来源迁移那一次交给 Host 判定，不带 preserve。
  expect(preparedVoiceSettings({ ...settings, legacySourceMigration: true })).toMatchObject({ legacySourceMigration: true, audioSourcePreference: { kind: "board_only" } });
});

test("an explicit mode choice is kept; picking a device inside computer-only stays in that mode", () => {
  const previous = { ...DEFAULT_SETTINGS, audioSourcePreference: { kind: "prefer_board" as const } };
  expect(withExplicitVoiceSource(previous, { source: "system", audioSourcePreference: { kind: "computer_only" } }).audioSourcePreference)
    .toEqual({ kind: "computer_only" });
  const computerOnly = { ...DEFAULT_SETTINGS, source: "system" as const, audioSourcePreference: { kind: "computer_only" as const } };
  expect(withExplicitVoiceSource(computerOnly, { systemEndpointId: "uid-2" }).audioSourcePreference).toEqual({ kind: "computer_only" });
});
