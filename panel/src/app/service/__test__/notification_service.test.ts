import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => {
  const n = () => {};
  return { logger: { info: n, warn: n, error: n, debug: n } };
});

import { EVENT_TYPES, NotificationConfig } from "../../entity/notification_config";
import { NotificationService, onDaemonLifecycle, QUEUE_CAPACITY } from "../notification_service";
import type { NotificationEvent } from "../notification_payload";
import type { SendResult } from "../notification_sender";

let config: NotificationConfig;
let sent: { event: NotificationEvent; at: number }[];
let outcomes: SendResult[]; // consumed in order; default ok
let service: NotificationService;
let sender: ReturnType<typeof vi.fn>;

const OK: SendResult = { ok: true, status: 204, retryable: false };
const crash = (uuid = "u1", extra: any = {}) => ({
  type: "instance.crashed" as const,
  instance: { daemonId: "d1", uuid, name: "Survival" },
  details: { exitCode: 1, willAutoRestart: false },
  ...extra
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
  config = new NotificationConfig();
  config.enabled = true;
  config.url = "https://bot.example.com/x";
  config.secret = "s";
  for (const t of EVENT_TYPES) config.events[t] = true;
  sent = [];
  outcomes = [];
  sender = vi.fn(async (event: NotificationEvent) => {
    sent.push({ event, at: Date.now() });
    return outcomes.shift() ?? OK;
  });
  service = new NotificationService(() => config, sender as any);
});
afterEach(() => {
  service.reset();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("filtering", () => {
  it("sends enabled events", async () => {
    service.emit(crash());
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].event.type).toBe("instance.crashed");
    expect(service.getStatus()).toMatchObject({ sent: 1, failed: 0, queued: 0 });
  });
  it("sends nothing when disabled, unconfigured or toggled off", async () => {
    config.enabled = false;
    service.emit(crash());
    config.enabled = true;
    config.url = "";
    service.emit(crash());
    config.url = "https://bot.example.com/x";
    config.events["instance.crashed"] = false;
    service.emit(crash());
    await flush();
    expect(sent).toHaveLength(0);
    expect(service.getStatus().queued).toBe(0);
  });
  it("honours exclusions for instance and backup events but not groups", async () => {
    config.excludedInstances = ["d1::u1"];
    service.emit(crash("u1"));
    service.emit({
      type: "backup.succeeded",
      instance: { daemonId: "d1", uuid: "u1", name: "n" },
      backup: { id: "b", trigger: "manual" }
    });
    service.emit({
      type: "group.run_started",
      group: { uuid: "g", name: "G", action: "start", runId: "r" },
      details: { memberCount: 2 }
    });
    service.emit(crash("u2"));
    await flush();
    expect(sent.map((s) => s.event.type)).toEqual(["group.run_started", "instance.crashed"]);
  });
  it("ignores unknown types and never throws", () => {
    expect(() => service.emit({ type: "nope" } as any)).not.toThrow();
    expect(() => service.emit(null as any)).not.toThrow();
    const broken = new NotificationService(() => {
      throw new Error("boom");
    });
    expect(() => broken.emit(crash())).not.toThrow();
  });
  it("emit returns synchronously (void)", () => {
    expect(service.emit(crash())).toBeUndefined();
  });
});

