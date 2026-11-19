import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_PROTOCOL,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupErrorCode,
  BackupFinishedPayload,
  BackupRunReq,
  DestinationDriver,
  PlainBackupDestination
} from "mcsmanager-common";
import { createLocalDriver } from "../destinations/local";
import { BackupError } from "../errors";
import { BackupIndexStore } from "../index_store";
import { BackupJobRunner, RunnerInstance } from "../job_runner";
import { BackupQueue } from "../queue";
import { FakeDriver } from "./fake_driver";
import { MemoryBackupStorage } from "./helpers";

vi.mock("../../log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});

class FakeInstance implements RunnerInstance {
  name = "My Server";
  stopped = true;
  sent: string[] = [];
  listeners = new Set<(t: string) => void>();
  constructor(private readonly cwd: string) {}
  absoluteCwdPath() {
    return this.cwd;
  }
  isStopped() {
    return this.stopped;
  }
  isRunning() {
    return !this.stopped;
  }
  async sendCommand(c: string) {
    this.sent.push(c);
    if (c === "save-all flush")
      setImmediate(() => this.listeners.forEach((l) => l("Saved the game")));
  }
  onOutput(l: (t: string) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

let base: string;
let instDir: string;
let staging: string;
let localDir: string;
let inst: FakeInstance;
let store: BackupIndexStore;
let events: { event: string; payload: any }[];
let drivers: Record<string, DestinationDriver>;
let panel = true;
let free = 1e12;

function dest(id: string, type: "local" | "s3" | "gdrive" = "s3"): PlainBackupDestination {
  if (type === "local") {
    return {
      id,
      type,
      name: id,
      createdAt: 0,
      updatedAt: 0,
      secrets: {},
      config: { directory: localDir, maxTotalBytes: 1e12 }
    } as any;
  }
  return {
    id,
    type: "s3",
    name: id,
    createdAt: 0,
    updatedAt: 0,
    secrets: { secretAccessKey: "SUPERSECRETKEY123" },
    config: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bucket-1",
      pathStyle: true,
      allowPrivateNetwork: false,
      accessKeyId: "AKIA1234"
    }
  } as any;
}

function makeRunner(over: Record<string, any> = {}) {
  const queue = new BackupQueue();
  const runner = new BackupJobRunner({
    getInstance: (u) => (u === "inst1" ? inst : undefined),
    store,
    queue,
    driverFactory: (d) => drivers[d.id] ?? createLocalDriver(d as any),
    stagingDir: staging,
    broadcast: (event, payload) => events.push({ event, payload }),
    hasPanel: () => panel,
    maxUncompressedBytes: () => 1e12,
    statfs: async () => ({ bavail: free, bsize: 1 }),
    lowerPriority: () => () => undefined,
    sleep: async () => undefined,
    ...over
  });
  return { runner, queue };
}

function req(
  destinations: PlainBackupDestination[],
  over: Partial<BackupRunReq["plan"]> = {}
): BackupRunReq {
  return {
    instanceUuid: "inst1",
    plan: {
      id: "plan1",
      name: "Plan",
      include: ["world"],
      exclude: [],
      retention: 3,
      destinationIds: destinations.map((d) => d.id),
      minecraftSaveHook: false,
      ...over
    },
    destinations,
    trigger: "manual",
    initiatedBy: "alice"
  };
}

const finished = () =>
  events
    .filter((e) => e.event === BACKUP_PROTOCOL.FINISHED)
    .map((e) => e.payload as BackupFinishedPayload);

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "bk-runner-"));
  instDir = path.join(base, "inst");
  staging = path.join(base, "staging");
  localDir = path.join(base, "local");
  await fs.outputFile(path.join(instDir, "world/level.dat"), "level-v1");
  await fs.outputFile(path.join(instDir, "world/region/r.mca"), "region");
  inst = new FakeInstance(instDir);
  store = new BackupIndexStore(new MemoryBackupStorage());
  events = [];
  drivers = {};
  panel = true;
  free = 1e12;
});
afterEach(() => fs.remove(base));

