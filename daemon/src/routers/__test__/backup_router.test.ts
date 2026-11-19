import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupErrorCode } from "mcsmanager-common";
import { dispatch, flush, packetsFor } from "../../../test/harness/router";

const runner = vi.hoisted(() => ({
  enqueueBackup: vi.fn(() => ({ backupId: "b1" })),
  enqueueRestore: vi.fn(() => ({ jobId: "j1" })),
  status: vi.fn(() => ({ queued: [] })),
  cancel: vi.fn(() => true),
  records: vi.fn(() => []),
  pendingEvents: vi.fn(async () => []),
  resolveLocalCopy: vi.fn(async () => ({
    filePath: "/x/p_b.zip",
    fileName: "p_b.zip",
    sizeBytes: 3
  })),
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
  await flush();
  await flush();
  return packetsFor(socket, event)[0];
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

  it("issues a single-use 60 s ticket for the local copy", async () => {
    const p = await result("backup/download_ticket", { instanceUuid: "inst1", recordId: "r" });
    expect(p.status).toBe(200);
    expect(p.data.ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(p.data.fileName).toBe("p_b.zip");
    expect(p.data.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    const { backupDownloadTickets } = await import("../../service/backup/download_tickets");
    expect(backupDownloadTickets.lookup(p.data.ticket, "inst1")).toMatchObject({ state: "valid" });
    expect(backupDownloadTickets.lookup(p.data.ticket, "other").state).toBe("none");
  });
});