describe("retries", () => {
  it("retries a 5xx at 5s, 30s and 120s then fails", async () => {
    const fail: SendResult = { ok: false, status: 500, error: "http_5xx", retryable: true };
    outcomes = [fail, fail, fail, fail];
    const t0 = Date.now();
    service.emit(crash());
    await flush();
    expect(sent).toHaveLength(1);
    expect(service.getStatus().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4);
    expect(sent.map((s) => s.at - t0)).toEqual([0, 5_000, 35_000, 155_000]);
    // all attempts carry the same event id
    expect(new Set(sent.map((s) => s.event.id)).size).toBe(1);
    expect(service.getStatus()).toMatchObject({ sent: 0, failed: 1, queued: 0 });
    expect(service.getStatus().last).toMatchObject({ ok: false, error: "http_5xx" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sent).toHaveLength(4);
  });
  it("does not retry permanent failures", async () => {
    outcomes = [{ ok: false, status: 400, error: "http_4xx", retryable: false }];
    service.emit(crash());
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sent).toHaveLength(1);
    expect(service.getStatus()).toMatchObject({ failed: 1, queued: 0 });
  });
  it("uses Retry-After capped at 120 seconds", async () => {
    outcomes = [
      { ok: false, status: 429, error: "http_4xx", retryable: true, retryAfterSec: 9999 }
    ];
    service.emit(crash());
    await flush();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });
  it("a pending retry does not block a ready event", async () => {
    outcomes = [{ ok: false, status: 503, error: "http_5xx", retryable: true }];
    service.emit(crash("u1"));
    await flush();
    service.emit(crash("u2"));
    await flush();
    expect(sent.map((s) => s.event.instance!.uuid)).toEqual(["u1", "u2"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.map((s) => s.event.instance!.uuid)).toEqual(["u1", "u2", "u1"]);
  });
  it("handles a throwing sender as a retryable failure", async () => {
    sender.mockImplementationOnce(async () => {
      throw new Error("x");
    });
    service.emit(crash());
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1); // second call succeeded
    expect(service.getStatus().sent).toBe(1);
  });
  it("drops queued items when notifications get disabled", async () => {
    outcomes = [{ ok: false, status: 503, error: "http_5xx", retryable: true }];
    service.emit(crash());
    await flush();
    config.enabled = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    expect(service.getStatus()).toMatchObject({ queued: 0, dropped: 1 });
  });
});

describe("queue bound", () => {
  it("drops the oldest when over 200 items are waiting", async () => {
    // one in flight that never finishes blocks the worker
    let release!: () => void;
    sender.mockImplementationOnce(
      () => new Promise<SendResult>((r) => (release = () => r(OK)))
    );
    config.events["instance.started"] = true;
    service.emit({ type: "instance.started", instance: { daemonId: "x", uuid: "first", name: "n" } });
    await flush();
    // unique instances so coalescing does not interfere
    for (let i = 0; i < QUEUE_CAPACITY + 25; i++)
      service.emit({ type: "instance.started", instance: { daemonId: "x", uuid: `i${i}`, name: "n" } });
    const st = service.getStatus();
    expect(st.queued).toBe(QUEUE_CAPACITY + 1);
    expect(st.dropped).toBe(25);
    release();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 300; i++) await flush();
    // the 25 oldest of the burst were dropped
    const uuids = sent.map((s) => s.event.instance!.uuid);
    expect(uuids).not.toContain("i0");
    expect(uuids).not.toContain("i24");
    expect(uuids).toContain("i25");
    expect(uuids).toContain(`i${QUEUE_CAPACITY + 24}`);
  });
});

describe("coalescing", () => {
  it("a flood of 20 crashes yields 6 sends, then suppressedBefore on the next accepted event", async () => {
    for (let i = 0; i < 20; i++) service.emit(crash("flood"));
    await flush();
    for (let i = 0; i < 20; i++) await flush();
    expect(sent).toHaveLength(6);
    expect(sent.some((s) => s.event.details.suppressedBefore !== undefined)).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    service.emit(crash("flood"));
    await flush();
    expect(sent).toHaveLength(7);
    expect(sent[6].event.details.suppressedBefore).toBe(14);
    // counter reset
    service.emit(crash("flood"));
    await flush();
    expect(sent[7].event.details.suppressedBefore).toBeUndefined();
  });
  it("is per instance and exempts group events", async () => {
    for (let i = 0; i < 10; i++) service.emit(crash("a"));
    for (let i = 0; i < 10; i++) service.emit(crash("b"));
    for (let i = 0; i < 10; i++)
      service.emit({
        type: "group.run_started",
        group: { uuid: "g", name: "G", action: "start", runId: `r${i}` }
      });
    for (let i = 0; i < 40; i++) await flush();
    expect(sent.filter((s) => s.event.instance?.uuid === "a")).toHaveLength(6);
    expect(sent.filter((s) => s.event.instance?.uuid === "b")).toHaveLength(6);
    expect(sent.filter((s) => s.event.type === "group.run_started")).toHaveLength(10);
  });
});

