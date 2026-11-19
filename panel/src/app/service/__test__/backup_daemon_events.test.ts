import { EventEmitter } from "node:events";
import fs from "fs-extra";
import os from "node:os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupEventPayload, BackupFinishedPayload } from "mcsmanager-common";
import { fakeDaemon, memoryStore } from "./fake_daemon";

vi.mock("../../setting", () => ({
  systemConfig: { dataPlane: "direct" },
  saveSystemConfig: vi.fn()
}));
vi.mock(
  "../../common/storage/sys_storage",
  async () => (await import("./fake_daemon")).sysStorageMock
);
vi.mock("../remote_command", async () => (await import("./fake_daemon")).remoteCommandMock);
vi.mock("../remote_service", async () => (await import("./fake_daemon")).remoteServiceMock);
vi.mock("../log", async () => (await import("./fake_daemon")).logMock);
vi.mock("../instance_name_service", () => ({ getInstanceNameSafely: async () => "Lobby" }));

import { setBackupSecretKeyFileForTest } from "../backup_secret";
import {
  attachBackupListeners,
  buildEventPayload,
  requestPendingEvents,
  resetBackupDaemonEventsForTest
} from "../backup_daemon_events";
import { backupEvents } from "../backup_events";
import { createDestination, createPlan, updatePlan } from "../backup_service";

const SECRET = "S3-SECRET-VALUE-0001";
let dir = "";
let events: BackupEventPayload[] = [];
let planId = "";
let destId = "";

const pkt = (data: unknown) => ({ uuid: null, status: 200, event: "x", data });
const flush = () => new Promise((r) => setTimeout(r, 20));

function finished(over: Partial<BackupFinishedPayload> = {}, copies?: any): BackupFinishedPayload {
  return {
    instanceUuid: "inst1",
    planId,
    durationMs: 1234,
    initiatedBy: "alice",
    record: {
      id: "bk1",
      planId,
      createdAt: 1,
      sizeBytes: 4096,
      sha256: "a".repeat(64),
      trigger: "manual",
      warnings: ["save-all timed out"],
      copies: copies ?? {
        local: { status: "ok", type: "local", name: "Local", remoteId: "plan_bk1.zip" },
        [destId]: { status: "ok", type: "s3", name: "Minio", remoteId: "inst1/key/bk1.zip" }
      }
    },
    ...over
  } as BackupFinishedPayload;
}

function setupSocket(available = true, id = "d1") {
  const socket = new EventEmitter() as any;
  const svc = { uuid: id, available, socket } as any;
  attachBackupListeners(svc, socket);
  return { socket, svc };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-evt-"));
  setBackupSecretKeyFileForTest(path.join(dir, "key"));
  memoryStore.clear();
  fakeDaemon.reset();
  fakeDaemon.knownDaemons = new Set(["d1", "d2"]);
  resetBackupDaemonEventsForTest();
  backupEvents.removeAllListeners();
  events = [];
  backupEvents.on("backup.succeeded", (e) => void events.push(e));
  backupEvents.on("backup.failed", (e) => void events.push(e));
  fakeDaemon.on("instance/detail", () => ({ status: 0 }));
  fakeDaemon.on("schedule/delete", () => true);
  fakeDaemon.on("schedule/register", () => true);
  fakeDaemon.on("backup/run", () => ({ backupId: "bk1" }));
  const d = await createDestination({
    type: "s3",
    name: "Minio",
    config: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "my-bucket",
      pathStyle: true,
      allowPrivateNetwork: false,
      accessKeyId: "AKIAEXAMPLE"
    },
    secrets: { secretAccessKey: SECRET }
  });
  destId = d.id;
  const plan = await createPlan({
    daemonId: "d1",
    uuid: "inst1",
    name: "Nightly",
    preset: "minecraft-worlds",
    retention: 3,
    destinationIds: ["local", destId],
    minecraftSaveHook: true,
    enabled: true,
    schedule: { kind: "interval", value: "3600" }
  });
  planId = plan.id;
});
afterEach(() => {
  setBackupSecretKeyFileForTest(null);
  fs.removeSync(dir);
  backupEvents.removeAllListeners();
});

describe("backup/trigger", () => {
  it("answers with a credential-bearing backup/run to that daemon only", async () => {
    const { socket } = setupSocket();
    socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId }));
    await flush();
    const runs = fakeDaemon.callsOf("backup/run");
    expect(runs).toHaveLength(1);
    expect(runs[0].daemonId).toBe("d1");
    expect(runs[0].data.trigger).toBe("schedule");
    expect(runs[0].data.instanceUuid).toBe("inst1");
    expect(runs[0].data.plan.id).toBe(planId);
    const s3 = runs[0].data.destinations.find((d: any) => d.id === destId);
    expect(s3.secrets.secretAccessKey).toBe(SECRET);
    expect(events).toHaveLength(0);
  });

  it("ignores foreign, unknown, disabled and malformed triggers", async () => {
    const { socket } = setupSocket(true, "d2"); // plan belongs to d1
    socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId }));
    const d1 = setupSocket(true, "d1");
    d1.socket.emit("backup/trigger", pkt({ instanceUuid: "other-instance", planId }));
    d1.socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId: "nope" }));
    d1.socket.emit("backup/trigger", pkt({ instanceUuid: "../x", planId: "../y" }));
    d1.socket.emit("backup/trigger", pkt(null));
    d1.socket.emit("backup/trigger", "garbage");
    await updatePlan({ id: planId, enabled: false });
    d1.socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId }));
    await flush();
    expect(fakeDaemon.callsOf("backup/run")).toHaveLength(0);
  });

  it("sends nothing before the daemon is authenticated", async () => {
    const { socket } = setupSocket(false);
    socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId }));
    await flush();
    expect(fakeDaemon.callsOf("backup/run")).toHaveLength(0);
  });

  it("reports a single failure when the run cannot be started", async () => {
    fakeDaemon.on("backup/run", () => {
      throw new Error("BACKUP_BUSY");
    });
    const { socket } = setupSocket();
    socket.emit("backup/trigger", pkt({ instanceUuid: "inst1", planId }));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "backup.failed",
      trigger: "schedule",
      errorSummary: "BACKUP_BUSY"
    });
    expect(events[0].plan).toEqual({ id: planId, name: "Nightly" });
  });
});

