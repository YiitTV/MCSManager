import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});

import {
  addAuthenticatedSocket,
  authenticatedSocketCount,
  broadcastToAuthenticated
} from "../../authenticated_sockets";
import { BACKUP_PROTOCOL } from "mcsmanager-common";
import { BackupIndexStore } from "../index_store";
import { triggerScheduledBackup } from "../scheduler_hook";
import { MemoryBackupStorage } from "./helpers";

function fakeSocket(id: string) {
  const s: any = new EventEmitter();
  s.id = id;
  s.disconnected = false;
  s.emit = vi.fn(s.emit.bind(s));
  s.handshake = { address: "127.0.0.1" };
  return s;
}

describe("authenticated socket broadcast", () => {
  it("reaches only authenticated sockets and drops disconnected ones", () => {
    const anon = fakeSocket("anon");
    const panel = fakeSocket("panel");
    addAuthenticatedSocket(panel);
    expect(authenticatedSocketCount()).toBe(1);
    expect(broadcastToAuthenticated("backup/trigger", { a: 1 })).toBe(1);
    expect(panel.emit).toHaveBeenCalledWith(
      "backup/trigger",
      expect.objectContaining({ status: 200, data: { a: 1 } })
    );
    expect(anon.emit).not.toHaveBeenCalled();
    panel.disconnected = true;
    panel.emit("disconnect");
    expect(authenticatedSocketCount()).toBe(0);
  });

  it("scheduled trigger uses the authenticated set by default", async () => {
    const anon = fakeSocket("anon2");
    const panel = fakeSocket("panel2");
    addAuthenticatedSocket(panel);
    triggerScheduledBackup("inst1", "plan1");
    const call = panel.emit.mock.calls.find((c: any[]) => c[0] === BACKUP_PROTOCOL.TRIGGER);
    expect(call[1].data).toEqual({ instanceUuid: "inst1", planId: "plan1" });
    expect(anon.emit).not.toHaveBeenCalled();
    panel.disconnected = true;
    // no authenticated panel left: failure recorded instead (with the instance name)
    const store = new BackupIndexStore(new MemoryBackupStorage());
    triggerScheduledBackup(
      "inst1",
      "plan1",
      { store, hasPanel: () => authenticatedSocketCount() > 0, broadcast: vi.fn(), now: () => 1 },
      "My Server"
    );
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.takePendingEvents())[0].instanceName).toBe("My Server");
  });
});
