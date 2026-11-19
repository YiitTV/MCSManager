import { t } from "@/lang/i18n";

export interface GdriveRedirectResult {
  type: "success" | "error";
  text: string;
}

const REASONS = [
  "OAUTH_STATE_INVALID",
  "OAUTH_EXCHANGE_FAILED",
  "OAUTH_DENIED",
  "OAUTH_DESTINATION_CHANGED",
  "OAUTH_NO_REFRESH_TOKEN"
];

/**
 * The panel redirects the browser back to `#/settings?backupGdrive=connected|error[&reason=CODE]`
 * after the Google consent screen. Returns the message to show, or null when not a redirect.
 */
export function parseGdriveRedirect(query: Record<string, unknown>): GdriveRedirectResult | null {
  const state = query?.backupGdrive;
  if (state === "connected") {
    return { type: "success", text: t("TXT_CODE_backup_ui.oauth_connected") };
  }
  if (state === "error") {
    const reason = String(query.reason ?? "");
    const key = REASONS.includes(reason) ? reason : "UNKNOWN";
    return { type: "error", text: t(`TXT_CODE_backup_ui.oauth_error_${key}`) };
  }
  return null;
}
