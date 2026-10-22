import { isExternalWebUrl } from "@reai/chat-ui";
import { t } from "./voice-i18n";

/** The installed Host supplies this optional method. Driver 1.0.5 does not. */
export async function openVoiceSourceLink(surfaces: { openExternal?: (url: string) => Promise<void> }, url: string): Promise<void> {
  if (!isExternalWebUrl(url)) throw { code: "EXTERNAL_LINK_INVALID", userMessage: t("chat.openSourceFailed") };
  if (typeof surfaces.openExternal !== "function") {
    throw { code: "EXTERNAL_LINK_UNAVAILABLE", userMessage: t("chat.openSourceUnavailable") };
  }
  try { await surfaces.openExternal(url); }
  catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "EXTERNAL_LINK_OPEN_FAILED";
    throw { code, userMessage: t("chat.openSourceFailed") };
  }
}
