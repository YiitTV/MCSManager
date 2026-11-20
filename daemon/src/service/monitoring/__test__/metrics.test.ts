import { describe, expect, it } from "vitest";
import { MONITORING_INTERVAL_MS as MINUTE, type InstanceMonitoringSample } from "mcsmanager-common";
import { MonitoringHistory, nextLowTpsCount, parseMaxHeap } from "../metrics";

const sample = (timestamp: number, tps: number | null = null): InstanceMonitoringSample => ({
  timestamp,
  ramBytes: 0,
  cpuPercent: 0,
  tps,
  mspt: null
});

describe("monitoring history", () => {
  it("retains the last 1,440 entries in chronological order and only an hour in compact view", () => {
    const history = new MonitoringHistory();
    for (let i = 0; i < 1444; i++) history.push(sample(i * MINUTE));
    const now = 1443 * MINUTE;
    const full = history.read(now, false);
    expect(full).toHaveLength(1440);
    expect(full[0].timestamp).toBe(4 * MINUTE);
    expect(full.at(-1)?.timestamp).toBe(now);
    expect(history.read(now, true)).toEqual(full.slice(-60));
    expect(history.read(now + 60 * MINUTE, true)).toEqual([]);
    expect(history.read(now + 1440 * MINUTE, false)).toEqual([]);
  });

  it("enforces the entry bound independently of wall-clock age", () => {
    const history = new MonitoringHistory();
    for (let i = 0; i < 1444; i++) history.push(sample(i));
    expect(history.read(1444, false)).toHaveLength(1440);
    expect(history.read(1444, false)[0].timestamp).toBe(4);
  });
});

describe("monitoring warning rules", () => {
  it("parses the last valid literal Xmx with binary units", () => {
    expect(parseMaxHeap('java -Xmx1024m "-Xmx3G" -jar server.jar')).toBe(3 * 1024 ** 3);
    expect(parseMaxHeap("java -Xmx131072")).toBe(131_072);
    expect(parseMaxHeap("java -Xmx2Gib -Xmx0 -Xmx${HEAP} -Dnote=-Xmx5G")).toBeUndefined();
    expect(parseMaxHeap("java -Xmx9007199254740999g")).toBeUndefined();
  });

  it("resets a low-TPS streak on missing, recovered, or non-consecutive readings", () => {
    const first = sample(0, 14);
    const second = sample(MINUTE, 14.9);
    const third = sample(2 * MINUTE, 12);
    const count = nextLowTpsCount(0, first, second);
    expect(count).toBe(1);
    expect(nextLowTpsCount(2, second, third)).toBe(3);
    expect(nextLowTpsCount(3, third, sample(3 * MINUTE, 15))).toBe(0);
    expect(nextLowTpsCount(3, third, sample(3 * MINUTE))).toBe(0);
    expect(nextLowTpsCount(3, third, sample(4 * MINUTE, 13))).toBe(1);
    expect(nextLowTpsCount(3, null, sample(4 * MINUTE, 13))).toBe(1);
  });
});
