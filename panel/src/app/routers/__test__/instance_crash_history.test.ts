import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import Koa from "koa";
import { beforeEach, expect, it, vi } from "vitest";
import { User } from "../../entity/user";
import { fakeDaemon } from "../../service/__test__/fake_daemon";
import userSystem from "../../service/user_service";
import router from "../instance_operate_router";

vi.mock("../../setting", () => ({ systemConfig: {} }));
vi.mock(
  "../../service/remote_command",
  async () => (await import("../../service/__test__/fake_daemon")).remoteCommandMock
);
vi.mock(
  "../../service/remote_service",
  async () => (await import("../../service/__test__/fake_daemon")).remoteServiceMock
);
vi.mock(
  "../../service/log",
  async () => (await import("../../service/__test__/fake_daemon")).logMock
);

const app = new Koa();
const dispatch = router.routes();
const summary = { at: 123, exitCode: 1, frames: [] };
beforeEach(() => {
  fakeDaemon.reset();
  fakeDaemon.on("crash/history", () => [summary]);
  const user = new User();
  user.uuid = "crash-owner";
  user.userName = "crash-owner";
  user.permission = 1;
  user.instances = [{ daemonId: "d1", instanceUuid: "inst1" }];
  userSystem.setInstance(user.uuid, user);
});

async function history(query: string) {
  const req = new IncomingMessage({} as Socket);
  req.method = "GET";
  req.url = `/protected_instance/crash_history?token=test&${query}`;
  req.headers["x-requested-with"] = "XMLHttpRequest";
  const ctx = app.createContext(req, new ServerResponse(req));
  ctx.session = { login: true, uuid: "crash-owner", userName: "crash-owner", token: "test" };
  await dispatch(ctx, async () => undefined);
  return ctx;
}

it("rejects unassigned instance and node pairs without contacting the daemon", async () => {
  expect((await history("daemonId=d1&uuid=inst2")).status).toBe(403);
  expect((await history("daemonId=d2&uuid=inst1")).status).toBe(403);
  expect(fakeDaemon.calls).toEqual([]);
});

it("returns summaries for the assigned instance", async () => {
  const ctx = await history("daemonId=d1&uuid=inst1");
  expect(ctx.status).toBe(200);
  expect(ctx.body).toEqual([summary]);
  expect(fakeDaemon.callsOf("crash/history")[0].data).toEqual({ instanceUuid: "inst1" });
});
