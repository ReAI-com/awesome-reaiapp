import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

type Dictionary = { [key: string]: string | Dictionary };
export type FilesLocale = "zh" | "en";
const dictionaries: Record<FilesLocale, Dictionary> = { zh, en };

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let value: string | Dictionary | undefined = dictionary;
  for (const part of key.split(".")) value = typeof value === "object" ? value[part] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The same plain-text resource adapter used by current official plugin examples. */
export function createTranslator(initial: string) {
  let locale: FilesLocale = initial === "zh" ? "zh" : "en";
  return {
    get locale() { return locale; },
    setLocale(value: string) { locale = value === "zh" ? "zh" : "en"; },
    has(key: string) { return lookup(en, key) !== undefined; },
    t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
      const value = lookup(dictionaries[locale], key) ?? lookup(en, key);
      if (value === undefined) console.warn(`[files i18n] Missing message: ${key}`);
      return (value ?? key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
        Object.hasOwn(params, name) ? String(params[name]) : token);
    },
  };
}
