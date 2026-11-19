import http from "node:http";
import Koa from "koa";
import koaBody from "koa-body";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../service/remote_command",
  async () => (await import("../../service/__test__/fake_daemon")).remoteCommandMock
);
vi.mock(
  "../../service/remote_service",
  async () => (await import("../../service/__test__/fake_daemon")).remoteServiceMock
);
vi.mock("../../middleware/limit", () => ({
  speedLimit: () => async (_c: any, next: () => Promise<void>) => next()
}));
vi.mock("../../service/operation_logger", () => ({
  operationLogger: { log: vi.fn() },
  getOperationLoggerOperator: () => ({})
}));
vi.mock("../../service/instance_name_service", () => ({ getInstanceNameSafely: async () => "n" }));

import { User } from "../../entity/user";
import { fakeDaemon } from "../../service/__test__/fake_daemon";
import userSystem from "../../service/user_service";
import router from "../schedule_router";

const TOKEN = "tok";
const sessions: Record<string, { uuid: string; userName: string }> = {
  admin: { uuid: "adminuuid", userName: "admin" },
  alice: { uuid: "aliceuuid", userName: "alice" }
};
function addUser(who: string, permission: number, instances: string[]) {
  const u = new User();
  u.uuid = sessions[who].uuid;
  u.userName = who;
  u.permission = permission;
  u.instances = instances.map((instanceUuid) => ({ daemonId: "d1", instanceUuid }));
  userSystem.setInstance(u.uuid, u);
}

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = new Koa();
  app.use(koaBody({ multipart: false, parsedMethods: ["GET", "PUT", "POST", "DELETE"] as any }));
  app.use(async (ctx, next) => {
    const who = ctx.get("x-test-user");
    (ctx as any).session = sessions[who] ? { login: true, token: TOKEN, ...sessions[who] } : {};
    await next();
    if (typeof ctx.body === "string")
      ctx.body = JSON.stringify({ status: ctx.status, data: ctx.body });
    else if (ctx.status === 200) ctx.body = JSON.stringify({ status: 200, data: ctx.body });
  });
  app.use(router.routes());
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => void (await new Promise((r) => server.close(r))));
beforeEach(() => {
  fakeDaemon.reset();
  addUser("admin", 10, []);
  addUser("alice", 1, ["inst1"]);
  fakeDaemon.on("schedule/register", () => true);
  fakeDaemon.on("schedule/delete", () => true);
  fakeDaemon.on("schedule/list", () => [
    { name: "backup-abcd1234", actions: [{ type: "backup", payload: "planid" }] },
    { name: "restart-daily", actions: [{ type: "restart", payload: "" }] }
  ]);
});

async function call(who: string, method: string, path: string, body?: unknown) {
  const url = new URL(base + path);
  url.searchParams.set("token", TOKEN);
  url.searchParams.set("daemonId", "d1");
  url.searchParams.set("uuid", "inst1");
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": who,
      "x-requested-with": "XMLHttpRequest"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.status;
}

const task = (type: string) => ({
  name: "t1",
  count: -1,
  time: "3600",
  type: 1,
  actions: [{ type, payload: "x" }]
});

describe("schedules with a backup action", () => {
  it("regular users cannot register one and nothing is forwarded", async () => {
    expect(await call("alice", "POST", "/protected_schedule/", task("backup"))).toBe(403);
    expect(fakeDaemon.callsOf("schedule/register")).toHaveLength(0);
  });
  it("regular users still manage ordinary schedules", async () => {
    expect(await call("alice", "POST", "/protected_schedule/", task("restart"))).toBe(200);
    expect(fakeDaemon.callsOf("schedule/register")).toHaveLength(1);
  });
  it("administrators may register them", async () => {
    expect(await call("admin", "POST", "/protected_schedule/", task("backup"))).toBe(200);
  });
  it("regular users cannot delete a backup schedule but can delete others", async () => {
    expect(
      await call(
        "alice",
        "DELETE",
        "/protected_schedule/&task_name=backup-abcd1234".replace("&", "?x=1&")
      )
    ).toBe(403);
    expect(await call("alice", "DELETE", "/protected_schedule/?x=1&task_name=restart-daily")).toBe(
      200
    );
    expect(fakeDaemon.callsOf("schedule/delete")).toHaveLength(1);
    expect(
      await call("admin", "DELETE", "/protected_schedule/?x=1&task_name=backup-abcd1234")
    ).toBe(200);
  });
});
