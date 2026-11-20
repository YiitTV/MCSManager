// @vitest-environment jsdom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitoringSeries, useInstanceMonitoring } from "../useInstanceMonitoring";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@/services/apiService", () => ({ apiService: { subscribe: mocks.subscribe } }));

const response = {
  current: null,
  history: [],
  memoryLimitBytes: null,
  warnings: { memory: false, tps: false }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
  mocks.subscribe.mockReset().mockResolvedValue(response);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("instance monitoring polling", () => {
  it("fetches compact and complete history, spaces requests, and stops on scope disposal", async () => {
    const scope = effectScope();
    const first = scope.run(() =>
      useInstanceMonitoring(() => ({ instanceId: "one", daemonId: "node", compact: true }))
    )!;
    scope.run(() => useInstanceMonitoring(() => ({ instanceId: "two", daemonId: "node" })));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.data.value).toEqual(response);
      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(mocks.subscribe.mock.calls[0][0].params).toEqual({
        uuid: "one",
        daemonId: "node",
        view: "compact"
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.subscribe.mock.calls[1][0].params).toEqual({ uuid: "two", daemonId: "node" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.subscribe).toHaveBeenCalledTimes(4);
    } finally {
      scope.stop();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("monitoring charts", () => {
  it("leaves gaps for missing readings and downtime", () => {
    const sample = { cpuPercent: 40, ramBytes: 300, tps: null, mspt: null };
    const points = monitoringSeries(
      [
        { ...sample, timestamp: 0, tps: 14 },
        { ...sample, timestamp: 60_000 },
        { ...sample, timestamp: 240_000, tps: 20 }
      ],
      "tps"
    );
    expect(points).toEqual([
      [0, 14],
      [60_000, null],
      [120_000, null],
      [240_000, 20]
    ]);
  });
});
