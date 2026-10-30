#!/usr/bin/env node
/**
 * Scrub author emails from THIRD-PARTY-NOTICES.txt before commit / after regen.
 * Public gate blocks real-email; license attribution keeps names, not mailboxes.
 * Usage: node open-website/scripts/scrub-notices-emails.mjs [path]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(
  process.argv[2] ?? new URL("../legal/THIRD-PARTY-NOTICES.txt", import.meta.url).pathname,
);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const before = readFileSync(target, "utf8");
const after = before.replace(EMAIL, "author@example.com");
if (after === before) {
  console.log(`unchanged: ${target}`);
} else {
  writeFileSync(target, after);
  const n = (before.match(EMAIL) || []).length;
  console.log(`scrubbed ${n} email(s): ${target}`);
}
