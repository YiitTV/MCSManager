import { BackupRecord } from "mcsmanager-common";
import { describe, expect, it } from "vitest";
import { BackupIndexStore } from "../index_store";
import { MemoryBackupStorage } from "./helpers";

function rec(
  id: string,
  createdAt: number,
  status: "ok" | "failed" | "deleted" = "ok"
): BackupRecord {
  return {
    id,
    planId: "plan1",
    createdAt,
    sizeBytes: 1,
    sha256: "a".repeat(64),
    trigger: "manual",
    warnings: [],
    copies: { d1: { status, type: "local", name: "Local", remoteId: `${id}.zip` } }
  };
}

describe("BackupIndexStore", () => {
  it("persists and lists newest first", async () => {
    const storage = new MemoryBackupStorage();
    const store = new BackupIndexStore(storage);
    await store.add("inst1", rec("a", 1));
    await store.add("inst1", rec("b", 2));
    const again = new BackupIndexStore(storage);
    expect(again.list("inst1").map((r) => r.id)).toEqual(["b", "a"]);
    expect(again.get("inst1", "a")?.createdAt).toBe(1);
  });

  it("refuses when full of ok records", async () => {
    const store = new BackupIndexStore(new MemoryBackupStorage(), 3);
    for (let i = 0; i < 3; i++) await store.add("inst1", rec(`r${i}`, i));
    expect(store.hasCapacity("inst1")).toBe(false);
    expect(() => store.assertCapacity("inst1")).toThrow(/full/);
    expect(await store.add("inst1", rec("x", 10))).toBe(false);
    expect(store.list("inst1")).toHaveLength(3);
  });

  it("drops the oldest fully deleted/failed record first when full", async () => {
    const store = new BackupIndexStore(new MemoryBackupStorage(), 3);
    await store.add("inst1", rec("r0", 0, "ok"));
    await store.add("inst1", rec("r1", 1, "deleted"));
    await store.add("inst1", rec("r2", 2, "failed"));
    expect(store.hasCapacity("inst1")).toBe(true);
    expect(await store.add("inst1", rec("r3", 3))).toBe(true);
    expect(store.list("inst1").map((r) => r.id)).toEqual(["r3", "r2", "r0"]);
  });

  it("serialises concurrent mutations", async () => {
    const store = new BackupIndexStore(new MemoryBackupStorage());
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.add("inst1", rec(`r${i}`, i))));
    expect(store.list("inst1")).toHaveLength(25);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.mutate("inst1", (rs) => {
          rs.find((r) => r.id === `r${i}`)!.warnings.push("w");
        })
      )
    );
    expect(store.list("inst1").every((r) => r.warnings.length === 1)).toBe(true);
  });

  it("rejects unsafe or reserved instance ids", () => {
    const store = new BackupIndexStore(new MemoryBackupStorage());
    expect(() => store.list("../x")).toThrow();
    expect(() => store.list("inflight")).toThrow();
  });

  it("keeps inflight, pending events and local dirs outside instance listing", async () => {
    const store = new BackupIndexStore(new MemoryBackupStorage());
    await store.add("inst1", rec("a", 1));
    await store.setInflight({
      instanceUuid: "inst1",
      backupId: "b1",
      planId: "p",
      trigger: "manual",
      startedAt: 1,
      destinations: []
    });
    await store.rememberLocalDir("local", "/tmp/x");
    await store.addPendingEvent({} as any);
    expect(store.listInstances()).toEqual(["inst1"]);
    expect(store.listInflight()).toHaveLength(1);
    expect(store.getLocalDirs()).toEqual({ local: "/tmp/x" });
    expect(await store.takePendingEvents()).toHaveLength(1);
    expect(store.peekPendingEvents()).toHaveLength(0);
    await store.clearInflight("b1");
    expect(store.listInflight()).toHaveLength(0);
  });
});
