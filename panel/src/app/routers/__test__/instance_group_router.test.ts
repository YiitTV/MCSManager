import http from "node:http";
import Koa from "koa";
import koaBody from "koa-body";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests: the REAL Koa router, permission middleware, validator,
// service and runner, with the daemon side (streams, remote requests), the
// storage backend and the operation logger replaced.

const store = new Map<string, any>();
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (_c: string, uuid: string, obj: any) =>
        void store.set(uuid, JSON.parse(JSON.stringify(obj))),
      load: async () => null,
      list: async () => [],
      delete: async (_c: string, uuid: string) => void store.delete(uuid)
    })
  }
}));
vi.mock("../../service/operation_logger", () => ({
  operationLogger: { log: vi.fn() },
  getOperationLoggerOperator: () => ({ operator_ip: "127.0.0.1", operator_name: "tester" })
}));
vi.mock("../../service/remote_service", () => ({ default: { getInstance: vi.fn() } }));
// A stream that never opens until the run is aborted: keeps runs "active"
vi.mock("../../service/daemon_event_stream", () => ({
  openDaemonEventStream: (_d: string, _i: string, opts: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    })
}));

import { User } from "../../entity/user";
import userSystem from "../../service/user_service";
import instanceGroupRunner from "../../service/instance_group_runner";
import router from "../instance_group_router";

const TOKEN = "tok";
const sessions: Record<string, { uuid: string; userName: string }> = {
  admin: { uuid: "adminuuid", userName: "admin" },
  alice: { uuid: "aliceuuid", userName: "alice" },
  bob: { uuid: "bobuuid", userName: "bob" }
};

function addUser(who: string, permission: number, instances: string[]) {
  const user = new User();
  user.uuid = sessions[who].uuid;
  user.userName = who;
  user.permission = permission;
  user.instances = instances.map((instanceUuid) => ({ daemonId: "d1", instanceUuid }));
  userSystem.setInstance(user.uuid, user);
}

let server: http.Server;
let base = "";

beforeAll(async () => {
  const app = new Koa();
  app.use(koaBody({ multipart: false, jsonLimit: "1mb" }));
  // Same wrapping the panel's protocol middleware applies, reduced to what the tests need
  app.use(async (ctx, next) => {
    const who = ctx.get("x-test-user");
    // koa-session always provides a session object; anonymous requests get an empty one
    (ctx as any).session = sessions[who] ? { login: true, token: TOKEN, ...sessions[who] } : {};
    await next();
    if (typeof ctx.body === "string")
      ctx.body = JSON.stringify({ status: ctx.status, data: ctx.body });
    else if (ctx.status === 200) ctx.body = JSON.stringify({ status: 200, data: ctx.body });
  });
  app.use(router.routes());
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await instanceGroupRunner.dispose();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  await instanceGroupRunner.dispose();
  store.clear();
  addUser("admin", 10, []);
  addUser("alice", 1, ["i1", "i2"]);
  addUser("bob", 1, ["i9"]);
  // wipe all groups from previous tests
  for (const who of Object.keys(sessions)) {
    const list = (await call(who, "GET", "/instance_group/list")).data as any[];
    for (const g of list ?? []) await call(who, "DELETE", `/instance_group/delete?id=${g.uuid}`);
  }
});

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const url = new URL(base + path);
  if (who) url.searchParams.set("token", TOKEN);
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who ? { "x-test-user": who, "x-requested-with": "XMLHttpRequest" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { http: res.status, data: parsed?.data, raw: parsed };
}

const m = (instanceUuid: string) => ({ daemonId: "d1", instanceUuid });

async function mk(who: string, name: string, ids: string[]) {
  const r = await call(who, "POST", "/instance_group/create", { name, members: ids.map(m) });
  expect(r.http, JSON.stringify(r.raw)).toBe(200);
  return r.data.uuid as string;
}

describe("CRUD and ownership", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await call(null, "GET", "/instance_group/list")).http).toBe(403);
  });

  it("creates, lists (members unknown without a daemon), updates and deletes", async () => {
    const id = await mk("alice", "Net", ["i1", "i2"]);
    const list = (await call("alice", "GET", "/instance_group/list")).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ uuid: id, name: "Net", run: null });
    expect(list[0].members.map((x: any) => [x.instanceUuid, x.available, x.status])).toEqual([
      ["i1", true, "unknown"],
      ["i2", true, "unknown"]
    ]);
    const upd = await call("alice", "PUT", `/instance_group/update?id=${id}`, { name: "Renamed" });
    expect(upd.http).toBe(200);
    expect(upd.data.name).toBe("Renamed");
    expect((await call("alice", "DELETE", `/instance_group/delete?id=${id}`)).http).toBe(200);
    expect((await call("alice", "GET", "/instance_group/list")).data).toEqual([]);
  });

  it("403 for unassigned instances (create and update); admin may add anything", async () => {
    expect(
      (await call("alice", "POST", "/instance_group/create", { name: "x", members: [m("i9")] }))
        .http
    ).toBe(403);
    const id = await mk("alice", "ok", ["i1"]);
    expect(
      (
        await call("alice", "PUT", `/instance_group/update?id=${id}`, {
          members: [m("i1"), m("i9")]
        })
      ).http
    ).toBe(403);
    expect(
      (await call("admin", "POST", "/instance_group/create", { name: "a", members: [m("zzz")] }))
        .http
    ).toBe(200);
  });

  it("another user's group (even for an admin) is not found for every endpoint", async () => {
    const id = await mk("alice", "mine", ["i1"]);
    for (const who of ["bob", "admin"]) {
      expect((await call(who, "PUT", `/instance_group/update?id=${id}`, { name: "x" })).http).toBe(
        404
      );
      expect((await call(who, "DELETE", `/instance_group/delete?id=${id}`)).http).toBe(404);
      expect((await call(who, "POST", `/instance_group/start?id=${id}`)).http).toBe(404);
      expect((await call(who, "POST", `/instance_group/stop?id=${id}`)).http).toBe(404);
      expect((await call(who, "POST", `/instance_group/cancel?id=${id}`)).http).toBe(404);
      expect((await call(who, "GET", `/instance_group/run?id=${id}`)).http).toBe(404);
      expect((await call(who, "GET", "/instance_group/list")).data).toEqual([]);
    }
    expect(instanceGroupRunner.isActive(id)).toBe(false);
  });

  it("validation errors are 400 and the id query is required", async () => {
    expect(
      (await call("alice", "POST", "/instance_group/create", { name: "", members: [] })).http
    ).toBe(400);
    expect((await call("alice", "POST", "/instance_group/create", [1])).http).toBe(400);
    expect((await call("alice", "PUT", "/instance_group/update", { name: "x" })).http).toBe(400);
    expect((await call("alice", "POST", "/instance_group/start")).http).toBe(400);
  });

  it("only forwards known fields of the body", async () => {
    const r = await call("alice", "POST", "/instance_group/create", {
      name: "x",
      members: [m("i1")],
      ownerUuid: "bobuuid",
      uuid: "forged"
    });
    expect(r.http).toBe(200);
    expect(r.data.uuid).not.toBe("forged");
    expect((await call("bob", "GET", "/instance_group/list")).data).toEqual([]);
  });
});

