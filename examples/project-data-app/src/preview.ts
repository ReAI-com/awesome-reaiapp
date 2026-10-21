import "./app.css";
import type { LocaleSnapshot, UiLocale } from "@reai/app-sdk/v1";
import { createDataClient, DATA_ORIGIN } from "./data-client";
import { mountDataView } from "./data-view";

const listeners = new Set<(snapshot: LocaleSnapshot) => void>();
let snapshot: LocaleSnapshot = { locale: "en", revision: 0 };
const locale = { getSnapshot: () => snapshot, onChange(handler: (snapshot: LocaleSnapshot) => void) { listeners.add(handler); handler(snapshot); return () => { listeners.delete(handler); }; } };
// Preview-only transport: all business requests terminate at the loopback fixture.
const client = createDataClient({ fetch: async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== DATA_ORIGIN || !url.pathname.startsWith("/projects/")) throw new Error("Fixture URL rejected");
  return fetch(`${location.origin}/fixture${url.pathname}${url.search}`, init);
} });
mountDataView(document.getElementById("root")!, client, locale, true);
document.querySelector<HTMLSelectElement>("#language")!.onchange = event => {
  snapshot = { locale: (event.target as HTMLSelectElement).value as UiLocale, revision: snapshot.revision + 1 }; listeners.forEach(handler => handler(snapshot));
};
document.querySelector<HTMLSelectElement>("#theme")!.onchange = async event => {
  const tokens = await fetch(`/tokens/${(event.target as HTMLSelectElement).value}`).then(response => response.json());
  Object.entries(tokens).forEach(([name, value]) => document.documentElement.style.setProperty(`--${name}`, String(value)));
};
for (const action of ["allow", "deny", "slow"])
  document.querySelector<HTMLButtonElement>(`[data-fixture="${action}"]`)!.onclick = () => { void fetch(`/fixture-state/${action}`, { method: "POST" }); };
