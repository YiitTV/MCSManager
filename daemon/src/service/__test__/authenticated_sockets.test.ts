import { EventEmitter } from "node:events";
import { BACKUP_PROTOCOL, BackupErrorCode } from "mcsmanager-common";
import type { Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcast, hasAuthenticatedPanel, register } from "../authenticated_sockets";
import { triggerScheduledBackup } from "../backup/scheduler_hook";
import { backupIndexStore } from "../backup/stores";
import { notifyInstanceLifecycle } from "../panel_notifier";
import { addGlobalSocket, delGlobalSocket } from "../protocol";

vi.mock("../log", () => ({ default: { debug: vi.fn(), warn: vi.fn() } }));

vi.mock("../backup/stores", async () => {
  const { BackupIndexStore } = await import("../backup/index_store");
  const { MemoryBackupStorage } = await import("../backup/__test__/helpers");
  return { backupIndexStore: new BackupIndexStore(new MemoryBackupStorage()) };
});

const cleanup: (() => void)[] = [];

function fakeSocket(id: string) {
  const emitter = new EventEmitter();
  const disconnect = emitter.emit.bind(emitter, "disconnect");
  const connection = Object.assign(emitter, { id, connected: true, emit: vi.fn() });
  const socket = connection as unknown as Socket;
  addGlobalSocket(socket);
  cleanup.push(() => {
    disconnect();
    delGlobalSocket(socket);
  });
  return { connection, disconnect, socket };
}

afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("authenticated panel sockets", () => {
  it("delivers lifecycle and scheduled backup packets only to authenticated panels", () => {
    const panel = fakeSocket("panel");
    const anonymous = fakeSocket("anonymous");
    register(panel.socket);

    const lifecycle = {
      instanceUuid: "inst1",
      instanceName: "My Server",
      kind: "started" as const,
      at: 1,
      exitCode: null
    };
    notifyInstanceLifecycle(lifecycle);
    expect(triggerScheduledBackup("inst1", "plan1")).toBe("triggered");

    expect(panel.connection.emit.mock.calls).toEqual([
      [
        "instance/lifecycle",
        { uuid: null, status: 200, event: "instance/lifecycle", data: lifecycle }
      ],
      [
        BACKUP_PROTOCOL.TRIGGER,
        {
          uuid: null,
          status: 200,
          event: BACKUP_PROTOCOL.TRIGGER,
          data: { instanceUuid: "inst1", planId: "plan1" }
        }
      ]
    ]);
    expect(anonymous.connection.emit).not.toHaveBeenCalled();
  });

  it("registers each socket once and removes it when the disconnect event fires", () => {
    const panel = fakeSocket("panel");
    register(panel.socket);
    register(panel.socket);
    expect(panel.connection.listenerCount("disconnect")).toBe(1);
    expect(hasAuthenticatedPanel()).toBe(true);
    broadcast("event", {});
    expect(panel.connection.emit).toHaveBeenCalledTimes(1);

    panel.disconnect();
    expect(hasAuthenticatedPanel()).toBe(false);
    broadcast("event", {});
    expect(panel.connection.emit).toHaveBeenCalledTimes(1);
  });

  it.each(["presence check", "broadcast"])("prunes disconnected sockets on %s", (operation) => {
    const panel = fakeSocket("panel");
    register(panel.socket);
    panel.connection.connected = false;

    if (operation === "broadcast") broadcast("event", {});
    else expect(hasAuthenticatedPanel()).toBe(false);

    panel.connection.connected = true;
    expect(hasAuthenticatedPanel()).toBe(false);
    expect(panel.connection.emit).not.toHaveBeenCalled();
  });

  it("continues broadcasting after an emit throws", () => {
    const bad = fakeSocket("bad");
    const healthy = fakeSocket("healthy");
    bad.connection.emit.mockImplementation(() => {
      throw new Error("boom");
    });
    register(bad.socket);
    register(healthy.socket);

    expect(() => broadcast("event", {})).not.toThrow();
    expect(healthy.connection.emit).toHaveBeenCalledTimes(1);
  });

  it("records a scheduled backup failure with only unauthenticated sockets", async () => {
    const anonymous = fakeSocket("anonymous");
    expect(hasAuthenticatedPanel()).toBe(false);
    expect(triggerScheduledBackup("inst1", "plan1", undefined, "My Server")).toBe(
      "panel_unreachable"
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await backupIndexStore.takePendingEvents()).toMatchObject([
      { errorCode: BackupErrorCode.PANEL_UNREACHABLE, instanceName: "My Server" }
    ]);
    expect(anonymous.connection.emit).not.toHaveBeenCalled();
  });
});
