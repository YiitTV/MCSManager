import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../common/system_storage", () => ({
  default: { store: vi.fn(), list: vi.fn(() => []), load: vi.fn() }
}));

import { register } from "../../../service/authenticated_sockets";
import { setDaemonShuttingDown } from "../../../service/panel_notifier";
import Instance from "../instance";
import InstanceConfig from "../Instance_config";

let socket: any;
let sent: any[];

function makeInstance(eventTask: Partial<InstanceConfig["eventTask"]> = {}) {
  const config = new InstanceConfig();
  config.nickname = "My Server";
  Object.assign(config.eventTask, eventTask);
  const inst = new Instance("uuid-1", config);
  vi.spyOn(inst, "execPreset").mockResolvedValue(undefined as any);
  return inst;
}

function fakeProcess(): any {
  const p: any = new EventEmitter();
  p.destroy = () => {};
  return p;
}

function payloads() {
  return sent.filter((s) => s[0] === "instance/lifecycle").map((s) => s[1].data);
}

beforeEach(() => {
  sent = [];
  socket = new EventEmitter();
  socket.connected = true;
  const orig = socket.emit.bind(socket);
  socket.emit = (e: string, ...a: any[]) =>
    e === "disconnect" ? orig(e, ...a) : sent.push([e, ...a]);
  register(socket);
});

afterEach(() => {
  setDaemonShuttingDown(false);
  socket.emit("disconnect");
});

describe("instance lifecycle notifications", () => {
  it("emits started on a manual start", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    const p = payloads();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      instanceUuid: "uuid-1",
      instanceName: "My Server",
      kind: "started",
      exitCode: null
    });
    expect(typeof p[0].at).toBe("number");
  });

  it("classifies STOPPING as stopped", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    sent.length = 0;
    inst.status(Instance.STATUS_STOPPING);
    inst.stopped(0);
    expect(payloads()).toMatchObject([{ kind: "stopped", exitCode: 0 }]);
  });

  it("classifies an unexpected exit as crashed", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    sent.length = 0;
    inst.stopped(137);
    expect(payloads()).toMatchObject([{ kind: "crashed", exitCode: 137, willAutoRestart: false }]);
  });

  it("classifies eventTask.ignore (kill/restart) as stopped", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    sent.length = 0;
    inst.ignoreEventTaskOnce();
    inst.stopped(1);
    expect(payloads()).toMatchObject([{ kind: "stopped", exitCode: 1 }]);
  });

  it("emits nothing while the daemon is shutting down", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    sent.length = 0;
    setDaemonShuttingDown();
    inst.stopped(143);
    expect(payloads()).toHaveLength(0);
  });

  it("does not emit twice when stopped is called on an already stopped instance", () => {
    const inst = makeInstance();
    inst.started(fakeProcess());
    inst.stopped(1);
    sent.length = 0;
    inst.stopped(1);
    expect(payloads()).toHaveLength(0);
  });

  it("reports willAutoRestart for a crash and only auto_restarted on the next open", async () => {
    const inst = makeInstance({ autoRestart: true, autoRestartMaxTimes: 3 });
    inst.started(fakeProcess());
    sent.length = 0;
    inst.stopped(2);
    expect(payloads()).toMatchObject([{ kind: "crashed", exitCode: 2, willAutoRestart: true }]);
    // the (mocked) restart opens the instance
    inst.started(fakeProcess());
    const p = payloads();
    expect(p).toHaveLength(2);
    expect(p[1]).toMatchObject({ kind: "auto_restarted", attempt: 1, maxAttempts: 3 });
    // a later manual start is a plain started event
    inst.config.eventTask.autoRestart = false;
    inst.stopped(0);
    sent.length = 0;
    inst.started(fakeProcess());
    expect(payloads()).toMatchObject([{ kind: "started" }]);
  });

  it("reports maxAttempts null for unlimited restarts and willAutoRestart false at the limit", () => {
    const unlimited = makeInstance({ autoRestart: true, autoRestartMaxTimes: -1 });
    unlimited.started(fakeProcess());
    sent.length = 0;
    unlimited.stopped(1);
    unlimited.started(fakeProcess());
    expect(payloads()[1]).toMatchObject({ kind: "auto_restarted", maxAttempts: null });

    const limited = makeInstance({ autoRestart: true, autoRestartMaxTimes: 1 });
    limited.autoRestartCount = 1;
    limited.started(fakeProcess());
    sent.length = 0;
    limited.stopped(1);
    expect(payloads()).toMatchObject([{ kind: "crashed", willAutoRestart: false }]);
  });

  it("clears the pending flag when the auto-restart start fails", async () => {
    const inst = makeInstance({ autoRestart: true, autoRestartMaxTimes: 3 });
    (inst.execPreset as any).mockRejectedValue(new Error("fail"));
    inst.started(fakeProcess());
    inst.stopped(1);
    await new Promise((r) => setTimeout(r, 0));
    sent.length = 0;
    inst.started(fakeProcess());
    expect(payloads()).toMatchObject([{ kind: "started" }]);
  });
});
