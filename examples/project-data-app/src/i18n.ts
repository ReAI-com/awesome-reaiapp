import { compile, createCoreContext, fallbackWithLocaleChain, registerLocaleFallbacker, registerMessageCompiler, registerMessageResolver, resolveValue, translate } from "@intlify/core-base";
import type { LocaleClient } from "@reai/app-sdk/v1";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
registerMessageCompiler(compile); registerMessageResolver(resolveValue); registerLocaleFallbacker(fallbackWithLocaleChain);
export type MessageKey = Exclude<keyof typeof en, "metadata">;
export function createMessages(locale?: LocaleClient) {
  const context = createCoreContext({ locale: locale?.getSnapshot().locale ?? "zh", fallbackLocale: "en", messages: { zh, en }, missingWarn: false, fallbackWarn: false });
  return {
    t(key: MessageKey, values: Record<string, string | number> = {}): string { return String(translate(context, key, values)); },
    subscribe(render: () => void): () => void {
      if (!locale) { render(); return () => {}; }
      return locale.onChange(snapshot => { context.locale = snapshot.locale === "zh" ? "zh" : "en"; render(); });
    },
  };
}
