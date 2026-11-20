// @vitest-environment jsdom
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

vi.mock("@/services/apis/minecraftOperations", () => ({
  getMaintenanceState: () => ({ execute: read }),
  submitMaintenanceAction: () => ({ execute: write })
}));

import { useMinecraftMaintenance } from "../useMinecraftMaintenance";

const read = vi.fn();
const write = vi.fn();
const target = { daemonId: "daemon", instanceUuid: "proxy" };
const disabled = { status: "ready", running: true, enabled: false, players: [] };

afterEach(() => {
  vi.resetAllMocks();
});

describe("Velocity maintenance card", () => {
  it("loads plugin presence when mounted and cancels its request on dispose", async () => {
    read.mockResolvedValue({ value: { status: "missing", running: false } });
    const scope = effectScope();
    const control = scope.run(() =>
      useMinecraftMaintenance(
        () => target,
        () => false
      )
    )!;
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    expect(control.state.value?.status).toBe("missing");
    await control.submit({ action: "toggle", enabled: true });
    expect(write).not.toHaveBeenCalled();
    scope.stop();
    expect(read.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("shows the plugin state returned after an edit", async () => {
    read.mockResolvedValue({ value: disabled });
    write.mockResolvedValueOnce({ value: { ...disabled, confirmed: false } });
    write.mockResolvedValueOnce({
      value: { ...disabled, enabled: true, confirmed: true }
    });
    const scope = effectScope();
    const control = scope.run(() =>
      useMinecraftMaintenance(
        () => target,
        () => true
      )
    )!;
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    await control.submit({ action: "toggle", enabled: true });
    expect(control.error.value).toBe("unconfirmed");
    expect(control.state.value).toMatchObject({ enabled: false });
    await control.submit({ action: "toggle", enabled: true });
    expect(control.error.value).toBeUndefined();
    expect(control.state.value).toMatchObject({ enabled: true });
    scope.stop();
  });
});
