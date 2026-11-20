import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeSpark, SparkReply } from "../spark";

const header = "[18:00:00 INFO]: [⚡] TPS from last 5s, 10s, 1m, 5m, 15m:\r\n";
const values = "[18:00:00 INFO]: [⚡] 12.4, 13.0, 14.1, 17.0, *20.0\r\n";
const duration =
  "[18:00:00 INFO]: [⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\r\n";
const durationValues = "[18:00:00 INFO]: [⚡] 21.1/61.7/70.5/90.0;  12.1/41.2/56.6/89.0\r\n";

describe("spark reply parsing", () => {
  it("handles chunk boundaries, formatting codes, and other console traffic", () => {
    const parser = new SparkReply();
    const chunks = [
      header.slice(0, 27),
      header.slice(27) + "[18:00:00 INFO]: <player> random chat\n",
      values.replace("14.1", "\x1b[31m§c14.1\x1b[0m") + duration,
      durationValues
    ];
    for (const chunk of chunks.slice(0, -1)) expect(parser.push(chunk)).toBeUndefined();
    expect(parser.push(chunks.at(-1)!)).toEqual({ tps: 14.1, mspt: 41.2 });
  });

  it("ignores numeric output or chat pretending to be a spark reply", () => {
    const parser = new SparkReply();
    parser.push(header.replace("[⚡]", "<player> [⚡]") + values + duration + durationValues);
    expect(parser.result).toEqual({ tps: null, mspt: null });
  });

  it("accepts a TPS-only response when tick durations are unavailable", () => {
    const parser = new SparkReply();
    expect(parser.push(header + values + "[⚡] CPU usage from last 10s, 1m, 15m:\n")).toEqual({
      tps: 14.1,
      mspt: null
    });
  });
});

describe("spark probe lifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("times out after five seconds, detaches its listener, and ignores late output", async () => {
    const console = new EventEmitter();
    const send = vi.fn(async () => undefined);
    const promise = probeSpark(console, send, new AbortController().signal);
    expect(send).toHaveBeenCalledOnce();
    expect(console.listenerCount("data")).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    console.emit("data", header + values + duration + durationValues);
    expect(await promise).toEqual({ tps: null, mspt: null });
    expect(console.listenerCount("data")).toBe(0);
  });

  it("cleans up immediately on abort or failed send", async () => {
    const console = new EventEmitter();
    const controller = new AbortController();
    const first = probeSpark(console, async () => undefined, controller.signal);
    controller.abort();
    expect(await first).toEqual({ tps: null, mspt: null });
    const second = probeSpark(
      console,
      async () => {
        throw new Error("closed");
      },
      new AbortController().signal
    );
    expect(await second).toEqual({ tps: null, mspt: null });
    expect(console.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
