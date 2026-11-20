// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

vi.mock("@/services/apis/minecraftOperations", () => ({
  getPlayerRoster: () => ({ execute: read }),
  submitPlayerAction: () => ({ execute: send })
}));

import { useMinecraftPlayers } from "../useMinecraftPlayers";

const read = vi.fn();
const send = vi.fn();
const target = { daemonId: "daemon", instanceUuid: "paper" };
const roster = { players: ["Notch"], online: 1, max: 20, canManage: true };

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("Minecraft player panel", () => {
  it("polls only while open and cancels the old view", async () => {
    vi.useFakeTimers();
    read.mockResolvedValue({ value: roster });
    const scope = effectScope();
    const activeTarget = ref(target);
    const panel = scope.run(() =>
      useMinecraftPlayers(
        () => activeTarget.value,
        () => true
      )
    )!;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).not.toHaveBeenCalled();
    panel.open.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(panel.roster.value).toEqual(roster);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);

    const previous = read.mock.calls[1][0].signal;
    activeTarget.value = { ...target, instanceUuid: "lobby" };
    await nextTick();
    expect(previous.aborted).toBe(true);
    expect(read.mock.calls[2][0].params.uuid).toBe("lobby");

    panel.open.value = false;
    await nextTick();
    expect(read.mock.calls[2][0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  it("submits an action for an offline name without refreshing the roster", async () => {
    read.mockResolvedValue({ value: roster });
    send.mockResolvedValue({ value: { accepted: true } });
    const scope = effectScope();
    const panel = scope.run(() =>
      useMinecraftPlayers(
        () => target,
        () => true
      )
    )!;
    panel.open.value = true;
    await nextTick();
    await nextTick();
    panel.action.value = "pardon";
    panel.player.value = "FormerUser";
    await nextTick();
    await panel.submit();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { daemonId: "daemon", uuid: "paper" },
        data: { action: "pardon", player: "FormerUser", text: undefined }
      })
    );
    expect(panel.result.value).toBe("submitted");
    expect(read).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
