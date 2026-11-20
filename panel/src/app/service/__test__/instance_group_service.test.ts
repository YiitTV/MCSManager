import { beforeEach, describe, expect, it } from "vitest";
import { InstanceGroup, MAX_GROUPS_PER_USER, memberKey } from "../../entity/instance_group";
import {
  InstanceGroupError,
  InstanceGroupService,
  InstanceGroupStore,
  MemberStatusResolver,
  buildGroupViews,
  validateRestartWarning
} from "../instance_group_service";

class StubStorage implements InstanceGroupStore {
  data = new Map<string, any>();
  stores = 0;
  failNextStore = false;
  async store(_c: string, uuid: string, object: any) {
    if (this.failNextStore) {
      this.failNextStore = false;
      throw new Error("disk full");
    }
    this.stores++;
    this.data.set(uuid, JSON.parse(JSON.stringify(object)));
  }
  async load(_c: string, Classz: any, uuid: string) {
    const raw = this.data.get(uuid);
    if (!raw) return null;
    return Object.assign(new Classz(), raw);
  }
  async list() {
    return [...this.data.keys()];
  }
  async delete(_c: string, uuid: string) {
    this.data.delete(uuid);
  }
}

const ADMIN = "adminuuid";
const USER_A = "usera";
const USER_B = "userb";
// Assignments: admin passes automatically; users need an entry
const assigned: Record<string, string[]> = {
  [USER_A]: ["d1::i1", "d1::i2", "d1::i3"],
  [USER_B]: ["d1::i9"]
};
const existing = new Set([ADMIN, USER_A, USER_B]);

function makeService(storage = new StubStorage()) {
  const service = new InstanceGroupService({
    storage: () => storage,
    userExists: (u) => existing.has(u),
    canOperate: (u, d, i) => u === ADMIN || (assigned[u] ?? []).includes(`${d}::${i}`),
    now: () => 1000
  });
  return { service, storage };
}

const m = (instanceUuid: string, daemonId = "d1") => ({ daemonId, instanceUuid });

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toMatchObject({ status });
  await promise.catch((e) => expect(e).toBeInstanceOf(InstanceGroupError));
}

