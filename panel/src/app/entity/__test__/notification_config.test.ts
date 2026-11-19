import { describe, expect, it } from "vitest";
import {
  applyConfigUpdate,
  EVENT_TYPES,
  generateSecret,
  MASKED_SECRET,
  maskConfig,
  NotificationConfig
} from "../notification_config";

const WEBHOOK =
  "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKLmnopqrstuvwxyz0123";

function codeOf(fn: () => unknown) {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
}

describe("NotificationConfig defaults", () => {
  it("is disabled with nine event keys all off", () => {
    const c = new NotificationConfig();
    expect(c.enabled).toBe(false);
    expect(c.sinkType).toBe("bot_http");
    expect(c.url).toBe("");
    expect(c.secret).toBe("");
    expect(c.allowPrivateAddress).toBe(false);
    expect(c.panelName).toBe("Minefield Panel");
    expect(Object.keys(c.events)).toHaveLength(9);
    expect(EVENT_TYPES).toHaveLength(9);
    expect(Object.values(c.events).every((v) => v === false)).toBe(true);
    expect(c.excludedInstances).toEqual([]);
  });
  it("instances do not share mutable state", () => {
    const a = new NotificationConfig();
    a.events["instance.crashed"] = true;
    expect(new NotificationConfig().events["instance.crashed"]).toBe(false);
  });
});

describe("maskConfig", () => {
  it("masks the secret when set, and the webhook url, but not a bot url", () => {
    const c = new NotificationConfig();
    c.url = "https://bot.example.com/hook";
    c.secret = "abc";
    let m = maskConfig(c);
    expect(m.secret).toBe(MASKED_SECRET);
    expect(m.url).toBe("https://bot.example.com/hook");
    c.sinkType = "discord_webhook";
    c.url = WEBHOOK;
    m = maskConfig(c);
    expect(m.url).toBe(MASKED_SECRET);
    expect(JSON.stringify(m)).not.toContain("abcDEF");
    expect(JSON.stringify(m)).not.toContain('"abc"');
  });
  it("shows empty strings when nothing is set", () => {
    const m = maskConfig(new NotificationConfig());
    expect(m.secret).toBe("");
    expect(m.url).toBe("");
  });
});

describe("applyConfigUpdate", () => {
  it("applies fields and reports changed names without values", () => {
    const { config, changed } = applyConfigUpdate(new NotificationConfig(), {
      enabled: true,
      url: "https://bot.example.com/hook",
      events: { "instance.crashed": true },
      excludedInstances: ["d1::i1", "d1::i1", "d2::i2"],
      panelName: " My Panel "
    });
    expect(config.enabled).toBe(true);
    expect(config.events["instance.crashed"]).toBe(true);
    expect(config.events["instance.started"]).toBe(false);
    expect(config.excludedInstances).toEqual(["d1::i1", "d2::i2"]);
    expect(config.panelName).toBe("My Panel");
    expect(changed.sort()).toEqual(["enabled", "events", "excludedInstances", "panelName", "url"]);
  });
  it("keeps the stored webhook url and secret when the placeholder is sent", () => {
    const cur = new NotificationConfig();
    cur.sinkType = "discord_webhook";
    cur.url = WEBHOOK;
    cur.secret = "keepme";
    const { config, changed } = applyConfigUpdate(cur, {
      url: MASKED_SECRET,
      secret: MASKED_SECRET,
      enabled: true
    });
    expect(config.url).toBe(WEBHOOK);
    expect(config.secret).toBe("keepme");
    expect(changed).toEqual(["enabled"]);
  });
  it("ignores a plaintext secret in the body (rotation only)", () => {
    const cur = new NotificationConfig();
    cur.secret = "old";
    expect(applyConfigUpdate(cur, { secret: "attacker" }).config.secret).toBe("old");
  });
  it("does not mutate the current config", () => {
    const cur = new NotificationConfig();
    applyConfigUpdate(cur, { events: { "instance.crashed": true } });
    expect(cur.events["instance.crashed"]).toBe(false);
  });
  it("rejects unknown event keys and bad types", () => {
    const cur = new NotificationConfig();
    expect(codeOf(() => applyConfigUpdate(cur, { events: { "nope.x": true } }))).toBe(
      "unknown_event"
    );
    expect(codeOf(() => applyConfigUpdate(cur, { events: { "notification.test": true } }))).toBe(
      "unknown_event"
    );
    expect(codeOf(() => applyConfigUpdate(cur, { events: { "instance.crashed": "yes" } }))).toBe(
      "invalid_field"
    );
    expect(codeOf(() => applyConfigUpdate(cur, { enabled: "true" }))).toBe("invalid_field");
    expect(codeOf(() => applyConfigUpdate(cur, { sinkType: "slack" }))).toBe("invalid_field");
    expect(codeOf(() => applyConfigUpdate(cur, null))).toBe("invalid_body");
    expect(codeOf(() => applyConfigUpdate(cur, []))).toBe("invalid_body");
  });
  it("enforces limits", () => {
    const cur = new NotificationConfig();
    const many = Array.from({ length: 201 }, (_, i) => `d::i${i}`);
    expect(codeOf(() => applyConfigUpdate(cur, { excludedInstances: many }))).toBe(
      "too_many_exclusions"
    );
    expect(
      applyConfigUpdate(cur, { excludedInstances: many.slice(0, 200) }).config.excludedInstances
    ).toHaveLength(200);
    expect(codeOf(() => applyConfigUpdate(cur, { excludedInstances: ["bad"] }))).toBe(
      "invalid_exclusion"
    );
    expect(codeOf(() => applyConfigUpdate(cur, { excludedInstances: [5] }))).toBe(
      "invalid_exclusion"
    );
    expect(codeOf(() => applyConfigUpdate(cur, { panelName: "x".repeat(41) }))).toBe("panel_name");
    expect(codeOf(() => applyConfigUpdate(cur, { panelName: "  " }))).toBe("panel_name");
    expect(applyConfigUpdate(cur, { panelName: "x".repeat(40) }).config.panelName).toHaveLength(40);
  });
  it("validates the url against the resulting sink type and requires one when enabled", () => {
    const cur = new NotificationConfig();
    expect(codeOf(() => applyConfigUpdate(cur, { url: "http://192.168.1.2/x" }))).toBe("scheme");
    expect(
      applyConfigUpdate(cur, { url: "http://192.168.1.2/x", allowPrivateAddress: true }).config.url
    ).toBe("http://192.168.1.2/x");
    expect(
      codeOf(() =>
        applyConfigUpdate(cur, {
          sinkType: "discord_webhook",
          url: "https://evil.com/api/webhooks/1/2"
        })
      )
    ).toBe("host_not_allowed");
    expect(codeOf(() => applyConfigUpdate(cur, { enabled: true }))).toBe("url_required");
  });
});

describe("generateSecret", () => {
  it("returns 64 hex chars and is random", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(a);
  });
});
