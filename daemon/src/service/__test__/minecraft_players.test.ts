import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Instance from "../../entity/instance/instance";
import { createRosterParser, getPlayerRoster } from "../minecraft_players";

function fakeInstance() {
  const instance = Object.assign(new EventEmitter(), {
    process: {},
    config: { type: "minecraft/java/paper" },
    execPreset: vi.fn(async () => {})
  });
  return { instance, daemonInstance: instance as unknown as Instance };
}

afterEach(() => vi.useRealTimers());

describe("Minecraft roster replies", () => {
  it("parses Paper's formatted console reply and an empty roster", () => {
    const parse = createRosterParser(false);
    expect(
      parse(
        "\x1b[32m[17:34:13] [Server thread/INFO]: There are 2 of a max of 100 players online: Notch, Alex_1\x1b[0m"
      )
    ).toEqual(["Notch", "Alex_1"]);
    expect(parse("[17:34:14 INFO]: There are 0 of a max of 100 players online: ")).toEqual([]);
    expect(
      parse("[17:34:14 INFO]: <Steve> There are 1 of a max of 100 players online: Alex_1")
    ).toBeUndefined();
    expect(parse("There are 1 of a max of 100 players online: @a")).toBeUndefined();
  });

  it("reads Velocity rows followed by the proxy total", () => {
    const parse = createRosterParser(true);
    expect(parse("[16:23:00 INFO]: [main] (2): Alex, Notch")).toBeUndefined();
    expect(parse("[16:23:00 INFO]: [lobi] (1): Player_3")).toBeUndefined();
    expect(parse("[16:23:00 INFO]: 3 players are currently connected to the proxy.")).toEqual([
      "Alex",
      "Notch",
      "Player_3"
    ]);
    expect(createRosterParser(true)("0 players are currently connected to the proxy.")).toEqual([]);
  });

  it("shares split replies and limits invocations per live process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { instance, daemonInstance } = fakeInstance();
    const first = getPlayerRoster(daemonInstance);
    expect(getPlayerRoster(daemonInstance)).toBe(first);
    instance.emit("data", "There are 1 of a max of 10 players online: No");
    instance.emit("data", "tch\r\n");
    await expect(first).resolves.toEqual(["Notch"]);
    expect(instance.listenerCount("data")).toBe(0);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "minecraft:list");
    expect(getPlayerRoster(daemonInstance)).toBe(first);
    expect(instance.execPreset).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const second = getPlayerRoster(daemonInstance);
    expect(second).not.toBe(first);
    expect(instance.execPreset).toHaveBeenCalledTimes(2);
    instance.emit("exit");
    await expect(second).resolves.toBeNull();
    instance.process = {};
    const restarted = getPlayerRoster(daemonInstance);
    expect(restarted).not.toBe(second);
    expect(instance.execPreset).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(restarted).resolves.toBeNull();
    expect(instance.listenerCount("data")).toBe(0);
    expect(instance.listenerCount("exit")).toBe(0);
  });

  it("bounds output capture", async () => {
    const { instance, daemonInstance } = fakeInstance();
    const answer = getPlayerRoster(daemonInstance);
    instance.emit("data", "x".repeat(33_000));
    await expect(answer).resolves.toBeNull();
    expect(instance.listenerCount("data")).toBe(0);
  });
});
