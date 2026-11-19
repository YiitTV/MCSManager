import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import type { GroupRun, InstanceGroupView } from "@/types/instanceGroup";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  wrap: (fn: (...args: any[]) => any) => () => ({
    execute: async (cfg?: any) => ({ value: await fn(cfg) })
  })
}));

vi.mock("@/services/apis/instanceGroup", () => ({
  listInstanceGroups: mocks.wrap(mocks.list),
  getInstanceGroupRun: mocks.wrap(mocks.run),
  startInstanceGroup: mocks.wrap(mocks.start),
  stopInstanceGroup: mocks.wrap(mocks.stop),
  cancelInstanceGroupRun: mocks.wrap(mocks.cancel),
  createInstanceGroup: mocks.wrap(mocks.create),
  updateInstanceGroup: mocks.wrap(mocks.update),
  deleteInstanceGroup: mocks.wrap(mocks.remove)
}));

import { useInstanceGroups } from "../useInstanceGroups";

const group = (uuid: string, run: GroupRun | null = null): InstanceGroupView => ({
  uuid,
  run,
  name: uuid,
  members: [],
  stopOrder: [],
  advance: {
    mode: "pattern",
    pattern: "Done (*)!",
    delaySec: 15,
    startTimeoutSec: 180,
    stopTimeoutSec: 180
  },
  createdAt: 0,
  updatedAt: 0
});

const run = (state: GroupRun["state"], steps = ["waiting"]): GroupRun => ({
  runId: "r1",
  groupId: "g1",
  action: "start",
  state,
  steps: steps.map((s, i) => ({ key: `d::i${i}`, state: s as any })),
  startedAt: 0
});

function setup(onRunFinished?: any) {
  const scope = effectScope();
  const hook = scope.run(() => useInstanceGroups({ onRunFinished }))!;
  return { scope, hook };
}

describe("useInstanceGroups polling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(mocks).forEach((m) => (m as any).mockReset?.());
    mocks.list.mockResolvedValue([group("g1")]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll when no run is active", async () => {
    mocks.run.mockResolvedValue({ run: null });
    const { hook, scope } = setup();
    await hook.load();
    mocks.run.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it("restores an active run from the list without per-group run requests", async () => {
    mocks.list.mockResolvedValue([group("g1", run("running")), group("g2"), group("g3")]);
    const { hook, scope } = setup();
    await hook.load();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(hook.isActive("g1")).toBe(true);
    expect(hook.isActive("g2")).toBe(false);
    scope.stop();
  });

  it("polls every 2 seconds until the run is terminal", async () => {
    mocks.list.mockResolvedValue([group("g1", run("running"))]);
    mocks.run.mockResolvedValue({ run: run("running") });
    const finished = vi.fn();
    const { hook, scope } = setup(finished);
    await hook.load();
    expect(hook.isActive("g1")).toBe(true);
    mocks.run.mockClear();

    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.run).toHaveBeenCalledTimes(2);

    mocks.run.mockResolvedValue({ run: run("succeeded", ["done"]) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(hook.isActive("g1")).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][1].state).toBe("succeeded");

    const calls = mocks.run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.run.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it("starts polling after startGroup and refuses nothing when the server returns 409", async () => {
    mocks.run.mockResolvedValue({ run: null });
    const { hook, scope } = setup();
    await hook.load();

    mocks.start.mockResolvedValue({ runId: "r1" });
    mocks.run.mockResolvedValue({ run: run("running") });
    await hook.startGroup("g1");
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ params: { id: "g1" } }));
    expect(hook.isActive("g1")).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    mocks.start.mockRejectedValue(new Error("conflict"));
    await expect(hook.startGroup("g1")).rejects.toThrow("conflict");
    scope.stop();
  });

  it("clears the interval when the scope is disposed", async () => {
    mocks.list.mockResolvedValue([group("g1", run("running"))]);
    mocks.run.mockResolvedValue({ run: run("running") });
    const { hook, scope } = setup();
    await hook.load();
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    mocks.run.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("gives up on a run whose polling keeps failing", async () => {
    mocks.list.mockResolvedValue([group("g1", run("running"))]);
    mocks.run.mockResolvedValue({ run: run("running") });
    const { hook, scope } = setup();
    await hook.load();
    mocks.run.mockRejectedValue(new Error("not found"));
    await vi.advanceTimersByTimeAsync(2000 * 3);
    expect(hook.isActive("g1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });

  it("cancel applies the run state returned by the API", async () => {
    mocks.list.mockResolvedValue([group("g1", run("running"))]);
    const { hook, scope } = setup();
    await hook.load();
    mocks.cancel.mockResolvedValue({ run: run("cancelled", ["done", "pending"]) });
    await hook.cancelGroup("g1");
    expect(hook.getRun("g1")?.state).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
  });
});