describe("backup/finished", () => {
  it("publishes exactly one backup.succeeded with no secrets, keys or URLs", async () => {
    const { socket } = setupSocket();
    socket.emit("backup/finished", pkt(finished()));
    socket.emit("backup/finished", pkt(finished())); // duplicate delivery
    await flush();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({
      event: "backup.succeeded",
      trigger: "manual",
      initiatedBy: "alice",
      sizeBytes: 4096,
      durationMs: 1234,
      backupId: "bk1",
      instance: { daemonId: "d1", uuid: "inst1", name: "Lobby" },
      plan: { id: planId, name: "Nightly" },
      warnings: ["save-all timed out"]
    });
    expect(e.destinations.map((d) => [d.id, d.status])).toEqual([
      ["local", "ok"],
      [destId, "ok"]
    ]);
    const text = JSON.stringify(e);
    expect(text).not.toContain("inst1/key/bk1.zip");
    expect(text).not.toContain("plan_bk1.zip");
    expect(text).not.toContain(SECRET);
  });

  it("partial failure is a success with the failed destination listed", async () => {
    const { socket } = setupSocket();
    socket.emit(
      "backup/finished",
      pkt(
        finished(
          {},
          {
            local: { status: "ok", type: "local", name: "Local" },
            [destId]: {
              status: "failed",
              type: "s3",
              name: "Minio",
              error:
                "PUT https://s3.example.com/my-bucket/k?X-Amz-Signature=abcdef failed Bearer token123"
            }
          }
        )
      )
    );
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("backup.succeeded");
    expect(events[0].destinations[1].status).toBe("failed");
    const text = JSON.stringify(events[0]);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("X-Amz-Signature=abcdef");
    expect(text).not.toContain("token123");
  });

  it("all destinations failed is backup.failed with a bounded summary", async () => {
    const { socket } = setupSocket();
    const copies = {
      local: { status: "failed", type: "local", name: "Local", error: "disk full" },
      [destId]: { status: "failed", type: "s3", name: "Minio", error: "access denied" }
    };
    socket.emit(
      "backup/finished",
      pkt(
        finished(
          { errorSummary: "x".repeat(1000), errorCode: "BACKUP_ALL_DESTINATIONS_FAILED" as any },
          copies
        )
      )
    );
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("backup.failed");
    expect(events[0].sizeBytes).toBeUndefined();
    expect(events[0].errorSummary!.length).toBeLessThanOrEqual(300);
  });

  it("ignores malformed payloads and unauthenticated daemons", async () => {
    const a = setupSocket();
    a.socket.emit("backup/finished", pkt({ record: null }));
    a.socket.emit("backup/finished", pkt(finished({ planId: "../x" })));
    a.socket.emit("backup/finished", "junk");
    const b = setupSocket(false);
    b.socket.emit("backup/finished", pkt(finished()));
    await flush();
    expect(events).toHaveLength(0);
  });

  it("falls back to the plan id for a deleted plan", async () => {
    const payload = await buildEventPayload("d1", finished({ planId: "gone-plan" }));
    expect(payload!.plan).toEqual({ id: "gone-plan", name: "gone-plan" });
  });
});

describe("listeners and the pending handshake", () => {
  it("registers once per socket and again for a reconnect socket", async () => {
    const socket = new EventEmitter() as any;
    const svc = { uuid: "d1", available: true, socket } as any;
    attachBackupListeners(svc, socket);
    attachBackupListeners(svc, socket);
    expect(socket.listenerCount("backup/finished")).toBe(1);
    expect(socket.listenerCount("backup/trigger")).toBe(1);
    const next = new EventEmitter() as any;
    attachBackupListeners({ ...svc, socket: next }, next);
    expect(next.listenerCount("backup/finished")).toBe(1);
    socket.emit("backup/finished", pkt(finished()));
    await flush();
    expect(events).toHaveLength(1);
  });

  it("replays pending events after reconnect without duplicating pushed ones", async () => {
    const { svc, socket } = setupSocket();
    socket.emit("backup/finished", pkt(finished()));
    await flush();
    const failed = finished(
      { errorSummary: "BACKUP_PANEL_UNREACHABLE" },
      { local: { status: "failed", type: "local", name: "Local", error: "panel unreachable" } }
    );
    failed.record.id = "bk2";
    fakeDaemon.on("backup/pending_events", () => ({ events: [finished(), failed] }));
    await requestPendingEvents(svc);
    expect(events.map((e) => e.backupId)).toEqual(["bk1", "bk2"]);
    expect(events[1].event).toBe("backup.failed");
    // asked again: nothing new
    await requestPendingEvents(svc);
    expect(events).toHaveLength(2);
  });

  it("an old daemon without the handshake is not an error", async () => {
    const { svc } = setupSocket();
    await expect(requestPendingEvents(svc)).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("a throwing subscriber does not break publishing", async () => {
    backupEvents.removeAllListeners();
    backupEvents.on("backup.succeeded", () => {
      throw new Error("boom");
    });
    backupEvents.on("backup.succeeded", (e) => void events.push(e));
    const { socket } = setupSocket();
    socket.emit("backup/finished", pkt(finished()));
    await flush();
    expect(events).toHaveLength(1);
  });
});
