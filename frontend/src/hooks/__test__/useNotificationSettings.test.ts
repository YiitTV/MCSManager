// Hook tests with a mocked notification API (the backend contract is design.md sections 5-8).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  rotate: vi.fn(),
  test: vi.fn()
}));

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));

vi.mock("@/services/apis/notification", () => ({
  NOTIFICATION_SECRET_PLACEHOLDER: "__MCSM_SECRET_DATA__",
  getNotificationConfig: () => ({ execute: mocks.get }),
  putNotificationConfig: () => ({ execute: mocks.put }),
  rotateNotificationSecret: () => ({ execute: mocks.rotate }),
  testNotification: () => ({ execute: mocks.test })
}));

import {
  checkNotificationUrl,
  notificationErrorText,
  useNotificationSettings
} from "@/hooks/useNotificationSettings";

const MASK = "__MCSM_SECRET_DATA__";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-";

const serverConfig = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  sinkType: "bot_http",
  url: "https://bot.example.com/minefield",
  secret: MASK,
  allowPrivateAddress: false,
  panelName: "Minefield Panel",
  events: { "instance.crashed": true, "instance.started": false },
  excludedInstances: ["d1::i1"],
  status: { queued: 1, sent: 2, failed: 3, dropped: 4 },
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ value: serverConfig() });
  mocks.put.mockImplementation(async ({ data }: any) => ({
    value: { ...data, status: serverConfig().status }
  }));
});

describe("checkNotificationUrl", () => {
  it("requires a URL only when enabled", () => {
    expect(checkNotificationUrl("", "bot_http", false, true)).toBe("required");
    expect(checkNotificationUrl("", "bot_http", false, false)).toBe("");
  });

  it("accepts the masked placeholder", () => {
    expect(checkNotificationUrl(MASK, "discord_webhook", false, true)).toBe("");
  });

  it("validates the webhook format", () => {
    expect(checkNotificationUrl(WEBHOOK, "discord_webhook", false, true)).toBe("");
    expect(checkNotificationUrl("https://example.com/x", "discord_webhook", false, true)).toBe(
      "webhook"
    );
    expect(
      checkNotificationUrl(
        "http://discord.com/api/webhooks/123456789/abc",
        "discord_webhook",
        false,
        true
      )
    ).toBe("webhook");
  });

  it("requires https for bots unless private addresses are allowed", () => {
    expect(checkNotificationUrl("http://10.0.0.5/hook", "bot_http", false, true)).toBe("https");
    expect(checkNotificationUrl("http://10.0.0.5/hook", "bot_http", true, true)).toBe("");
    expect(checkNotificationUrl("not a url", "bot_http", false, true)).toBe("format");
    expect(checkNotificationUrl("ftp://x.example.com", "bot_http", true, true)).toBe("https");
  });
});

