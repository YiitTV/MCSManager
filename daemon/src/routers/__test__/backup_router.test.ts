import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupErrorCode, LocalDestination } from "mcsmanager-common";
import { dispatch, packetsFor } from "../../../test/harness/router";
import { MemoryBackupStorage } from "../../service/backup/__test__/helpers";
import { backupDownloadTickets } from "../../service/backup/download_tickets";
import { BackupIndexStore } from "../../service/backup/index_store";
import { BackupJobRunner } from "../../service/backup/job_runner";
import { BackupQueue } from "../../service/backup/queue";

const runner = vi.hoisted(() => ({
  enqueueBackup: vi.fn(() => ({ backupId: "b1" })),
  enqueueRestore: vi.fn(() => ({ jobId: "j1" })),
  status: vi.fn(() => ({ queued: [] })),
  cancel: vi.fn(() => true),
  records: vi.fn(() => []),
  pendingEvents: vi.fn(async () => []),
  resolveLocalCopy: vi.fn<
    Parameters<BackupJobRunner["resolveLocalCopy"]>,
    ReturnType<BackupJobRunner["resolveLocalCopy"]>
  >(),
  testDestination: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../service/log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});
vi.mock("../../service/backup/service", () => ({ getBackupRunner: () => runner }));
vi.mock("../../service/system_instance", () => ({
  default: { exists: (u: string) => u === "inst1" }
}));

await import("../backup_router");

function call(event: string, data: any) {
  const { socket } = dispatch(event, data, { session: { login: true } } as any);
  return socket;
}
async function result(event: string, data: any) {
  const socket = call(event, data);
  const packet = packetsFor(socket, event)[0];
  if (packet) return packet;
  return new Promise<any>((resolve) => {
    socket.emit.mockImplementation((name, response) => {
      if (name === event) resolve(response);
    });
  });
}

beforeEach(() => vi.clearAllMocks());

describe("backup router", () => {
  it("runs a backup for an existing instance", async () => {
    const p = await result("backup/run", { instanceUuid: "inst1", plan: {}, destinations: [] });
    expect(p.status).toBe(200);
    expect(p.data).toEqual({ backupId: "b1" });
    expect(runner.enqueueBackup).toHaveBeenCalledOnce();
  });

  it("rejects non-object payloads, bad ids and unknown instances with coded errors", async () => {
    for (const bad of [null, "x", [], 5]) {
      const p = await result("backup/status", bad);
      expect(p.status).toBe(500);
      expect(String(p.data)).toContain(BackupErrorCode.INVALID_REQUEST);
    }
    const bad = await result("backup/records", { instanceUuid: "../etc" });
    expect(String(bad.data)).toContain(BackupErrorCode.INVALID_REQUEST);
    const missing = await result("backup/cancel", { instanceUuid: "ghost", backupId: "b" });
    expect(String(missing.data)).toContain(BackupErrorCode.INSTANCE_NOT_FOUND);
    expect(runner.cancel).not.toHaveBeenCalled();
    const badId = await result("backup/cancel", { instanceUuid: "inst1", backupId: "../b" });
    expect(String(badId.data)).toContain(BackupErrorCode.INVALID_REQUEST);
  });

  it("maps runner BackupErrors to `<CODE>: message` and hides unexpected error details", async () => {
    const { BackupError } = await import("../../service/backup/errors");
    runner.enqueueBackup.mockImplementationOnce(() => {
      throw new BackupError(BackupErrorCode.BUSY, "Backup queue is full");
    });
    const p = await result("backup/run", { instanceUuid: "inst1" });
    expect(p.data).toBe("BACKUP_BUSY: Backup queue is full");
    runner.enqueueBackup.mockImplementationOnce(() => {
      throw new Error("failed at https://secret.example.com/?token=abcdef");
    });
    const q = await result("backup/run", { instanceUuid: "inst1" });
    expect(String(q.data)).toContain(BackupErrorCode.INTERNAL);
    expect(String(q.data)).not.toContain("secret.example.com");
  });

  it("answers status, cancel, records, restore, test and pending events", async () => {
    expect((await result("backup/status", { instanceUuid: "inst1" })).data).toEqual({ queued: [] });
    expect((await result("backup/cancel", { instanceUuid: "inst1", backupId: "b" })).data).toEqual({
      cancelled: true
    });
    expect((await result("backup/records", { instanceUuid: "inst1" })).data).toEqual({
      records: []
    });
    expect(
      (await result("backup/restore", { instanceUuid: "inst1", recordId: "r", destinations: [] }))
        .data
    ).toEqual({ jobId: "j1" });
    expect((await result("backup/test_destination", { destination: {} })).data).toEqual({
      ok: true
    });
    expect((await result("backup/pending_events", {})).data).toEqual({ events: [] });
  });
});

describe("backup download tickets", () => {
  const instanceUuid = "inst1";
  const recordId = "r";
  const fileName = "p_b.zip";
  let directory: string;
  let destinations: LocalDestination[];

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "bk-ticket-"));
    destinations = [
      {
        id: "local",
        type: "local",
        name: "Local",
        config: { directory, maxTotalBytes: 1024 },
        secrets: {},
        createdAt: 0,
        updatedAt: 0
      }
    ];
    const store = new BackupIndexStore(new MemoryBackupStorage());
    await store.add(instanceUuid, {
      id: recordId,
      planId: "p",
      createdAt: 0,
      sizeBytes: 3,
      sha256: "a".repeat(64),
      trigger: "manual",
      warnings: [],
      copies: { local: { status: "ok", type: "local", name: "Local", remoteId: fileName } }
    });
    const localRunner = new BackupJobRunner({
      store,
      queue: new BackupQueue(),
      getInstance: () => undefined,
      driverFactory: () => {
        throw new Error("Download tickets do not need a destination driver");
      },
      stagingDir: path.join(directory, "staging"),
      broadcast: () => undefined,
      hasPanel: () => true,
      maxUncompressedBytes: () => 1024
    });
    runner.resolveLocalCopy.mockImplementation(localRunner.resolveLocalCopy.bind(localRunner));
  });

  afterEach(async () => {
    runner.resolveLocalCopy.mockReset();
    await fs.remove(directory);
  });

  it("issues a single-use 60 s ticket using the supplied local destination", async () => {
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, "zip");
    const withoutDestination = await result("backup/download_ticket", { instanceUuid, recordId });
    expect(withoutDestination.data).toBe("BACKUP_RECORD_NOT_FOUND: No local copy available");
    const p = await result("backup/download_ticket", { instanceUuid, recordId, destinations });
    expect(p.status).toBe(200);
    expect(p.data.ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(p.data).toMatchObject({ fileName, sizeBytes: 3 });
    expect(p.data.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    expect(backupDownloadTickets.lookup(p.data.ticket, instanceUuid)).toEqual({
      state: "valid",
      filePath,
      fileName
    });
    expect(backupDownloadTickets.lookup(p.data.ticket, "other").state).toBe("none");
    backupDownloadTickets.consume(p.data.ticket);
    expect(backupDownloadTickets.lookup(p.data.ticket, instanceUuid).state).toBe("none");
  });

  it("returns record-not-found when the recorded archive is missing", async () => {
    const packet = await result("backup/download_ticket", { instanceUuid, recordId, destinations });
    expect(packet.status).toBe(500);
    expect(packet.data).toBe("BACKUP_RECORD_NOT_FOUND: No local copy available");
  });
});
