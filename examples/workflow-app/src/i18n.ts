import { compile, createCoreContext, fallbackWithLocaleChain, registerLocaleFallbacker, registerMessageCompiler, registerMessageResolver, resolveValue, translate } from "@intlify/core-base";
import type { LocaleClient } from "@reai/app-sdk/v1";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

// The same maintained Intlify engine as the Host, with its CSP-safe JIT compiler.
registerMessageCompiler(compile);
registerMessageResolver(resolveValue);
registerLocaleFallbacker(fallbackWithLocaleChain);
export function createMessages(locale?: LocaleClient) {
  const context = createCoreContext({
    locale: locale?.getSnapshot().locale ?? "zh", fallbackLocale: "en",
    messages: { zh, en }, missingWarn: false, fallbackWarn: false,
  });
  return {
    t(key: keyof typeof en): string { return String(translate(context, key)); },
    subscribe(render: () => void): () => void {
      if (!locale) { render(); return () => {}; }
      return locale.onChange(snapshot => { context.locale = snapshot.locale; render(); });
    },
  };
}