describe("runs", () => {
  it("start returns a runId, ignores the body, conflicts with 409 while active", async () => {
    const id = await mk("alice", "Net", ["i1", "i2"]);
    const r = await call("alice", "POST", `/instance_group/start?id=${id}`, {
      members: [m("i9")],
      instanceUuids: ["evil"]
    });
    expect(r.http, JSON.stringify(r.raw)).toBe(200);
    expect(typeof r.data.runId).toBe("string");

    const run = (await call("alice", "GET", `/instance_group/run?id=${id}`)).data.run;
    expect(run).toMatchObject({ runId: r.data.runId, action: "start", state: "running" });
    // only the stored members, in order, never the injected ones
    expect(run.steps.map((s: any) => s.key)).toEqual(["d1::i1", "d1::i2"]);

    expect((await call("alice", "POST", `/instance_group/start?id=${id}`)).http).toBe(409);
    expect((await call("alice", "POST", `/instance_group/stop?id=${id}`)).http).toBe(409);
  });

  it("refuses member changes and deletion while a run is active, allows renaming", async () => {
    const id = await mk("alice", "Net", ["i1", "i2"]);
    await call("alice", "POST", `/instance_group/start?id=${id}`);
    expect(
      (await call("alice", "PUT", `/instance_group/update?id=${id}`, { members: [m("i1")] })).http
    ).toBe(409);
    expect((await call("alice", "DELETE", `/instance_group/delete?id=${id}`)).http).toBe(409);
    expect(
      (await call("alice", "PUT", `/instance_group/update?id=${id}`, { name: "ok" })).http
    ).toBe(200);
    const list = (await call("alice", "GET", "/instance_group/list")).data;
    expect(list[0].run.state).toBe("running");
  });

  it("cancel ends the run (cancelled) and frees the group; cancel again is 409", async () => {
    const id = await mk("alice", "Net", ["i1"]);
    await call("alice", "POST", `/instance_group/start?id=${id}`);
    const c = await call("alice", "POST", `/instance_group/cancel?id=${id}`);
    expect(c.http, JSON.stringify(c.raw)).toBe(200);
    expect(c.data.run.state).toBe("cancelled");
    expect((await call("alice", "POST", `/instance_group/cancel?id=${id}`)).http).toBe(409);
    expect((await call("alice", "DELETE", `/instance_group/delete?id=${id}`)).http).toBe(200);
  });

  it("GET /run returns { run: null } when there was no run", async () => {
    const id = await mk("alice", "Net", ["i1"]);
    const r = await call("alice", "GET", `/instance_group/run?id=${id}`);
    expect(r.http).toBe(200);
    expect(r.data).toEqual({ run: null });
  });

  it("answers 429 when 8 runs are already active panel-wide", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 9; n++) ids.push(await mk("admin", `g${n}`, ["i1"]));
    for (let n = 0; n < 8; n++)
      expect((await call("admin", "POST", `/instance_group/start?id=${ids[n]}`)).http).toBe(200);
    expect((await call("admin", "POST", `/instance_group/start?id=${ids[8]}`)).http).toBe(429);
  });

  it("an unassigned member fails the run without any daemon access", async () => {
    const id = await mk("alice", "Net", ["i1"]);
    // admin unassigns i1 after the group was created
    addUser("alice", 1, []);
    const r = await call("alice", "POST", `/instance_group/start?id=${id}`);
    expect(r.http).toBe(200);
    await new Promise((res) => setTimeout(res, 20));
    const run = (await call("alice", "GET", `/instance_group/run?id=${id}`)).data.run;
    expect(run.state).toBe("failed");
    expect(run.steps[0]).toMatchObject({ state: "failed", reason: "not_permitted" });
    const list = (await call("alice", "GET", "/instance_group/list")).data;
    expect(list[0].members[0]).toEqual({ daemonId: "d1", instanceUuid: "i1", available: false });
  });
});