describe("useNotificationSettings", () => {
  it("loads config and status", async () => {
    const s = useNotificationSettings();
    await s.load();
    expect(s.form.value.url).toBe("https://bot.example.com/minefield");
    expect(s.status.value.sent).toBe(2);
    expect(s.secretIsSet.value).toBe(true);
    expect(s.dirty.value).toBe(false);
  });

  it("sends masked placeholders back unchanged on save", async () => {
    mocks.get.mockResolvedValue({
      value: serverConfig({ sinkType: "discord_webhook", url: MASK })
    });
    const s = useNotificationSettings();
    await s.load();
    s.form.value.events["instance.started"] = true;
    expect(s.dirty.value).toBe(true);
    expect(await s.save()).toBe(true);
    const sent = mocks.put.mock.calls[0][0].data;
    expect(sent.secret).toBe(MASK);
    expect(sent.url).toBe(MASK);
    expect(sent.events["instance.started"]).toBe(true);
    expect(sent.status).toBeUndefined();
    expect(s.dirty.value).toBe(false);
  });

  it("sends a new URL when the admin edits it", async () => {
    const s = useNotificationSettings();
    await s.load();
    s.form.value.url = "https://other.example.com/x";
    await s.save();
    expect(mocks.put.mock.calls[0][0].data.url).toBe("https://other.example.com/x");
  });

  it("blocks save when enabled without URL or with too many exclusions", async () => {
    const s = useNotificationSettings();
    await s.load();
    s.form.value.url = "";
    expect(s.canSave.value).toBe(false);
    expect(await s.save()).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
    s.form.value.enabled = false;
    expect(s.canSave.value).toBe(true);
    s.form.value.excludedInstances = Array.from({ length: 201 }, (_, i) => `d::${i}`);
    expect(s.canSave.value).toBe(false);
  });

  it("clears a masked URL when the sink type changes", async () => {
    mocks.get.mockResolvedValue({
      value: serverConfig({ sinkType: "discord_webhook", url: MASK })
    });
    const s = useNotificationSettings();
    await s.load();
    s.setSinkType("bot_http");
    expect(s.form.value.url).toBe("");
  });

  it("rotates the secret, reveals plaintext once and stays masked", async () => {
    mocks.get.mockResolvedValue({ value: serverConfig({ secret: "" }) });
    mocks.rotate.mockResolvedValue({ value: { secret: "abc123" } });
    const s = useNotificationSettings();
    await s.load();
    expect(s.secretIsSet.value).toBe(false);
    await s.rotate();
    expect(s.revealedSecret.value).toBe("abc123");
    expect(s.form.value.secret).toBe(MASK);
    expect(s.dirty.value).toBe(false);
    s.dismissRevealedSecret();
    expect(s.revealedSecret.value).toBe("");
    await s.save();
    expect(mocks.put.mock.calls[0][0].data.secret).toBe(MASK);
  });

  it("test button states and results", async () => {
    const s = useNotificationSettings();
    expect(s.canTest.value).toBe(false);
    await s.load();
    expect(s.canTest.value).toBe(true);
    s.form.value.panelName = "Changed";
    expect(s.canTest.value).toBe(false);
    s.form.value.panelName = "Minefield Panel";

    mocks.test.mockResolvedValueOnce({ value: { ok: true, status: 204 } });
    mocks.get.mockResolvedValue({
      value: serverConfig({ status: { queued: 0, sent: 3, failed: 3, dropped: 4 } })
    });
    await s.test();
    expect(s.testResult.value).toEqual({ ok: true, status: 204 });
    expect(s.status.value.sent).toBe(3);
    expect(s.testing.value).toBe(false);

    mocks.test.mockResolvedValueOnce({ value: { ok: false, error: "timeout" } });
    await s.test();
    expect(s.testResult.value).toEqual({ ok: false, error: "timeout" });

    mocks.test.mockRejectedValueOnce(new Error("boom"));
    await s.test();
    expect(s.testResult.value?.ok).toBe(false);
    expect(s.testResult.value?.error).toBe("boom");
  });

  it("refreshStatus does not overwrite unsaved edits", async () => {
    const s = useNotificationSettings();
    await s.load();
    s.form.value.panelName = "Edited";
    mocks.get.mockResolvedValue({
      value: serverConfig({ status: { queued: 0, sent: 9, failed: 0, dropped: 0 } })
    });
    await s.refreshStatus();
    expect(s.form.value.panelName).toBe("Edited");
    expect(s.status.value.sent).toBe(9);
  });
});

describe("notificationErrorText", () => {
  it("translates every backend code and falls back for unknown ones", () => {
    for (const code of [
      "not_configured",
      "rate_limited",
      "timeout",
      "dns",
      "blocked_address",
      "invalid_url",
      "tls",
      "redirect",
      "http_4xx",
      "http_5xx",
      "network"
    ]) {
      expect(notificationErrorText(code)).toBe(`TXT_CODE_notification_ui.err_${code}`);
    }
    expect(notificationErrorText("nope")).toBe("TXT_CODE_notification_ui.err_unknown");
    expect(notificationErrorText(undefined)).toBe("TXT_CODE_notification_ui.err_unknown");
  });
});
