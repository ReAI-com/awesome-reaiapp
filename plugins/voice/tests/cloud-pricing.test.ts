import { expect, test } from "bun:test";
import type { CloudModelOption } from "@reai/app-sdk/v1";
import { cloudSelectionBillingPolicy, preferredCloudOption } from "../src/cloud-selection";
import { cloudAccountPriceLabel, currentAccountPrice } from "../src/cloud-pricing";
const model = { id: "transcribe-account", kind: "transcribe" as const, label: "Account model", isDefault: true,
 pricingContext: "current-account", billingPolicy: "free" as const,
 effectivePrice: { unit: "second", unitPriceCents: "0", baseUnitPriceCents: "0.1", reason: "subscription_price",
 ruleRevision: "rule", policyRevision: "policy", subscriptionRevision: "subscription", evaluatedAt: "2026-10-02T00:00:00Z", validUntil: null } } satisfies CloudModelOption;
test("exact zero and arbitrarily small decimal retain numeric account prices", () => {
 const tiny = `0.${"0".repeat(200)}1`;
 expect(currentAccountPrice(model)?.unitPriceCents).toBe("0");
 const tinyModel = { ...model, effectivePrice: { ...model.effectivePrice, unitPriceCents: tiny } };
 expect(currentAccountPrice(tinyModel)?.unitPriceCents).toBe(tiny);
 expect(cloudAccountPriceLabel(model)).toContain("0");
});
test("expired or invalid account quote is unavailable, never converted to a free label", () => {
 for (const changed of [{ unitPriceCents: "NaN" }, { unitPriceCents: "-1" }, { unitPriceCents: "1e-" }, { unitPriceCents: "-1e-7" }, { unitPriceCents: "1eNaN" }, { unitPriceCents: "1e-7 trailing" },
 { validUntil: "2020-01-01T00:00:00Z" }, { ruleRevision: "" }, { reason: "unknown" }]) {
  const option = { ...model, effectivePrice: { ...model.effectivePrice, ...changed } };
  // Deliberately malformed external input must be rejected at runtime.
  expect(currentAccountPrice(option as unknown as CloudModelOption)).toBeUndefined();
  expect(cloudAccountPriceLabel(option as unknown as CloudModelOption)).not.toContain("0 美分");
 }
});
test("account contract does not fall back to legacy free default or move explicit free-only", () => {
 const legacy = { id: "transcribe-legacy", kind: "transcribe" as const, label: "Legacy", isDefault: true, billingPolicy: "free" as const };
 expect(preferredCloudOption([{ ...model, isDefault: false }, legacy], "")?.id).toBe(model.id);
 expect(preferredCloudOption([{ ...model, billingPolicy: "metered", isDefault: false }, legacy], "")).toBeUndefined();
 expect(preferredCloudOption([model], "transcribe-stale", "free-only")).toBeUndefined();
 expect(preferredCloudOption([legacy], "")?.id).toBe("transcribe-legacy");
 expect(cloudSelectionBillingPolicy(legacy, "")).toBe("free-only");
 expect(cloudSelectionBillingPolicy(model, "")).toBeUndefined();
 expect(cloudSelectionBillingPolicy(model, model.id, "free-only")).toBe("free-only");
});

test("scientific account quotes retain exact zero exponents and tiny positive prices", () => {
 for (const value of ["1e-7", "1e-1000", "0e-7", "0.00E+1000", "1.25e+7"]) {
  const option = { ...model, effectivePrice: { ...model.effectivePrice, unitPriceCents: value, baseUnitPriceCents: "1e-7" } };
  expect(currentAccountPrice(option)?.unitPriceCents).toBe(value);
  expect(currentAccountPrice(option)?.baseUnitPriceCents).toBe("1e-7");
  expect(cloudAccountPriceLabel(option)).toContain(value);
 }
});