describe("InstanceGroupService create", () => {
  let service: InstanceGroupService;
  let storage: StubStorage;
  beforeEach(() => ({ service, storage } = makeService()));

  it("creates a group with defaults and persists it", async () => {
    const g = await service.create(USER_A, { name: " Net ", members: [m("i1"), m("i2")] });
    expect(g.name).toBe("Net");
    expect(g.ownerUuid).toBe(USER_A);
    expect(g.stopOrder).toEqual(["d1::i1", "d1::i2"]);
    expect(g.advance).toMatchObject({
      mode: "pattern",
      pattern: "Done (*)!",
      startTimeoutSec: 180
    });
    expect(storage.data.has(g.uuid)).toBe(true);
  });

  it("accepts an explicit stop order that differs from the start order", async () => {
    const g = await service.create(USER_A, {
      name: "Net",
      members: [m("i1"), m("i2"), m("i3")],
      stopOrder: ["d1::i3", "d1::i2", "d1::i1"]
    });
    expect(g.members.map((x) => x.instanceUuid)).toEqual(["i1", "i2", "i3"]);
    expect(g.stopOrder).toEqual(["d1::i3", "d1::i2", "d1::i1"]);
  });

  it("rejects an unassigned instance with 403 and stores nothing", async () => {
    await expectStatus(service.create(USER_A, { name: "x", members: [m("i1"), m("i9")] }), 403);
    expect(storage.stores).toBe(0);
    expect(service.listByOwner(USER_A)).toHaveLength(0);
  });

  it("lets an administrator add any instance", async () => {
    await service.create(ADMIN, { name: "x", members: [m("whatever")] });
  });

  it("rejects names that are empty, blank, too long or not strings", async () => {
    for (const name of ["", "   ", "x".repeat(41), 5, null, undefined, "a\nb"])
      await expectStatus(service.create(USER_A, { name, members: [] }), 400);
    await service.create(USER_A, { name: "x".repeat(40), members: [] });
  });

  it("rejects tampered member identifiers", async () => {
    const bad: unknown[] = [
      "str",
      [{ daemonId: 1, instanceUuid: "i1" }],
      [{ daemonId: "d1", instanceUuid: "" }],
      [{ daemonId: "", instanceUuid: "i1" }],
      [{ daemonId: "d".repeat(129), instanceUuid: "i1" }],
      [{ daemonId: "d1", instanceUuid: "../etc" }],
      [{ daemonId: "d1::x", instanceUuid: "i1" }],
      [null],
      [["d1", "i1"]]
    ];
    for (const members of bad)
      await expectStatus(service.create(ADMIN, { name: "x", members }), 400);
    expect(storage.stores).toBe(0);
  });

  it("rejects duplicate members and invalid stop orders", async () => {
    await expectStatus(service.create(ADMIN, { name: "x", members: [m("i1"), m("i1")] }), 400);
    const members = [m("i1"), m("i2")];
    for (const stopOrder of [
      ["d1::i1"],
      ["d1::i1", "d1::i1"],
      ["d1::i1", "d1::i3"],
      ["d1::i1", 2],
      "d1::i1",
      null
    ])
      await expectStatus(service.create(ADMIN, { name: "x", members, stopOrder }), 400);
  });

  it("enforces the 30 member limit", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => m(`i${i}`));
    await service.create(ADMIN, { name: "x", members: thirty });
    await expectStatus(service.create(ADMIN, { name: "x", members: [...thirty, m("i30")] }), 400);
  });

  it("enforces the 20 group limit per user, independently per user", async () => {
    for (let i = 0; i < MAX_GROUPS_PER_USER; i++)
      await service.create(USER_A, { name: `g${i}`, members: [] });
    await expectStatus(service.create(USER_A, { name: "one more", members: [] }), 400);
    await service.create(USER_B, { name: "b", members: [] });
  });

  it("does not exceed the group limit under concurrent creates", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => service.create(USER_A, { name: `g${i}`, members: [] }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_GROUPS_PER_USER);
    expect(service.listByOwner(USER_A)).toHaveLength(MAX_GROUPS_PER_USER);
  });

  it("rolls back when persistence fails", async () => {
    storage.failNextStore = true;
    await expect(service.create(USER_A, { name: "x", members: [] })).rejects.toThrow("disk full");
    expect(service.listByOwner(USER_A)).toHaveLength(0);
  });

  it("validates advance settings", async () => {
    const bad: unknown[] = [
      { mode: "regex" },
      { mode: 1 },
      { pattern: "" },
      { pattern: "a".repeat(201) },
      { pattern: "a*b*c*d*e*f*g" },
      { pattern: "***" },
      { startTimeoutSec: 4 },
      { startTimeoutSec: 3601 },
      { stopTimeoutSec: 4 },
      { stopTimeoutSec: "30" },
      { stopTimeoutSec: 30.5 },
      { delaySec: -1 },
      { delaySec: 3601 },
      { mode: "delay", delaySec: 200, startTimeoutSec: 100 },
      "text"
    ];
    for (const advance of bad)
      await expectStatus(service.create(USER_A, { name: "x", members: [], advance }), 400);
    const ok = await service.create(USER_A, {
      name: "x",
      members: [],
      advance: { mode: "delay", delaySec: 20, startTimeoutSec: 20, stopTimeoutSec: 5 }
    });
    expect(ok.advance).toMatchObject({ mode: "delay", delaySec: 20, stopTimeoutSec: 5 });
  });

  it("stores regex-looking patterns as literal text", async () => {
    const g = await service.create(USER_A, {
      name: "x",
      members: [],
      advance: { pattern: "(.+)+$" }
    });
    expect(g.advance.pattern).toBe("(.+)+$");
  });

  it("ignores client supplied display data and unknown fields", async () => {
    const g = await service.create(USER_A, {
      name: "x",
      members: [{ ...m("i1"), nickname: "forged", status: 3 } as any],
      ownerUuid: USER_B,
      uuid: "forged"
    } as any);
    expect(g.ownerUuid).toBe(USER_A);
    expect(g.uuid).not.toBe("forged");
    expect(g.members[0]).toEqual(m("i1"));
  });
});

