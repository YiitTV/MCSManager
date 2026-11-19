import { describe, expect, it } from "vitest";
import {
  buildDiscordPayload,
  buildEvent,
  escapeDiscord,
  MAX_BODY_BYTES,
  renderDiscordEmbed,
  serializeEvent,
  signBody
} from "../notification_payload";

// Minimal translator: returns the key plus params so tests do not depend on language files.
const t = (key: string, params?: Record<string, any>) =>
  params ? `${key}|${params.name}` : key;

describe("signBody", () => {
  it("matches the shared known-answer vector (also used by the receiver doc)", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const body = Buffer.from(
      '{"version":1,"id":"11111111-2222-4333-8444-555555555555","type":"notification.test","timestamp":"2025-11-18T12:00:00.000Z","panel":{"name":"Minefield Panel"},"details":{"message":"Test notification"}}',
      "utf8"
    );
    expect(signBody(secret, "1763467200", body)).toBe(
      "sha256=33b4c5de310a6a85c53094e897d2dad6853fa702f501cf8b50ad674bf2201e2d"
    );
    expect(signBody(secret, 1763467200, body)).toBe(
      "sha256=33b4c5de310a6a85c53094e897d2dad6853fa702f501cf8b50ad674bf2201e2d"
    );
  });
  it("changes with timestamp, body and secret", () => {
    const b = Buffer.from("{}");
    const base = signBody("s", "1", b);
    expect(signBody("s", "2", b)).not.toBe(base);
    expect(signBody("s2", "1", b)).not.toBe(base);
    expect(signBody("s", "1", Buffer.from("{} "))).not.toBe(base);
    expect(base).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("buildEvent", () => {
  it("builds the version 1 shape for an instance crash", () => {
    const e = buildEvent(
      {
        type: "instance.crashed",
        instance: { daemonId: "d1", uuid: "u1", name: "Survival", daemonName: "node-1" },
        details: { exitCode: 3, willAutoRestart: true }
      },
      { panelName: "Minefield Panel", id: "id-1", now: Date.UTC(2026, 10, 18, 12) }
    );
    expect(e).toEqual({
      version: 1,
      id: "id-1",
      type: "instance.crashed",
      timestamp: "2026-11-18T12:00:00.000Z",
      panel: { name: "Minefield Panel" },
      instance: { daemonId: "d1", uuid: "u1", name: "Survival", daemonName: "node-1" },
      details: { exitCode: 3, willAutoRestart: true }
    });
  });
  it("generates a unique id per event", () => {
    const a = buildEvent({ type: "notification.test" }, { panelName: "P" });
    const b = buildEvent({ type: "notification.test" }, { panelName: "P" });
    expect(a.id).not.toBe(b.id);
  });
  it("includes group and backup blocks", () => {
    const e = buildEvent(
      {
        type: "backup.succeeded",
        instance: { daemonId: "d", uuid: "u", name: "n" },
        backup: { id: "b1", trigger: "schedule", sizeBytes: 12.6, durationSec: 3 }
      },
      { panelName: "P" }
    );
    expect(e.backup).toEqual({ id: "b1", trigger: "schedule", sizeBytes: 13, durationSec: 3 });
    const g = buildEvent(
      { type: "group.run_started", group: { uuid: "g", name: "N", action: "start", runId: "r" } },
      { panelName: "P" }
    );
    expect(g.group).toEqual({ uuid: "g", name: "N", action: "start", runId: "r" });
    expect(g.instance).toBeUndefined();
  });
  it("truncates names and strips control characters", () => {
    const e = buildEvent(
      { type: "instance.started", instance: { daemonId: "d", uuid: "u", name: "a\nb" + "x".repeat(300) } },
      { panelName: "P" }
    );
    expect(Array.from(e.instance!.name).length).toBe(100);
    expect(e.instance!.name).not.toContain("\n");
  });
  it("drops unsupported detail values and redacts file paths", () => {
    const e = buildEvent(
      {
        type: "backup.failed",
        details: {
          reason: "cannot write /var/lib/mcsm/data/x.zip and C:\\Users\\a\\b.zip",
          nested: { a: 1 },
          fn: (() => 1) as any,
          "bad key!": 1,
          n: Infinity
        }
      },
      { panelName: "P" }
    );
    expect(e.details.reason).toBe("cannot write [path] and [path]");
    expect(Object.keys(e.details)).toEqual(["reason"]);
  });
  it("keeps the serialized body within 8 KB", () => {
    const big = "é😀".repeat(400);
    const e = buildEvent(
      {
        type: "group.run_failed",
        instance: { daemonId: big, uuid: big, name: big, daemonName: big },
        group: { uuid: big, name: big, action: "start", runId: big },
        backup: { id: big, name: big, trigger: "manual" },
        details: Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [`k${i}`, big])
        )
      },
      { panelName: big }
    );
    expect(serializeEvent(e).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
  it("never contains a secret field", () => {
    const e = buildEvent({ type: "instance.started", details: { suppressedBefore: 4 } }, { panelName: "P" });
    expect(JSON.stringify(e)).not.toMatch(/secret|token|password/i);
    expect(e.details.suppressedBefore).toBe(4);
  });
});

describe("renderDiscordEmbed", () => {
  const crash = buildEvent(
    {
      type: "instance.crashed",
      instance: { daemonId: "d", uuid: "u", name: "@everyone *bold* <@123>", daemonName: "node" },
      details: { exitCode: 1, willAutoRestart: false, suppressedBefore: 2 }
    },
    { panelName: "Minefield Panel", now: 0 }
  );
  it("renders a red embed with escaped names and fields", () => {
    const embed = renderDiscordEmbed(crash, t);
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.title).toBe("TXT_CODE_notification.title_instance_crashed");
    expect(embed.description).not.toContain("@everyone");
    expect(embed.description).toContain("@\u200beveryone");
    expect(embed.description).toContain("\\*bold\\*");
    expect(embed.description).toContain("\\<@\u200b123\\>");
    expect(embed.timestamp).toBe("1970-01-01T00:00:00.000Z");
    expect(embed.fields.length).toBeLessThanOrEqual(10);
    expect(embed.fields.every((f) => f.value.length <= 1024)).toBe(true);
  });
  it("disables all mention parsing in the payload", () => {
    const p = buildDiscordPayload(crash, t);
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.username).toBe("Minefield Panel");
    expect(p.embeds).toHaveLength(1);
  });
  it("uses documented colors", () => {
    const mk = (type: any, details: any = {}) =>
      renderDiscordEmbed(buildEvent({ type, details }, { panelName: "P" }), t).color;
    expect(mk("instance.started")).toBe(0x2ecc71);
    expect(mk("instance.stopped")).toBe(0x95a5a6);
    expect(mk("instance.auto_restarted")).toBe(0xe67e22);
    expect(mk("notification.test")).toBe(0x3498db);
    expect(mk("group.run_started")).toBe(0x3498db);
    expect(mk("group.run_failed")).toBe(0xe74c3c);
    expect(mk("backup.failed")).toBe(0xe74c3c);
    expect(mk("group.run_finished", { result: "cancelled" })).toBe(0x95a5a6);
  });
  it("truncates oversized text to Discord limits", () => {
    const e = buildEvent(
      { type: "backup.failed", details: { reason: "r".repeat(200) } },
      { panelName: "P" }
    );
    const embed = renderDiscordEmbed(e, (k) => "x".repeat(5000));
    expect(Array.from(embed.title).length).toBeLessThanOrEqual(256);
    expect(Array.from(embed.description).length).toBeLessThanOrEqual(4096);
  });
  it("escapes markdown helper", () => {
    expect(escapeDiscord("a_b`c")).toBe("a\\_b\\`c");
  });
});

describe("renderDiscordEmbed with real translations", () => {
  it("resolves every title, description and field key to text", async () => {
    const { $t } = await import("../../i18n");
    const types = [
      "instance.crashed", "instance.started", "instance.stopped", "instance.auto_restarted",
      "backup.succeeded", "backup.failed", "group.run_started", "group.run_finished",
      "group.run_failed", "notification.test"
    ] as const;
    for (const type of types) {
      const e = buildEvent(
        {
          type,
          instance: { daemonId: "d", uuid: "u", name: "Srv", daemonName: "n" },
          group: { uuid: "g", name: "G", action: "start", runId: "r" },
          backup: { id: "b", trigger: "manual", sizeBytes: 5000, durationSec: 70 },
          details: { exitCode: 1, willAutoRestart: true, attempt: 1, maxAttempts: null, memberCount: 2, result: "succeeded", reason: "r", message: "m", suppressedBefore: 1, durationSec: 5, failedStep: { reason: "x" } }
        },
        { panelName: "P" }
      );
      const embed = renderDiscordEmbed(e, $t);
      expect(embed.title).not.toContain("TXT_CODE_");
      expect(embed.description).not.toContain("TXT_CODE_");
      expect(embed.description).not.toContain("{{");
      for (const f of embed.fields) expect(f.name).not.toContain("TXT_CODE_");
    }
  });
});