describe("test notification", () => {
  it("reports not_configured when disabled", async () => {
    config.enabled = false;
    expect(await service.sendTest()).toEqual({ ok: false, error: "not_configured" });
    expect(sender).not.toHaveBeenCalled();
  });
  it("sends one attempt without retry, ignoring toggles, and rate limits", async () => {
    for (const t of EVENT_TYPES) config.events[t] = false;
    outcomes = [{ ok: false, status: 500, error: "http_5xx", retryable: true }];
    const r = await service.sendTest();
    expect(r).toEqual({ ok: false, status: 500, error: "http_5xx" });
    expect(sent[0].event.type).toBe("notification.test");
    expect(service.getStatus().queued).toBe(0);
    expect(await service.sendTest()).toEqual({ ok: false, error: "rate_limited" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await service.sendTest()).toEqual({ ok: true, status: 204 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sent).toHaveLength(2);
  });
});

describe("onDaemonLifecycle", () => {
  const emits: any[] = [];
  const target = { emit: (i: any) => void emits.push(i) };
  beforeEach(() => (emits.length = 0));
  const base = { instanceUuid: "u1", instanceName: "Survival", at: 1 };

  it("maps each kind", () => {
    expect(onDaemonLifecycle("d1", "node", { ...base, kind: "started", exitCode: null }, target)).toBe(true);
    onDaemonLifecycle("d1", "node", { ...base, kind: "stopped", exitCode: 0 }, target);
    onDaemonLifecycle("d1", "node", { ...base, kind: "crashed", exitCode: 3, willAutoRestart: true }, target);
    onDaemonLifecycle("d1", "node", { ...base, kind: "auto_restarted", exitCode: null, attempt: 2, maxAttempts: null }, target);
    expect(emits.map((e) => e.type)).toEqual([
      "instance.started",
      "instance.stopped",
      "instance.crashed",
      "instance.auto_restarted"
    ]);
    expect(emits[0].instance).toEqual({ daemonId: "d1", uuid: "u1", name: "Survival", daemonName: "node" });
    expect(emits[1].details).toEqual({ exitCode: 0 });
    expect(emits[2].details).toEqual({ exitCode: 3, willAutoRestart: true });
    expect(emits[3].details).toEqual({ attempt: 2, maxAttempts: null });
  });
  it("ignores malformed packets", () => {
    const bad: any[] = [
      null,
      "x",
      {},
      { ...base, kind: "weird" },
      { ...base, kind: "__proto__" },
      { ...base, kind: "crashed", exitCode: "3" },
      { ...base, kind: "crashed", exitCode: 1.5 },
      { ...base, kind: "crashed", exitCode: 1, willAutoRestart: "yes" },
      { ...base, instanceUuid: "", kind: "started" },
      { ...base, instanceUuid: "u".repeat(65), kind: "started" },
      { ...base, instanceName: "n".repeat(257), kind: "started" },
      { ...base, instanceName: 5, kind: "started" },
      { ...base, kind: "auto_restarted", attempt: "1" },
      { ...base, kind: "auto_restarted", attempt: 1, maxAttempts: "3" }
    ];
    for (const b of bad) expect(onDaemonLifecycle("d1", "n", b, target)).toBe(false);
    expect(emits).toHaveLength(0);
  });
  it("end to end: a daemon crash packet reaches the sender", async () => {
    onDaemonLifecycle("d1", "node", { ...base, kind: "crashed", exitCode: 3, willAutoRestart: false }, service);
    await flush();
    expect(sent[0].event).toMatchObject({
      type: "instance.crashed",
      instance: { daemonId: "d1", uuid: "u1", name: "Survival", daemonName: "node" },
      details: { exitCode: 3, willAutoRestart: false }
    });
  });
});