describe("InstanceGroupService ownership and update", () => {
  let service: InstanceGroupService;
  let ga: InstanceGroup;
  beforeEach(async () => {
    ({ service } = makeService());
    ga = await service.create(USER_A, {
      name: "A",
      members: [m("i1"), m("i2"), m("i3")],
      stopOrder: ["d1::i3", "d1::i2", "d1::i1"]
    });
    await service.create(USER_B, { name: "B", members: [m("i9")] });
  });

  it("lists only the caller's groups, admin included", async () => {
    await service.create(ADMIN, { name: "Adm", members: [] });
    expect(service.listByOwner(USER_A).map((g) => g.name)).toEqual(["A"]);
    expect(service.listByOwner(USER_B).map((g) => g.name)).toEqual(["B"]);
    expect(service.listByOwner(ADMIN).map((g) => g.name)).toEqual(["Adm"]);
  });

  it("treats another user's group as not found everywhere, even for an admin", async () => {
    for (const who of [USER_B, ADMIN]) {
      expect(service.find(who, ga.uuid)).toBeNull();
      await expectStatus(service.update(who, ga.uuid, { name: "hacked" }), 404);
      await expectStatus(service.remove(who, ga.uuid), 404);
    }
    expect(service.find(USER_A, ga.uuid)?.name).toBe("A");
  });

  it("changing the stop order keeps the start order", async () => {
    const g = await service.update(USER_A, ga.uuid, { stopOrder: ["d1::i1", "d1::i2", "d1::i3"] });
    expect(g.stopOrder).toEqual(["d1::i1", "d1::i2", "d1::i3"]);
    expect(g.members.map((x) => x.instanceUuid)).toEqual(["i1", "i2", "i3"]);
  });

  it("appends new members to the stop order and removes dropped ones", async () => {
    const g = await service.update(USER_A, ga.uuid, { members: [m("i3"), m("i1")] });
    expect(g.stopOrder).toEqual(["d1::i3", "d1::i1"]);
    const g2 = await service.update(USER_A, ga.uuid, { members: [m("i3"), m("i1"), m("i2")] });
    expect(g2.stopOrder).toEqual(["d1::i3", "d1::i1", "d1::i2"]);
  });

  it("revalidates members on update (403 for unassigned, nothing changes)", async () => {
    await expectStatus(service.update(USER_A, ga.uuid, { members: [m("i1"), m("i9")] }), 403);
    expect(service.find(USER_A, ga.uuid)?.members).toHaveLength(3);
  });

  it("rejects a stop order that is not a permutation of the new members", async () => {
    await expectStatus(
      service.update(USER_A, ga.uuid, { members: [m("i1")], stopOrder: ["d1::i1", "d1::i2"] }),
      400
    );
    await expectStatus(service.update(USER_A, ga.uuid, { stopOrder: ["d1::i1"] }), 400);
  });

  it("merges a partial advance over the stored one", async () => {
    const g = await service.update(USER_A, ga.uuid, { advance: { mode: "running" } });
    expect(g.advance).toMatchObject({ mode: "running", pattern: "Done (*)!" });
  });

  it("refuses member changes and deletion while a run is active", async () => {
    service.setActiveRunChecker((id) => id === ga.uuid);
    await expectStatus(service.update(USER_A, ga.uuid, { members: [m("i1")] }), 409);
    await expectStatus(service.remove(USER_A, ga.uuid), 409);
    // non-member edits are fine
    await service.update(USER_A, ga.uuid, { name: "renamed" });
    service.setActiveRunChecker(() => false);
    await service.remove(USER_A, ga.uuid);
    expect(service.find(USER_A, ga.uuid)).toBeNull();
  });

  it("applies concurrent updates in order", async () => {
    await Promise.all([
      service.update(USER_A, ga.uuid, { name: "first" }),
      service.update(USER_A, ga.uuid, { name: "second" }),
      service.update(USER_A, ga.uuid, { name: "third" })
    ]);
    expect(service.find(USER_A, ga.uuid)?.name).toBe("third");
  });
});

describe("InstanceGroupService persistence", () => {
  it("reloads groups and drops those whose owner no longer exists", async () => {
    const storage = new StubStorage();
    const { service } = makeService(storage);
    const keep = await service.create(USER_A, { name: "keep", members: [m("i1")] });
    const gone = await service.create(USER_B, { name: "gone", members: [] });
    existing.delete(USER_B);
    try {
      const { service: fresh } = makeService(storage);
      await fresh.initialize();
      expect(fresh.find(USER_A, keep.uuid)?.name).toBe("keep");
      expect(storage.data.has(gone.uuid)).toBe(false);
      expect(fresh.listByOwner(USER_B)).toHaveLength(0);
    } finally {
      existing.add(USER_B);
    }
  });

  it("sanitises corrupted stored records", async () => {
    const storage = new StubStorage();
    const { service } = makeService(storage);
    const g = await service.create(USER_A, { name: "x", members: [m("i1")] });
    const raw = storage.data.get(g.uuid);
    raw.advance = { mode: "regex", pattern: "", startTimeoutSec: 1 };
    raw.stopOrder = ["nonsense"];
    storage.data.set("badname", { ...raw, uuid: "badname", name: "" });
    const { service: fresh } = makeService(storage);
    await fresh.initialize();
    const loaded = fresh.find(USER_A, g.uuid)!;
    expect(loaded.advance.mode).toBe("pattern");
    expect(loaded.stopOrder).toEqual(["d1::i1"]);
    expect(fresh.find(USER_A, "badname")).toBeNull();
  });

  it("removeByOwner deletes all of a user's groups", async () => {
    const storage = new StubStorage();
    const { service } = makeService(storage);
    await service.create(USER_A, { name: "1", members: [] });
    await service.create(USER_A, { name: "2", members: [] });
    const b = await service.create(USER_B, { name: "b", members: [] });
    await service.removeByOwner(USER_A);
    expect(service.listByOwner(USER_A)).toHaveLength(0);
    expect([...storage.data.keys()]).toEqual([b.uuid]);
  });
});