describe("backup job", () => {
  it("archives to every destination, records, and emits one finished event", async () => {
    const s3 = new FakeDriver("s3");
    drivers = { s3a: s3 };
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("local", "local"), dest("s3a")]));
    await queue.whenIdle();
    const rec = store.get("inst1", backupId)!;
    expect(rec.copies.local.status).toBe("ok");
    expect(rec.copies.s3a.status).toBe("ok");
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.pathExists(path.join(localDir, rec.copies.local.remoteId!))).toBe(true);
    expect(s3.objects.size).toBe(1);
    expect(finished()).toHaveLength(1);
    expect(finished()[0].errorSummary).toBeUndefined();
    expect(finished()[0].initiatedBy).toBe("alice");
    expect(await fs.readdir(staging)).toEqual([]);
    expect(store.listInflight()).toEqual([]);
  });

  it("partial failure: job succeeds with failed copy and no error summary", async () => {
    const s3 = new FakeDriver("s3");
    s3.failPutWith = BackupDriverErrorCode.AUTH;
    drivers = { s3a: s3 };
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("local", "local"), dest("s3a")]));
    await queue.whenIdle();
    const rec = store.get("inst1", backupId)!;
    expect(rec.copies.local.status).toBe("ok");
    expect(rec.copies.s3a.status).toBe("failed");
    expect(rec.copies.s3a.error).toBeTruthy();
    expect(finished()).toHaveLength(1);
    expect(finished()[0].errorCode).toBeUndefined();
    expect(s3.putCalls).toBe(1); // AUTH is not retried
    expect(rec.warnings).toHaveLength(1);
    expect(rec.warnings[0]).toMatch(/^destination_failed: s3a: /);
    expect(finished()[0].record.warnings).toEqual(rec.warnings);
    expect(finished()[0].instanceName).toBe("My Server");
  });

  it("all destinations failed: failed event with a summary, no secrets anywhere", async () => {
    const s3 = new FakeDriver("s3");
    s3.put = async () => {
      throw new BackupDriverError(
        BackupDriverErrorCode.AUTH,
        "denied for SUPERSECRETKEY123 at https://x.example.com/a?sig=1"
      );
    };
    drivers = { s3a: s3 };
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("s3a")]));
    await queue.whenIdle();
    const f = finished();
    expect(f).toHaveLength(1);
    expect(f[0].errorCode).toBe(BackupErrorCode.ALL_DESTINATIONS_FAILED);
    expect(f[0].errorSummary).toBeTruthy();
    const dump = JSON.stringify([f, store.get("inst1", backupId)]);
    expect(dump).not.toContain("SUPERSECRETKEY123");
    expect(dump).not.toContain("example.com");
    expect(await fs.readdir(staging)).toEqual([]);
  });

  it("retries transient errors 3 times with backoff then gives up", async () => {
    const s3 = new FakeDriver("s3");
    s3.transientFailures = 99;
    drivers = { s3a: s3 };
    const sleeps: number[] = [];
    const { runner, queue } = makeRunner({ sleep: async (ms: number) => void sleeps.push(ms) });
    const { backupId } = runner.enqueueBackup(req([dest("s3a")]));
    await queue.whenIdle();
    expect(s3.putCalls).toBe(4);
    expect(sleeps).toEqual([1000, 4000, 16000]);
    expect(store.get("inst1", backupId)!.copies.s3a.status).toBe("failed");
  });

  it("succeeds after transient failures", async () => {
    const s3 = new FakeDriver("s3");
    s3.transientFailures = 2;
    drivers = { s3a: s3 };
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("s3a")]));
    await queue.whenIdle();
    expect(s3.putCalls).toBe(3);
    expect(store.get("inst1", backupId)!.copies.s3a.status).toBe("ok");
  });

  it("retention keeps exactly N on every destination after N+2 backups", async () => {
    const s3 = new FakeDriver("s3");
    drivers = { s3a: s3 };
    let t = 1000;
    const { runner, queue } = makeRunner({ now: () => (t += 10) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        runner.enqueueBackup(req([dest("local", "local"), dest("s3a")], { retention: 3 })).backupId
      );
      await queue.whenIdle();
    }
    expect(s3.objects.size).toBe(3);
    expect((await fs.readdir(localDir)).length).toBe(3);
    expect(store.list("inst1").map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("a failing destination does not prune and later recovers", async () => {
    const s3 = new FakeDriver("s3");
    drivers = { s3a: s3 };
    let t = 1000;
    const { runner, queue } = makeRunner({ now: () => (t += 10) });
    for (let i = 0; i < 2; i++) {
      runner.enqueueBackup(req([dest("s3a")], { retention: 2 }));
      await queue.whenIdle();
    }
    s3.failPutWith = BackupDriverErrorCode.AUTH;
    runner.enqueueBackup(req([dest("s3a"), dest("local", "local")], { retention: 2 }));
    await queue.whenIdle();
    expect(s3.objects.size).toBe(2);
    expect(s3.removed).toEqual([]);
  });

  it("cancel while uploading removes uploaded copies and temp files; one event", async () => {
    const slow = new FakeDriver("s3");
    slow.putDelayMs = 10_000;
    drivers = { slow };
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("local", "local"), dest("slow")]));
    for (let i = 0; i < 100 && queue.status().running?.destinationId !== "slow"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runner.cancel("inst1", backupId)).toBe(true);
    await queue.whenIdle();
    expect(await fs.readdir(localDir)).toEqual([]);
    expect(await fs.readdir(staging)).toEqual([]);
    const f = finished();
    expect(f).toHaveLength(1);
    expect(f[0].errorCode).toBe(BackupErrorCode.CANCELLED);
  });

  it("cancelling a queued job yields one failed event and never runs", async () => {
    const slow = new FakeDriver("s3");
    slow.putDelayMs = 10_000;
    drivers = { slow, s3a: new FakeDriver("s3") };
    const { runner, queue } = makeRunner();
    const first = runner.enqueueBackup(req([dest("slow")]));
    const second = runner.enqueueBackup(req([dest("s3a")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.status("inst1").queued.map((q) => q.backupId)).toEqual([second.backupId]);
    expect(runner.cancel("inst1", second.backupId)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    runner.cancel("inst1", first.backupId);
    await queue.whenIdle();
    expect(
      finished()
        .map((f) => f.record.id)
        .sort()
    ).toEqual([first.backupId, second.backupId].sort());
    expect((drivers.s3a as FakeDriver).putCalls).toBe(0);
  });

  it("refuses when the queue is full (BUSY) and when plan/destinations mismatch", async () => {
    const slow = new FakeDriver("s3");
    slow.putDelayMs = 10_000;
    drivers = { slow };
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("slow")]));
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 20; i++) runner.enqueueBackup(req([dest("slow")]));
    expect(() => runner.enqueueBackup(req([dest("slow")]))).toThrowError(
      expect.objectContaining({ code: BackupErrorCode.BUSY })
    );
    const bad = req([dest("slow")]);
    bad.plan.destinationIds = ["other"];
    expect(() => runner.enqueueBackup(bad)).toThrowError(
      expect.objectContaining({ code: BackupErrorCode.INVALID_REQUEST })
    );
    for (const e of queue.status().queued) queue.cancel("inst1", e.backupId);
    queue.cancel("inst1", queue.status().running!.backupId);
    await queue.whenIdle();
  });

  it("refuses a request with traversal include paths and unknown instances", async () => {
    const { runner } = makeRunner();
    expect(() =>
      runner.enqueueBackup(req([dest("local", "local")], { include: ["../x"] }))
    ).toThrow(BackupError);
    expect(() =>
      runner.enqueueBackup(req([dest("local", "local")], { include: ["/etc"] }))
    ).toThrow(BackupError);
    const r = req([dest("local", "local")]);
    r.instanceUuid = "nope";
    expect(() => runner.enqueueBackup(r)).toThrowError(
      expect.objectContaining({ code: BackupErrorCode.INSTANCE_NOT_FOUND })
    );
  });

  it("symlinked include escaping the instance fails the job before reading", async () => {
    await fs.outputFile(path.join(base, "secret/pw.txt"), "pw");
    await fs.symlink(path.join(base, "secret"), path.join(instDir, "evil"));
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req([dest("local", "local")], { include: ["evil"] }));
    await queue.whenIdle();
    expect(finished()[0].errorCode).toBe(BackupErrorCode.ILLEGAL_PATH);
    expect(store.get("inst1", backupId)!.copies.local.status).toBe("failed");
    expect(await fs.pathExists(localDir)).toBe(false);
  });

  it("disk space refusal happens before archiving", async () => {
    free = 5;
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("local", "local")]));
    await queue.whenIdle();
    expect(finished()[0].errorCode).toBe(BackupErrorCode.DISK_SPACE);
    expect(await fs.pathExists(staging)).toBe(false);
    expect(await fs.pathExists(localDir)).toBe(false);
  });

  it("fails with NOTHING_TO_BACKUP when no include path exists", async () => {
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("local", "local")], { include: ["nothing"] }));
    await queue.whenIdle();
    expect(finished()[0].errorCode).toBe(BackupErrorCode.NOTHING_TO_BACKUP);
  });

  it("notes missing include paths as a warning", async () => {
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(
      req([dest("local", "local")], { include: ["world", "world_nether"] })
    );
    await queue.whenIdle();
    expect(store.get("inst1", backupId)!.warnings).toEqual(["missing_path: world_nether"]);
  });

  it("runs the Minecraft hook around the archive for a running instance", async () => {
    inst.stopped = false;
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("local", "local")], { minecraftSaveHook: true }));
    await queue.whenIdle();
    expect(inst.sent).toEqual(["save-off", "save-all flush", "save-on"]);
  });

  it("sends save-on even when the job is cancelled during the hook wait", async () => {
    inst.stopped = false;
    inst.sendCommand = async (c: string) => void inst.sent.push(c); // never answers the flush
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(
      req([dest("local", "local")], { minecraftSaveHook: true })
    );
    for (let i = 0; i < 100 && !inst.sent.includes("save-all flush"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    runner.cancel("inst1", backupId);
    await queue.whenIdle();
    expect(inst.sent.at(-1)).toBe("save-on");
    expect(finished()[0].errorCode).toBe(BackupErrorCode.CANCELLED);
  });

  it("stores events as pending when no panel is connected", async () => {
    panel = false;
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("local", "local")]));
    await queue.whenIdle();
    expect(events).toEqual([]);
    const pending = await runner.pendingEvents();
    expect(pending).toHaveLength(1);
    expect(await runner.pendingEvents()).toHaveLength(0);
  });

  it("refuses new jobs when the index is full", async () => {
    const small = new BackupIndexStore(new MemoryBackupStorage(), 1);
    store = small;
    const { runner, queue } = makeRunner();
    runner.enqueueBackup(req([dest("local", "local")]));
    await queue.whenIdle();
    expect(() => runner.enqueueBackup(req([dest("local", "local")]))).toThrowError(
      expect.objectContaining({ code: BackupErrorCode.INDEX_FULL })
    );
  });

  it("recover() converts in-flight jobs to failures and cleans staging", async () => {
    await fs.outputFile(path.join(staging, "old.zip.tmp"), "junk");
    await store.setInflight({
      instanceUuid: "inst1",
      backupId: "dead1",
      planId: "plan1",
      trigger: "schedule",
      startedAt: Date.now() - 5000,
      destinations: [{ id: "s3a", name: "S3", type: "s3" }]
    });
    const { runner } = makeRunner();
    await runner.recover();
    expect(await fs.readdir(staging)).toEqual([]);
    expect(store.listInflight()).toEqual([]);
    expect(store.get("inst1", "dead1")!.copies.s3a.status).toBe("failed");
    const pending = await runner.pendingEvents();
    expect(pending[0].errorCode).toBe(BackupErrorCode.DAEMON_RESTART);
  });
});

