import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateManifest, type StableErrorCode } from "../src/validate";

const fixture = JSON.parse(readFileSync(new URL("../../contract/manifest-fixtures/v105-notification-scenes.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; manifest: unknown; codes: StableErrorCode[] }>;
};
for (const row of fixture.cases) {
  test(`notification declaration: ${row.name}`, () => {
    expect([...new Set(validateManifest(row.manifest).map(f => f.code))].sort()).toEqual([...row.codes].sort());
  });
}

test("notification declaration rejects an unpaired UTF-16 surrogate", () => {
  const row = structuredClone(fixture.cases.find(row => row.codes.length === 0 && (row.manifest as any).contributes.notificationScenes?.length)!);
  (row.manifest as any).contributes.notificationScenes[0].label = "\uD800";
  expect(validateManifest(row.manifest).some(f => f.code === "MANIFEST_SCHEMA_INVALID")).toBe(true);
});