describe("member authorisation and list view", () => {
  it("authorises admin, assigned user, rejects unassigned user and missing owner", () => {
    const { service } = makeService();
    expect(service.authorizeMember(ADMIN, "d1", "anything")).toBe(true);
    expect(service.authorizeMember(USER_A, "d1", "i1")).toBe(true);
    expect(service.authorizeMember(USER_A, "d1", "i9")).toBe(false);
    expect(service.authorizeMember(USER_A, "d2", "i1")).toBe(false);
    expect(service.authorizeMember("ghost", "d1", "i1")).toBe(false);
    expect(service.authorizeMember("", "d1", "i1")).toBe(false);
  });

  it("returns unassigned members as unavailable without name or status", async () => {
    const { service } = makeService();
    const g = await service.create(USER_A, { name: "x", members: [m("i1"), m("i2")] });
    // Unassign i2 after creation
    assigned[USER_A] = ["d1::i1", "d1::i3"];
    try {
      const asked: string[][] = [];
      const resolve: MemberStatusResolver = async (_d, uuids) => {
        asked.push(uuids);
        return new Map(uuids.map((u) => [u, { nickname: `name-${u}`, status: 3 }]));
      };
      const [view] = await buildGroupViews(service, USER_A, [g], resolve);
      expect(view.members[0]).toEqual({
        daemonId: "d1",
        instanceUuid: "i1",
        available: true,
        nickname: "name-i1",
        status: 3
      });
      expect(view.members[1]).toEqual({ daemonId: "d1", instanceUuid: "i2", available: false });
      // the unauthorised instance is never sent to the daemon
      expect(asked).toEqual([["i1"]]);
    } finally {
      assigned[USER_A] = ["d1::i1", "d1::i2", "d1::i3"];
    }
  });

  it("falls back to unknown when the daemon resolver fails or omits a member", async () => {
    const { service } = makeService();
    const g = await service.create(ADMIN, { name: "x", members: [m("i1"), m("i2", "d2")] });
    const resolve: MemberStatusResolver = async (daemonId) => {
      if (daemonId === "d2") throw new Error("offline");
      return new Map();
    };
    const [view] = await buildGroupViews(service, ADMIN, [g], resolve);
    expect(view.members.map((x) => x.status)).toEqual(["unknown", "unknown"]);
    expect(view.members.every((x) => x.available)).toBe(true);
    expect(memberKey("d1", "i1")).toBe("d1::i1");
  });
});

describe("restart warning settings", () => {
  it("migrates old records and persists cleaned settings", async () => {
    const { service, storage } = makeService();
    const group = await service.create(USER_A, { name: "Network" });
    delete storage.data.get(group.uuid).restartWarning;
    const reloaded = makeService(storage).service;
    await reloaded.initialize();
    expect(reloaded.get(USER_A, group.uuid).restartWarning.offsetsSec).toEqual([300, 60, 10]);
    const updated = await reloaded.update(USER_A, group.uuid, {
      restartWarning: { offsetsSec: [10, 80], message: "Restart\nsoon {seconds}\u2028" }
    });
    expect(updated.restartWarning).toEqual({
      offsetsSec: [80, 10],
      message: "Restart soon {seconds}"
    });
    expect(storage.data.get(group.uuid).restartWarning).toEqual(updated.restartWarning);
  });

  it.each([[[]], [[0]], [[3601]], [[10, 10]], [[1.5]], [["10"]]])(
    "rejects invalid offsets %j",
    (offsets) => {
      expect(() => validateRestartWarning({ offsetsSec: offsets })).toThrow();
    }
  );

  it("rejects empty and oversized warning text", () => {
    expect(() => validateRestartWarning({ message: "\r\n" })).toThrow();
    expect(() => validateRestartWarning({ message: "x".repeat(201) })).toThrow();
    expect(() => validateRestartWarning({ message: "say test; stop" })).toThrow();
  });
});