describe("restore job", () => {
  async function backup(destinations: PlainBackupDestination[]) {
    const { runner, queue } = makeRunner();
    const { backupId } = runner.enqueueBackup(req(destinations));
    await queue.whenIdle();
    events = [];
    return { runner, queue, backupId };
  }

  it("restores from the local copy into a stopped instance", async () => {
    const { runner, queue, backupId } = await backup([dest("local", "local")]);
    await fs.outputFile(path.join(instDir, "world/level.dat"), "changed");
    runner.enqueueRestore({ instanceUuid: "inst1", recordId: backupId, destinations: [] });
    await queue.whenIdle();
    expect(await fs.readFile(path.join(instDir, "world/level.dat"), "utf8")).toBe("level-v1");
    const ev = events.find((e) => e.event === "backup/restore_finished")!;
    expect(ev.payload.ok).toBe(true);
  });

  it("restores from a remote copy when the local copy is gone", async () => {
    const s3 = new FakeDriver("s3");
    drivers = { s3a: s3 };
    const { runner, queue, backupId } = await backup([dest("local", "local"), dest("s3a")]);
    await fs.emptyDir(localDir);
    await fs.outputFile(path.join(instDir, "world/level.dat"), "changed");
    runner.enqueueRestore({
      instanceUuid: "inst1",
      recordId: backupId,
      destinations: [dest("s3a")]
    });
    await queue.whenIdle();
    expect(await fs.readFile(path.join(instDir, "world/level.dat"), "utf8")).toBe("level-v1");
  });

  it("refuses a running instance and unknown records", async () => {
    const { runner, backupId } = await backup([dest("local", "local")]);
    inst.stopped = false;
    expect(() =>
      runner.enqueueRestore({ instanceUuid: "inst1", recordId: backupId, destinations: [] })
    ).toThrowError(expect.objectContaining({ code: BackupErrorCode.INSTANCE_MUST_BE_STOPPED }));
    inst.stopped = true;
    expect(() =>
      runner.enqueueRestore({ instanceUuid: "inst1", recordId: "nope", destinations: [] })
    ).toThrowError(expect.objectContaining({ code: BackupErrorCode.RECORD_NOT_FOUND }));
  });

  it("a corrupted archive is refused and files stay unchanged", async () => {
    const { runner, queue, backupId } = await backup([dest("local", "local")]);
    const rec = store.get("inst1", backupId)!;
    const file = path.join(localDir, rec.copies.local.remoteId!);
    await fs.appendFile(file, "garbage");
    await fs.outputFile(path.join(instDir, "world/level.dat"), "changed");
    runner.enqueueRestore({ instanceUuid: "inst1", recordId: backupId, destinations: [] });
    await queue.whenIdle();
    expect(await fs.readFile(path.join(instDir, "world/level.dat"), "utf8")).toBe("changed");
    const ev = events.find((e) => e.event === "backup/restore_finished")!;
    expect(ev.payload).toMatchObject({ ok: false, errorCode: BackupErrorCode.CHECKSUM_MISMATCH });
  });

  it("download resolution finds the local copy only", async () => {
    const { runner, backupId } = await backup([dest("local", "local")]);
    const res = await runner.resolveLocalCopy("inst1", backupId);
    expect(res.fileName).toMatch(/^plan1_.+\.zip$/);
    expect(res.filePath.startsWith(localDir)).toBe(true);
    await expect(runner.resolveLocalCopy("inst1", "nope")).rejects.toThrow();
  });
});

describe("test destination", () => {
  it("returns sanitized failures and ok for local", async () => {
    const bad = new FakeDriver("s3");
    bad.test = async () => ({ ok: false, error: "403 for SUPERSECRETKEY123" });
    drivers = { s3a: bad };
    const { runner } = makeRunner();
    const r = await runner.testDestination(dest("s3a"));
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("SUPERSECRETKEY123");
    expect((await runner.testDestination(dest("local", "local"))).ok).toBe(true);
    expect((await runner.testDestination({ id: "x", type: "s3" } as any)).ok).toBe(false);
  });
});
