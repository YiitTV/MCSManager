import { BackupRecord } from "mcsmanager-common";
import { describe, expect, it } from "vitest";
import { BackupIndexStore } from "../index_store";
import { applyRetention, selectRetentionDeletions } from "../retention";
import { FakeDriver } from "./fake_driver";
import { MemoryBackupStorage } from "./helpers";

function rec(
  id: string,
  t: number,
  copies: Record<string, "ok" | "failed" | "deleted">,
  planId = "p1"
): BackupRecord {
  const out: BackupRecord["copies"] = {};
  for (const [d, status] of Object.entries(copies)) {
    out[d] = { status, type: "s3", name: d, remoteId: `${d}/${id}` };
  }
  return {
    id,
    planId,
    createdAt: t,
    sizeBytes: 1,
    sha256: "",
    trigger: "manual",
    warnings: [],
    copies: out
  };
}

const plan = (retention: number, destinationIds = ["a", "b"]) => ({
  id: "p1",
  retention,
  destinationIds
});

describe("selectRetentionDeletions", () => {
  it("keeps the newest N and deletes the rest on every destination", () => {
    const records = [1, 2, 3, 4, 5].map((i) => rec(`r${i}`, i, { a: "ok", b: "ok" }));
    const del = selectRetentionDeletions(records, plan(3), records[4]);
    expect(del.map((d) => `${d.destinationId}:${d.recordId}`).sort()).toEqual([
      "a:r1",
      "a:r2",
      "b:r1",
      "b:r2"
    ]);
  });

  it("counts only ok copies per destination", () => {
    const records = [
      rec("r1", 1, { a: "ok", b: "ok" }),
      rec("r2", 2, { a: "ok", b: "failed" }),
      rec("r3", 3, { a: "ok", b: "failed" }),
      rec("r4", 4, { a: "ok", b: "ok" })
    ];
    const del = selectRetentionDeletions(records, plan(3), records[3]);
    // a has 4 ok -> delete r1; b has 2 ok -> nothing
    expect(del).toEqual([{ recordId: "r1", destinationId: "a", remoteId: "a/r1" }]);
  });

  it("does not prune a destination whose current upload failed", () => {
    const records = [1, 2, 3].map((i) => rec(`r${i}`, i, { a: "ok", b: "ok" }));
    records.push(rec("r4", 4, { a: "ok", b: "failed" }));
    const del = selectRetentionDeletions(records, plan(1), records[3]);
    expect(del.every((d) => d.destinationId === "a")).toBe(true);
    expect(del).toHaveLength(3);
  });

  it("never selects the new record, other plans, or non-recorded copies", () => {
    const newRec = rec("new", 1, { a: "ok" }); // oldest by time on purpose
    const records = [
      newRec,
      rec("o", 5, { a: "ok" }),
      rec("other", 0, { a: "ok" }, "p2"),
      {
        ...rec("noid", 0, { a: "ok" }),
        copies: { a: { status: "ok", type: "s3", name: "a" } }
      } as BackupRecord
    ];
    const del = selectRetentionDeletions(records, plan(1, ["a"]), newRec);
    // "o" is beyond N; "other" belongs to another plan; "noid" has no recorded remote id.
    expect(del.map((d) => d.recordId)).toEqual(["o"]);
  });

  it("with N=1 deletes older ok copies but never the new one", () => {
    const newRec = rec("new", 1, { a: "ok" });
    const records = [newRec, rec("old", 5, { a: "ok" })];
    const del = selectRetentionDeletions(records, plan(1, ["a"]), newRec);
    expect(del.map((d) => d.recordId)).toEqual(["old"]);
  });
});

describe("applyRetention", () => {
  async function setup(n: number, retention: number) {
    const store = new BackupIndexStore(new MemoryBackupStorage());
    const drivers = { a: new FakeDriver(), b: new FakeDriver() };
    for (let i = 1; i <= n; i++) {
      const r = rec(`r${i}`, i, { a: "ok", b: "ok" });
      await store.add("inst", r);
      drivers.a.objects.set(`a/r${i}`, Buffer.from("x"));
      drivers.b.objects.set(`b/r${i}`, Buffer.from("x"));
    }
    const newRecord = store.get("inst", `r${n}`)!;
    const run = () =>
      applyRetention({
        store,
        instanceUuid: "inst",
        plan: plan(retention),
        newRecord,
        getDriver: (id) => (drivers as any)[id]
      });
    return { store, drivers, run };
  }

  it("N+2 backups leave exactly N on every destination", async () => {
    const { store, drivers, run } = await setup(5, 3);
    expect(await run()).toEqual([]);
    expect(drivers.a.objects.size).toBe(3);
    expect(drivers.b.objects.size).toBe(3);
    expect(store.list("inst").map((r) => r.id)).toEqual(["r5", "r4", "r3"]);
  });

  it("failed deletion keeps the copy ok, warns, and is retried next run", async () => {
    const { store, drivers, run } = await setup(4, 2);
    drivers.a.failRemove = true;
    const warnings = await run();
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/^retention_delete_failed/);
    expect(store.get("inst", "r1")?.copies.a.status).toBe("ok");
    expect(store.get("inst", "r1")?.copies.b.status).toBe("deleted");
    drivers.a.failRemove = false;
    await run();
    expect(store.list("inst").map((r) => r.id)).toEqual(["r4", "r3"]);
  });

  it("deletes only by recorded id (unknown objects untouched)", async () => {
    const { drivers, run } = await setup(3, 1);
    drivers.a.objects.set("a/unknown", Buffer.from("keep"));
    await run();
    expect(drivers.a.objects.has("a/unknown")).toBe(true);
    expect([...drivers.a.removed].sort()).toEqual(["a/r1", "a/r2"]);
  });
});
