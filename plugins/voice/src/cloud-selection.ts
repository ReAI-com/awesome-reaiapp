import type { CloudAiClient, CloudModelOption } from "@reai/app-sdk/v1";

/** Same public option grammar as Host; provider/model identifiers stay in Host. */
export function validCloudOptionId(id: string): boolean {
  return id.length <= 64 && id !== "transcribe-default"
    && /^transcribe-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function selectedCloudOption(models: readonly CloudModelOption[], id: string) {
  return validCloudOptionId(id)
    ? models.find(model => model.kind === "transcribe" && model.id === id && (model as CloudModelOption & { enabled?: boolean }).enabled !== false)
    : undefined;
}

/** Account pricing is a current quote, never a perpetual free authorization. */
export function currentAccountPricing(model: CloudModelOption): boolean {
  return (model as CloudModelOption & { pricingContext?: string }).pricingContext === "current-account";
}
export function trustedAccountDefault(model: CloudModelOption): boolean {
  return model.kind === "transcribe" && validCloudOptionId(model.id)
    && (model as CloudModelOption & { enabled?: boolean }).enabled !== false
    && model.isDefault === true && currentAccountPricing(model);
}

export function cloudSelectionBillingPolicy(model: CloudModelOption, previousId: string, previousPolicy?: "free-only"): "free-only" | undefined {
  if (model.id === previousId && previousPolicy === "free-only") return previousPolicy;
  return trustedFreeDefault(model) ? "free-only" : undefined;
}

export function trustedFreeDefault(model: CloudModelOption): boolean {
  const metadata = model as CloudModelOption & { isDefault?: boolean; billingPolicy?: string; enabled?: boolean };
  return model.kind === "transcribe" && validCloudOptionId(model.id)
    && metadata.enabled !== false && metadata.isDefault === true && metadata.billingPolicy === "free"
    && !currentAccountPricing(model);
}

/** An enabled option Host currently prices as free: its default first, then Host order.
 * Only explicit `billingPolicy` counts; never infer free from a label or position. */
export function freeCloudOption(models: readonly CloudModelOption[]): CloudModelOption | undefined {
  const accountPriced = models.some(currentAccountPricing);
  const free = models.filter(model => (!accountPriced || currentAccountPricing(model))
    && model.kind === "transcribe" && validCloudOptionId(model.id)
    && (model as CloudModelOption & { enabled?: boolean }).enabled !== false && model.billingPolicy === "free");
  return free.find(model => model.isDefault === true) ?? free[0];
}

/** Preserve a valid choice. Without one, prefer a free option (new users start free),
 * then the current-account default, which may have any effective price.
 * An existing explicit free-only intent cannot be moved to another model automatically:
 * Host accepts free-only only for the account's free default, which plugins cannot see. */
export function preferredCloudOption(models: readonly CloudModelOption[], id: string, policy?: "free-only") {
  const selected = selectedCloudOption(models, id);
  if (selected) return selected;
  if (id && policy === "free-only") return undefined;
  const free = freeCloudOption(models);
  if (free) return free;
  if (models.some(currentAccountPricing)) return models.find(trustedAccountDefault);
  return models.find(trustedFreeDefault);
}

/** The Host-injected SDK must preserve the constraint, and Host must confirm
 * current billing. Cached metadata cannot authorize execution after a downgrade. */
export async function assertFreeOnlyCloudExecution(
  client: Pick<CloudAiClient, "listModels"> & { readonly freeOnlyTranscriptionSupported?: true },
  id: string,
  policy?: "free-only",
): Promise<void> {
  if (policy !== "free-only") return;
  if (client.freeOnlyTranscriptionSupported !== true) {
    throw Object.assign(new Error("HOST_API_INCOMPATIBLE"), { code: "HOST_API_INCOMPATIBLE" });
  }
  const models = await client.listModels();
  const selected = selectedCloudOption(models, id);
  if (!selected || selected.billingPolicy !== "free") {
    throw Object.assign(new Error("CLOUD_MODEL_SELECTION_REQUIRED"), { code: "CLOUD_MODEL_SELECTION_REQUIRED" });
  }
}
