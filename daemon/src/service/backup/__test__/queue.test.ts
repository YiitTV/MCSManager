import { BackupErrorCode } from "mcsmanager-common";
import { describe, expect, it } from "vitest";
import { BackupError } from "../errors";
import { BackupQueue, QueueJobSpec } from "../queue";
import { checkDiskSpace, previewRetentionFreedBytes } from "../disk_check";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function job(
  id: string,
  run: QueueJobSpec["run"],
  extra: Partial<QueueJobSpec> = {}
): QueueJobSpec {
  return {
    backupId: id,
    instanceUuid: "i1",
    kind: "backup",
    planId: "p",
    trigger: "manual",
    run,
    ...extra
  };
}

describe("BackupQueue", () => {
  it("runs one job at a time in order", async () => {
    const q = new BackupQueue();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    for (const id of ["a", "b", "c"]) {
      q.enqueue(
        job(id, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          order.push(id);
          active--;
        })
      );
    }
    await new Promise((r) => setImmediate(r));
    expect(q.status().running?.backupId).toBe("a");
    expect(q.status().queued.map((s) => s.backupId)).toEqual(["b", "c"]);
    await q.whenIdle();
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
  });

  it("rejects with BUSY beyond the queue limit", async () => {
    const q = new BackupQueue({ limit: 2 });
    const gate = deferred();
    q.enqueue(job("r", () => gate.promise));
    await new Promise((r) => setImmediate(r));
    q.enqueue(job("w1", async () => {}));
    q.enqueue(job("w2", async () => {}));
    expect(() => q.enqueue(job("w3", async () => {}))).toThrowError(
      expect.objectContaining({ code: BackupErrorCode.BUSY })
    );
    gate.resolve();
    await q.whenIdle();
  });

  it("cancels a queued job through onDropped", async () => {
    const q = new BackupQueue();
    const gate = deferred();
    const dropped: BackupError[] = [];
    q.enqueue(job("r", () => gate.promise));
    await new Promise((r) => setImmediate(r));
    q.enqueue(job("w", async () => {}, { onDropped: (e) => void dropped.push(e) }));
    expect(q.cancel("i1", "w")).toBe(true);
    expect(q.cancel("i1", "zzz")).toBe(false);
    expect(q.cancel("other", "w")).toBe(false);
    expect(dropped[0].code).toBe(BackupErrorCode.CANCELLED);
    gate.resolve();
    await q.whenIdle();
  });

  it("cancels the running job via the abort signal", async () => {
    const q = new BackupQueue();
    let reason: unknown;
    q.enqueue(
      job("r", (ctx) => {
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            reason = ctx.signal.reason;
            resolve();
          });
        });
      })
    );
    await new Promise((r) => setImmediate(r));
    expect(q.cancel("i1", "r")).toBe(true);
    expect(q.status().running?.state).toBe("cancelling");
    await q.whenIdle();
    expect((reason as BackupError).code).toBe(BackupErrorCode.CANCELLED);
  });

  it("aborts with TIMEOUT and starts the next job", async () => {
    const q = new BackupQueue({ timeoutMs: 20 });
    let reason: unknown;
    const ran: string[] = [];
    q.enqueue(
      job("slow", (ctx) => {
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            reason = ctx.signal.reason;
            resolve();
          });
        });
      })
    );
    q.enqueue(job("next", async () => void ran.push("next")));
    await q.whenIdle();
    expect((reason as BackupError).code).toBe(BackupErrorCode.TIMEOUT);
    expect(ran).toEqual(["next"]);
  });

  it("reports progress and survives a throwing job", async () => {
    const q = new BackupQueue();
    const gate = deferred();
    q.enqueue(
      job("a", async (ctx) => {
        ctx.setPhase("archiving");
        ctx.setProgress(5, 10);
        ctx.setDestination("d1");
        await gate.promise;
        throw new Error("boom");
      })
    );
    q.enqueue(job("b", async () => {}));
    await new Promise((r) => setImmediate(r));
    expect(q.status("i1").running).toMatchObject({
      phase: "archiving",
      doneBytes: 5,
      totalBytes: 10,
      destinationId: "d1"
    });
    expect(q.status("nobody").running).toBeUndefined();
    gate.resolve();
    await q.whenIdle();
    expect(q.isBusy()).toBe(false);
  });
});

describe("checkDiskSpace", () => {
  const statfs = (free: number) => async () => ({ bavail: free, bsize: 1 });
  it("passes with enough space and refuses below estimate x 1.2", async () => {
    await checkDiskSpace({ estimatedBytes: 1000, stagingDir: "/x", statfs: statfs(1200) });
    await expect(
      checkDiskSpace({ estimatedBytes: 1000, stagingDir: "/x", statfs: statfs(1199) })
    ).rejects.toMatchObject({ code: BackupErrorCode.DISK_SPACE });
  });

  it("enforces the local cap after retention", async () => {
    const dest: any = { config: { directory: "/b", maxTotalBytes: 1500 } };
    await expect(
      checkDiskSpace({
        estimatedBytes: 1000,
        stagingDir: "/x",
        statfs: statfs(1e9),
        locals: [{ destination: dest, usedBytes: 1000, freedByRetention: 0 }]
      })
    ).rejects.toMatchObject({ code: BackupErrorCode.DISK_SPACE });
    await checkDiskSpace({
      estimatedBytes: 1000,
      stagingDir: "/x",
      statfs: statfs(1e9),
      locals: [{ destination: dest, usedBytes: 1000, freedByRetention: 600 }]
    });
  });

  it("previews retention freed bytes", () => {
    const mk = (id: string, t: number, size: number, status = "ok"): any => ({
      id,
      planId: "p",
      createdAt: t,
      sizeBytes: size,
      copies: { d: { status } }
    });
    const recs = [mk("a", 1, 10), mk("b", 2, 20), mk("c", 3, 30), mk("x", 4, 99, "failed")];
    expect(previewRetentionFreedBytes(recs, "p", "d", 2)).toBe(20 + 10);
    expect(previewRetentionFreedBytes(recs, "p", "d", 1)).toBe(60);
    expect(previewRetentionFreedBytes(recs, "q", "d", 1)).toBe(0);
  });
});
