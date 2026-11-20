import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IInstanceProcess } from "../../../entity/instance/interface";
import type Instance from "../../../entity/instance/instance";
import { instanceMonitoring } from "../../instance_monitoring";
import { readResources } from "../resources";

vi.mock("../../../entity/instance/instance", () => ({ default: { STATUS_RUNNING: 3 } }));
vi.mock("../../log", () => ({ default: { debug: vi.fn() } }));
vi.mock("../resources", () => ({ readResources: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => Date.now() } }));

const MINUTE = 60_000;
let status: number;
let instance: Instance;
let processHandle: IInstanceProcess | undefined;
let rss: number;
let tps: number;
let reply: boolean;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  status = 3;
  processHandle = new EventEmitter() as IInstanceProcess;
  rss = 90;
  tps = 14;
  reply = true;
  const emitter = new EventEmitter();
  send = vi.fn(async () => {
    if (reply) {
      emitter.emit(
        "data",
        "[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:\n" +
          `[⚡] 12, 13, ${tps}, 17, 20\n` +
          "[⚡] CPU usage from last 10s, 1m, 15m:\n"
      );
    }
  });
  instance = Object.assign(emitter, {
    instanceUuid: "sample",
    status: () => status,
    execPreset: send
  }) as unknown as Instance;
  Object.defineProperty(instance, "process", { get: () => processHandle });
  vi.mocked(readResources).mockImplementation(async () => ({
    ramBytes: rss,
    cpuPercent: 50,
    memoryLimitBytes: 100,
    spark: true
  }));
});

afterEach(() => {
  instanceMonitoring.stop();
  instanceMonitoring.remove(instance);
  vi.useRealTimers();
});

describe("instance sampling lifecycle", () => {
  it("samples once a minute, applies RAM and TPS thresholds, and clears warnings on restart", async () => {
    instanceMonitoring.start(() => [instance]);
    await vi.advanceTimersByTimeAsync(0);
    expect(instanceMonitoring.read(instance, false).warnings).toEqual({
      memory: false,
      tps: false
    });

    rss = 91;
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(instanceMonitoring.read(instance, false).warnings).toEqual({ memory: true, tps: false });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(instanceMonitoring.read(instance, false).warnings).toEqual({ memory: true, tps: true });
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.every(([action, command]) => action === "command" && command === "spark tps")
    ).toBe(true);

    status = 0;
    processHandle = undefined;
    instance.emit("exit");
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(send).toHaveBeenCalledTimes(3);
    expect(instanceMonitoring.read(instance, false)).toMatchObject({
      current: null,
      warnings: { memory: false, tps: false }
    });

    status = 3;
    processHandle = new EventEmitter() as IInstanceProcess;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(instanceMonitoring.read(instance, false).warnings.tps).toBe(false);
    expect(instanceMonitoring.read(instance, false).history).toHaveLength(4);
    instanceMonitoring.remove(instance);
    expect(instanceMonitoring.read(instance, false).history).toEqual([]);
  });

  it("dismisses warnings when a probe has no reply and cancels an in-flight probe on exit", async () => {
    instanceMonitoring.start(() => [instance]);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(instanceMonitoring.read(instance, false).warnings.tps).toBe(true);
    reply = false;
    await vi.advanceTimersByTimeAsync(MINUTE + 5000);
    expect(instanceMonitoring.read(instance, false)).toMatchObject({
      current: { cpuPercent: 50, tps: null },
      warnings: { tps: false }
    });

    await vi.advanceTimersByTimeAsync(MINUTE - 5000);
    expect(instance.listenerCount("data")).toBe(1);
    status = 0;
    instance.emit("exit");
    expect(instance.listenerCount("data")).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(instanceMonitoring.read(instance, false).history).toHaveLength(4);
  });
});
