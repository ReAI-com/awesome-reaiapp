import { expect, test } from "bun:test";
import { openVoiceSourceLink } from "../src/voice-source-links";

test("source click calls the installed Host opener", async () => {
  const urls: string[] = [];
  await openVoiceSourceLink({ async openExternal(url) { urls.push(url); } }, "https://example.com/source");
  expect(urls).toEqual(["https://example.com/source"]);
});
test("old Hosts give an update instruction and retain the selectable source URL", async () => {
  await expect(openVoiceSourceLink({}, "https://example.com/source")).rejects.toMatchObject({ code: "EXTERNAL_LINK_UNAVAILABLE" });
});
test("unsafe targets never reach the Host", async () => {
  let calls = 0;
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "mailto:a@example.com", "https://user:pass@example.com/"]) {
    await expect(openVoiceSourceLink({ async openExternal() { calls++; } }, url)).rejects.toMatchObject({ code: "EXTERNAL_LINK_INVALID" });
  }
  expect(calls).toBe(0);
});

test("Host failures retain stable codes and use the current Voice language", async () => {
  await expect(openVoiceSourceLink({ async openExternal() { throw { code: "EXTERNAL_LINK_OPEN_FAILED", userMessage: "Host-only raw message" }; } }, "https://example.com/source")).rejects.toMatchObject({ code: "EXTERNAL_LINK_OPEN_FAILED" });
  try { await openVoiceSourceLink({ async openExternal() { throw { code: "EXTERNAL_LINK_OPEN_FAILED", userMessage: "Host-only raw message" }; } }, "https://example.com/source"); }
  catch (cause) { expect((cause as {userMessage:string}).userMessage).not.toContain("Host-only raw message"); }
});
