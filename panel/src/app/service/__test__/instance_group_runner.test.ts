import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTANCE_STATUS,
  InstanceGroup,
  MAX_ACTIVE_RUNS,
  RUN_RETENTION_MS,
  defaultAdvance,
  memberKey
} from "../../entity/instance_group";
import {
  InstanceGroupRunner,
  InstanceGroupRunnerDeps,
  RunOperator,
  RunnerStream
} from "../instance_group_runner";

// The production wiring at the bottom of the runner module imports the real
// operation logger / remote subsystem; keep those inert for unit tests.
vi.mock("../operation_logger", () => ({ operationLogger: { log: vi.fn() } }));
const emitMock = vi.hoisted(() => vi.fn());
vi.mock("../notification_service", () => ({ emitNotification: emitMock }));
vi.mock("../remote_service", () => ({ default: { getInstance: vi.fn() } }));

const OWNER = "owner1";
const OPERATOR: RunOperator = { ip: "10.0.0.1", name: "alice" };
const { STOP, STOPPING, STARTING, RUNNING, BUSY } = INSTANCE_STATUS;

class FakeStream implements RunnerStream {
  status: number | null;
  closed = false;
  private listeners = new Map<string, Set<(p: any) => void>>();
  detailStatus: number;
  constructor(status: number) {
    this.status = status;
    this.detailStatus = status;
  }
  on(event: string, listener: (p: any) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  async requestStatus() {
    return this.detailStatus;
  }
  close() {
    this.closed = true;
  }
  emit(event: string, payload?: any) {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(payload);
  }
  listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

interface MemberSpec {
  status?: number;
  // Called when a command is sent for this member
  onCommand?: (event: string, stream: FakeStream) => void;
  commandError?: Error;
  openError?: Error;
}

function makeEnv(specs: Record<string, MemberSpec>) {
  const log: string[] = [];
  const streams: FakeStream[] = [];
  const opened: string[] = [];
  const allowed = new Set(Object.keys(specs));
  const operations: any[] = [];
  const byInstance = new Map<string, FakeStream>();

  const deps: InstanceGroupRunnerDeps = {
    authorize: (_owner, daemonId, instanceUuid) => allowed.has(instanceUuid) && daemonId === "d1",
    openStream: async (_daemonId, instanceUuid, signal) => {
      const spec = specs[instanceUuid];
      if (spec.openError) throw spec.openError;
      if (signal.aborted) throw new Error("Aborted");
      opened.push(instanceUuid);
      const stream = new FakeStream(spec.status ?? STOP);
      streams.push(stream);
      byInstance.set(instanceUuid, stream);
      return stream;
    },
    sendCommand: async (_daemonId, event, instanceUuid) => {
      log.push(`${event === "instance/open" ? "start" : "stop"}:${instanceUuid}`);
      const spec = specs[instanceUuid];
      if (spec.commandError) throw spec.commandError;
      spec.onCommand?.(event, byInstance.get(instanceUuid)!);
      return { nickname: `nick-${instanceUuid}` };
    },
    logOperation: (action, info) => operations.push({ action, ...info }),
    now: () => Date.now()
  };
  return { deps, log, streams, opened, allowed, operations, byInstance };
}

function makeGroup(ids: string[], over: Partial<InstanceGroup> = {}): InstanceGroup {
  const group = new InstanceGroup();
  group.uuid = over.uuid ?? "g1";
  group.ownerUuid = OWNER;
  group.name = "net";
  group.members = ids.map((instanceUuid) => ({ daemonId: "d1", instanceUuid }));
  group.stopOrder = ids.map((id) => memberKey("d1", id));
  group.advance = { ...defaultAdvance(), ...(over.advance ?? {}) };
  Object.assign(group, { ...over, advance: group.advance });
  return group;
}

// Advance fake time until the run leaves "running" (bounded)
async function settle(runner: InstanceGroupRunner, groupId = "g1") {
  for (let i = 0; i < 2000; i++) {
    const run = runner.getRun(OWNER, groupId);
    if (run && run.state !== "running") return run;
    await vi.advanceTimersByTimeAsync(500);
  }
  throw new Error("run did not finish");
}

// Typical ready-line behaviour: print Done after 100ms
const readyAfter =
  (ms = 100) =>
  (event: string, stream: FakeStream) => {
    if (event !== "instance/open") return;
    setTimeout(() => stream.emit("stdout", "[INFO] Done (0.1s)! For help\n"), ms);
  };
const stopsAfter =
  (ms = 50) =>
  (event: string, stream: FakeStream) => {
    if (event !== "instance/stop") return;
    setTimeout(() => stream.emit("stopped"), ms);
  };

function expectClean(env: ReturnType<typeof makeEnv>) {
  for (const stream of env.streams) {
    expect(stream.closed).toBe(true);
    expect(stream.listenerCount()).toBe(0);
  }
  // Only the 10 minute retention timer may remain
  expect(vi.getTimerCount()).toBe(1);
}

beforeEach(() => {
  emitMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("ordered start", () => {
  it("starts members one at a time in start order, advancing on the ready line", async () => {
    const order: string[] = [];
    const env = makeEnv({
      i1: { onCommand: readyAfter(100) },
      i2: { onCommand: readyAfter(200) },
      i3: { onCommand: readyAfter(100) }
    });
    const origSend = env.deps.sendCommand;
    env.deps.sendCommand = async (...args) => {
      order.push(`${args[2]}@${Date.now()}`);
      return origSend(...args);
    };
    const runner = new InstanceGroupRunner(env.deps);
    const t0 = Date.now();
    runner.start(makeGroup(["i1", "i2", "i3"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.state).toBe("succeeded");
    expect(env.log).toEqual(["start:i1", "start:i2", "start:i3"]);
    // i2 only started after i1's ready line (100ms later) and i3 after i2's (200ms later)
    const times = order.map((o) => Number(o.split("@")[1]) - t0);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(200);
    expect(run.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(run.finishedAt).toBeDefined();
    // streams were opened one at a time, each closed before the next opened
    expect(env.opened).toEqual(["i1", "i2", "i3"]);
    expectClean(env);
  });

  it("does not advance on non-matching output", async () => {
    const env = makeEnv({
      i1: {
        onCommand: (_e, s) =>
          setTimeout(() => s.emit("stdout", "Loading world\nPreparing...\n"), 50)
      },
      i2: {}
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1", "i2"], { advance: { ...defaultAdvance(), startTimeoutSec: 5 } }),
      "start",
      OPERATOR
    );
    const run = await settle(runner);
    expect(run.state).toBe("failed");
    expect(run.steps.map((s) => [s.state, s.reason])).toEqual([
      ["failed", "timeout"],
      ["pending", undefined]
    ]);
    expect(env.log).toEqual(["start:i1"]);
  });

  it("running mode advances on the opened event", async () => {
    const env = makeEnv({
      i1: { onCommand: (_e, s) => setTimeout(() => s.emit("opened"), 100) },
      i2: { onCommand: (_e, s) => setTimeout(() => s.emit("opened"), 100) }
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1", "i2"], { advance: { ...defaultAdvance(), mode: "running" } }),
      "start",
      OPERATOR
    );
    expect((await settle(runner)).state).toBe("succeeded");
    expect(env.log).toEqual(["start:i1", "start:i2"]);
    expectClean(env);
  });

  it("running mode ignores console output", async () => {
    const env = makeEnv({
      i1: { onCommand: (_e, s) => setTimeout(() => s.emit("stdout", "Done (1s)!\n"), 100) }
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1"], {
        advance: { ...defaultAdvance(), mode: "running", startTimeoutSec: 5 }
      }),
      "start",
      OPERATOR
    );
    const run = await settle(runner);
    expect(run.steps[0].reason).toBe("timeout");
  });

  it("delay mode waits the delay and confirms the instance is still running", async () => {
    // Starting the instance makes the daemon report it as running afterwards
    const running = (_e: string, s: FakeStream) => {
      s.detailStatus = RUNNING;
    };
    const env = makeEnv({ i1: { onCommand: running }, i2: { onCommand: running } });
    const runner = new InstanceGroupRunner(env.deps);
    const t0 = Date.now();
    runner.start(
      makeGroup(["i1", "i2"], {
        advance: { ...defaultAdvance(), mode: "delay", delaySec: 20, startTimeoutSec: 30 }
      }),
      "start",
      OPERATOR
    );
    // Before the delay elapses only the first command was sent
    await vi.advanceTimersByTimeAsync(19_000);
    expect(env.log).toEqual(["start:i1"]);
    const run = await settle(runner);
    expect(run.state).toBe("succeeded");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40_000 - 1);
    expectClean(env);
  });

  it("delay mode fails when the instance is no longer running after the delay", async () => {
    const env = makeEnv({ i1: {}, i2: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1", "i2"], {
        advance: { ...defaultAdvance(), mode: "delay", delaySec: 10, startTimeoutSec: 30 }
      }),
      "start",
      OPERATOR
    );
    env.opened.length = 0;
    await vi.advanceTimersByTimeAsync(1);
    env.byInstance.get("i1")!.detailStatus = STOP;
    const run = await settle(runner);
    expect(run.state).toBe("failed");
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "not_running" });
    expect(run.steps[1].state).toBe("pending");
    expect(env.log).toEqual(["start:i1"]);
  });

  it("delay mode fails at once when the instance exits during the delay", async () => {
    const env = makeEnv({
      i1: { onCommand: (_e, s) => setTimeout(() => s.emit("stopped"), 2000) },
      i2: {}
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1", "i2"], {
        advance: { ...defaultAdvance(), mode: "delay", delaySec: 60, startTimeoutSec: 120 }
      }),
      "start",
      OPERATOR
    );
    await vi.advanceTimersByTimeAsync(2500);
    const run = runner.getRun(OWNER, "g1")!;
    expect(run.state).toBe("failed");
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "stopped" });
    expectClean(env);
  });

  it("fails fast on an instance failure event instead of waiting for the timeout", async () => {
    const env = makeEnv({
      i1: { onCommand: (_e, s) => setTimeout(() => s.emit("failure"), 100) },
      i2: {}
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    await vi.advanceTimersByTimeAsync(200);
    const run = runner.getRun(OWNER, "g1")!;
    expect(run.state).toBe("failed");
    expect(run.steps[0].reason).toBe("failure");
    expect(env.log).toEqual(["start:i1"]);
  });

  it("fails when the instance stops while starting (pattern mode)", async () => {
    const env = makeEnv({ i1: { onCommand: (_e, s) => setTimeout(() => s.emit("stopped"), 100) } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "stopped" });
  });

  it("fails when the daemon rejects the start command", async () => {
    const env = makeEnv({ i1: { commandError: new Error("bad start command") }, i2: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "command_failed" });
    expect(env.log).toEqual(["start:i1"]);
    expect(env.operations).toHaveLength(0);
  });

  it("fails when the daemon stream cannot be opened and sends nothing", async () => {
    const env = makeEnv({ i1: { openError: new Error("offline") } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "stream_failed" });
    expect(env.log).toEqual([]);
  });

  it("fails when the stream drops while waiting", async () => {
    const env = makeEnv({ i1: { onCommand: (_e, s) => setTimeout(() => s.emit("closed"), 100) } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0].reason).toBe("stream_closed");
  });

  it("skips members that are already running without sending a command", async () => {
    const env = makeEnv({ i1: { status: RUNNING }, i2: { onCommand: readyAfter() } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.state).toBe("succeeded");
    expect(run.steps[0]).toMatchObject({ state: "skipped", reason: "already_running" });
    expect(env.log).toEqual(["start:i2"]);
    expect(env.operations.map((o) => o.instanceUuid)).toEqual(["i2"]);
  });

  it("waits without re-sending for an instance that is already starting; busy fails", async () => {
    const env = makeEnv({
      i1: { status: STARTING },
      i2: { status: STOPPING }
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1"], { advance: { ...defaultAdvance(), startTimeoutSec: 5 } }),
      "start",
      OPERATOR
    );
    await vi.advanceTimersByTimeAsync(10);
    env.byInstance.get("i1")!.emit("stdout", "Done (3s)!\n");
    expect((await settle(runner)).state).toBe("succeeded");
    expect(env.log).toEqual([]);

    const runner2 = new InstanceGroupRunner(makeEnv({ i2: { status: BUSY } }).deps);
    runner2.start(makeGroup(["i2"]), "start", OPERATOR);
    expect((await settle(runner2)).steps[0].reason).toBe("busy");
  });

  it("writes one operation log entry per command actually sent, attributed to the operator", async () => {
    const env = makeEnv({ i1: { onCommand: readyAfter() }, i2: { onCommand: readyAfter() } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    await settle(runner);
    expect(env.operations).toEqual([
      {
        action: "start",
        daemonId: "d1",
        instanceUuid: "i1",
        nickname: "nick-i1",
        operator: OPERATOR
      },
      {
        action: "start",
        daemonId: "d1",
        instanceUuid: "i2",
        nickname: "nick-i2",
        operator: OPERATOR
      }
    ]);
  });
});

describe("ordered stop", () => {
  it("follows the stop order (different from the start order) and waits for stopped", async () => {
    const env = makeEnv({
      lobby: { status: RUNNING, onCommand: stopsAfter(50) },
      main: { status: RUNNING, onCommand: stopsAfter(80) },
      velocity: { status: RUNNING, onCommand: stopsAfter(30) }
    });
    const group = makeGroup(["lobby", "main", "velocity"]);
    group.stopOrder = ["velocity", "main", "lobby"].map((id) => memberKey("d1", id));
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(group, "stop", OPERATOR);
    const run = await settle(runner);
    expect(run.state).toBe("succeeded");
    expect(env.log).toEqual(["stop:velocity", "stop:main", "stop:lobby"]);
    expect(run.steps.map((s) => s.key)).toEqual(
      ["velocity", "main", "lobby"].map((id) => memberKey("d1", id))
    );
    expect(env.operations.map((o) => o.action)).toEqual(["stop", "stop", "stop"]);
    expectClean(env);
  });

  it("skips members that are already stopped", async () => {
    const env = makeEnv({ i1: { status: STOP }, i2: { status: RUNNING, onCommand: stopsAfter() } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "stop", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0]).toMatchObject({ state: "skipped", reason: "already_stopped" });
    expect(env.log).toEqual(["stop:i2"]);
  });

  it("a stop timeout fails the run, never kills, and leaves later members running", async () => {
    const env = makeEnv({
      i1: { status: RUNNING },
      i2: { status: RUNNING, onCommand: stopsAfter() }
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(
      makeGroup(["i1", "i2"], { advance: { ...defaultAdvance(), stopTimeoutSec: 5 } }),
      "stop",
      OPERATOR
    );
    const run = await settle(runner);
    expect(run.state).toBe("failed");
    expect(run.steps.map((s) => [s.state, s.reason])).toEqual([
      ["failed", "timeout"],
      ["pending", undefined]
    ]);
    // only the stop command for i1 was ever sent (no kill event exists in the deps)
    expect(env.log).toEqual(["stop:i1"]);
    expect(env.opened).toEqual(["i1"]);
    expectClean(env);
  });
});

describe("authorisation on every step", () => {
  it("an unassigned member is refused with no command and no stream; the run fails", async () => {
    const env = makeEnv({ i1: { onCommand: readyAfter() }, i2: {}, i3: {} });
    env.allowed.delete("i2");
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2", "i3"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.state).toBe("failed");
    expect(run.steps.map((s) => [s.state, s.reason])).toEqual([
      ["done", undefined],
      ["failed", "not_permitted"],
      ["pending", undefined]
    ]);
    expect(env.log).toEqual(["start:i1"]);
    expect(env.opened).toEqual(["i1"]);
  });

  it("unassignment while waiting on an earlier member is caught when the step is reached", async () => {
    const env = makeEnv({
      i1: { onCommand: readyAfter(1000) },
      i2: { onCommand: readyAfter() }
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    await vi.advanceTimersByTimeAsync(500);
    env.allowed.delete("i2"); // admin unassigns i2 mid-run
    const run = await settle(runner);
    expect(run.steps[1]).toMatchObject({ state: "failed", reason: "not_permitted" });
    expect(env.log).toEqual(["start:i1"]);
    expect(env.opened).toEqual(["i1"]);
  });

  it("re-checks authorisation right before sending, after the stream was opened", async () => {
    const env = makeEnv({ i1: { onCommand: readyAfter() } });
    const origOpen = env.deps.openStream;
    env.deps.openStream = async (...args) => {
      const stream = await origOpen(...args);
      env.allowed.delete("i1"); // unassigned while the stream was being opened
      return stream;
    };
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "not_permitted" });
    expect(env.log).toEqual([]);
    expectClean(env);
  });

  it("an owner that no longer exists is refused (authorize returns false)", async () => {
    const env = makeEnv({ i1: {} });
    env.deps.authorize = () => false;
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.steps[0].reason).toBe("not_permitted");
    expect(env.opened).toEqual([]);
  });
});

describe("cancel", () => {
  it("aborts the current wait, sends nothing further and releases everything", async () => {
    const env = makeEnv({ i1: {}, i2: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2"]), "start", OPERATOR);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.getRun(OWNER, "g1")!.steps[0].state).toBe("waiting");
    const run = await runner.cancel(OWNER, "g1");
    expect(run.state).toBe("cancelled");
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "pending"]);
    expect(run.steps[0].reason).toBe("cancelled");
    expect(env.log).toEqual(["start:i1"]);
    expect(env.opened).toEqual(["i1"]);
    expect(runner.isActive("g1")).toBe(false);
    expectClean(env);
    // time passing does not start anything
    await vi.advanceTimersByTimeAsync(600_000);
    expect(env.log).toEqual(["start:i1"]);
  });

  it("cancelling a finished or foreign run is refused", async () => {
    const env = makeEnv({ i1: { status: RUNNING } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    await settle(runner);
    await expect(runner.cancel(OWNER, "g1")).rejects.toMatchObject({ status: 409 });
    await expect(runner.cancel("someone-else", "g1")).rejects.toMatchObject({ status: 404 });
    await expect(runner.cancel(OWNER, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("concurrency limits", () => {
  it("refuses a second run for the same group with 409 while one is active", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    // both start and stop conflict, synchronously (before any await)
    expect(() => runner.start(makeGroup(["i1"]), "start", OPERATOR)).toThrowError(
      expect.objectContaining({ status: 409 })
    );
    expect(() => runner.start(makeGroup(["i1"]), "stop", OPERATOR)).toThrowError(
      expect.objectContaining({ status: 409 })
    );
    expect(runner.isActive("g1")).toBe(true);
    await runner.dispose();
  });

  it("allows at most 8 concurrent runs panel-wide (429), freeing a slot when one ends", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    for (let n = 0; n < MAX_ACTIVE_RUNS; n++)
      runner.start(makeGroup(["i1"], { uuid: `g${n}` }), "start", OPERATOR);
    expect(runner.activeRuns).toBe(MAX_ACTIVE_RUNS);
    expect(() => runner.start(makeGroup(["i1"], { uuid: "g9" }), "start", OPERATOR)).toThrowError(
      expect.objectContaining({ status: 429 })
    );
    await runner.cancel(OWNER, "g0");
    expect(runner.activeRuns).toBe(MAX_ACTIVE_RUNS - 1);
    runner.start(makeGroup(["i1"], { uuid: "g9" }), "start", OPERATOR);
    await runner.dispose();
    expect(runner.activeRuns).toBe(0);
  });
});

describe("run records", () => {
  it("shows progress while running: done, waiting, pending", async () => {
    const env = makeEnv({
      i1: { onCommand: readyAfter(100) },
      i2: {},
      i3: {}
    });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1", "i2", "i3"]), "start", OPERATOR);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.getRun(OWNER, "g1")!.steps.map((s) => s.state)).toEqual([
      "done",
      "waiting",
      "pending"
    ]);
    await runner.dispose();
  });

  it("is visible only to its owner", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    expect(runner.getRun("other-user", "g1")).toBeNull();
    expect(runner.getRun(OWNER, "g1")).not.toBeNull();
    await runner.dispose();
  });

  it("returns snapshots, not live objects", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    const snap = runner.start(makeGroup(["i1"]), "start", OPERATOR);
    snap.state = "succeeded";
    snap.steps[0].state = "done";
    expect(runner.getRun(OWNER, "g1")!.state).toBe("running");
    await runner.dispose();
  });

  it("retains a finished run for 10 minutes and then forgets it", async () => {
    const env = makeEnv({ i1: { status: RUNNING } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    await settle(runner);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RUN_RETENTION_MS - 1000);
    expect(runner.getRun(OWNER, "g1")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    expect(runner.getRun(OWNER, "g1")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a new run replaces a retained one and clears its retention timer", async () => {
    const env = makeEnv({ i1: { status: RUNNING } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const first = await settle(runner);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const second = await settle(runner);
    expect(second.runId).not.toBe(first.runId);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("never leaves timers or listeners behind after any outcome", async () => {
    const outcomes: Array<Record<string, MemberSpec>> = [
      { i1: { onCommand: readyAfter() } }, // success
      { i1: {} }, // timeout
      { i1: { onCommand: (_e, s) => setTimeout(() => s.emit("failure"), 10) } }, // failure
      { i1: { commandError: new Error("x") } } // command error
    ];
    for (const specs of outcomes) {
      const env = makeEnv(specs);
      const runner = new InstanceGroupRunner(env.deps);
      runner.start(makeGroup(["i1"]), "start", OPERATOR);
      await settle(runner);
      expectClean(env);
      await runner.dispose();
    }
  });
});

describe("notifications", () => {
  const types = () => emitMock.mock.calls.map((c) => c[0].type);

  it("emits run_started on accept and run_finished(succeeded) once", async () => {
    const env = makeEnv({ i1: { onCommand: readyAfter() } });
    const runner = new InstanceGroupRunner(env.deps);
    const run = runner.start(makeGroup(["i1"]), "start", OPERATOR);
    expect(types()).toEqual(["group.run_started"]);
    expect(emitMock.mock.calls[0][0]).toMatchObject({
      group: { uuid: "g1", name: "net", action: "start", runId: run.runId },
      details: { memberCount: 1 }
    });
    await settle(runner);
    expect(types()).toEqual(["group.run_started", "group.run_finished"]);
    expect(emitMock.mock.calls[1][0].details).toMatchObject({
      result: "succeeded",
      memberCount: 1
    });
    expect(typeof emitMock.mock.calls[1][0].details.durationSec).toBe("number");
  });

  it("emits run_finished with result cancelled on cancel", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    await runner.cancel(OWNER, "g1");
    expect(types()).toEqual(["group.run_started", "group.run_finished"]);
    expect(emitMock.mock.calls[1][0].details.result).toBe("cancelled");
  });

  it("emits run_failed with the failed step key and reason code", async () => {
    const env = makeEnv({ i1: { commandError: new Error("boom") } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    await settle(runner);
    expect(types()).toEqual(["group.run_started", "group.run_failed"]);
    expect(emitMock.mock.calls[1][0].details.failedStep).toEqual({
      key: memberKey("d1", "i1"),
      reason: "command_failed"
    });
  });

  it("emits nothing for validation rejections (409 / 429)", async () => {
    const env = makeEnv({ i1: {} });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    emitMock.mockClear();
    expect(() => runner.start(makeGroup(["i1"]), "stop", OPERATOR)).toThrow();
    for (let n = 1; n < MAX_ACTIVE_RUNS; n++)
      runner.start(makeGroup(["i1"], { uuid: `x${n}` }), "start", OPERATOR);
    emitMock.mockClear();
    expect(() => runner.start(makeGroup(["i1"], { uuid: "x99" }), "start", OPERATOR)).toThrow();
    expect(emitMock).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it("a throwing emitter does not change the run result", async () => {
    emitMock.mockImplementation(() => {
      throw new Error("emit broke");
    });
    const env = makeEnv({ i1: { onCommand: readyAfter() } });
    const runner = new InstanceGroupRunner(env.deps);
    runner.start(makeGroup(["i1"]), "start", OPERATOR);
    const run = await settle(runner);
    expect(run.state).toBe("succeeded");
    expect(run.steps[0].state).toBe("done");
  });
});
