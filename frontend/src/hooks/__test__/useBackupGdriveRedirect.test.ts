import { describe, expect, it, vi } from "vitest";
import { parseGdriveRedirect } from "../useBackupGdriveRedirect";

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));

describe("parseGdriveRedirect", () => {
  it("ignores unrelated queries", () => {
    expect(parseGdriveRedirect({})).toBeNull();
    expect(parseGdriveRedirect({ tab: "pro" })).toBeNull();
  });
  it("reports a successful connection", () => {
    expect(parseGdriveRedirect({ backupGdrive: "connected", destinationId: "d" })).toEqual({
      type: "success",
      text: "TXT_CODE_backup_ui.oauth_connected"
    });
  });
  it("maps every known error reason and falls back for unknown ones", () => {
    for (const reason of [
      "OAUTH_STATE_INVALID",
      "OAUTH_EXCHANGE_FAILED",
      "OAUTH_DENIED",
      "OAUTH_DESTINATION_CHANGED",
      "OAUTH_NO_REFRESH_TOKEN"
    ]) {
      expect(parseGdriveRedirect({ backupGdrive: "error", reason })).toEqual({
        type: "error",
        text: `TXT_CODE_backup_ui.oauth_error_${reason}`
      });
    }
    expect(parseGdriveRedirect({ backupGdrive: "error", reason: "<script>" })?.text).toBe(
      "TXT_CODE_backup_ui.oauth_error_UNKNOWN"
    );
  });
});
