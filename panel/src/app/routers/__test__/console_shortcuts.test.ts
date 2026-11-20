import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import Koa from "koa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE, User } from "../../entity/user";
import userSystem from "../../service/user_service";
import router from "../instance_operate_router";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  load: vi.fn(),
  command: vi.fn()
}));
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (category: string, id: string, record: unknown) => {
        mocks.storage.set(`${category}/${id}`, structuredClone(record));
      },
      load: mocks.load
    })
  }
}));
vi.mock("../../service/remote_service", () => ({ default: { getInstance: vi.fn() } }));
vi.mock("../../service/remote_command", () => ({
  default: class {
    request = mocks.command;
  }
}));

const ADMIN = "shortcut-admin";
const ASSIGNED = "shortcut-assigned";
const UNASSIGNED = "shortcut-unassigned";
const assignments = [{ daemonId: "node1", instanceUuid: "server1" }];
const target = "daemonId=node1&uuid=server1";
const app = new Koa();
const routes = router.routes();

function setUser(uuid: string, permission: ROLE, instances = assignments) {
  const user = Object.assign(new User(), { uuid, userName: uuid, permission, instances });
  userSystem.setInstance(uuid, user);
}

async function request(user: string, method: string, body?: unknown, suffix = "", query = target) {
  const req = new IncomingMessage(new Socket());
  req.url = `/protected_instance/console_shortcuts${suffix}?token=token&${query}`;
  req.method = method;
  req.headers["x-requested-with"] = "XMLHttpRequest";
  const ctx = app.createContext(req, new ServerResponse(req));
  ctx.session = { uuid: user, userName: user, login: true, token: "token" };
  ctx.request.body = body;
  await routes(ctx, async () => {});
  return { status: ctx.status, body: ctx.body };
}

const payload = { shortcuts: [{ name: "Save", command: "save-all" }] };

beforeEach(() => {
  mocks.storage.clear();
  mocks.command.mockReset().mockResolvedValue({});
  mocks.load
    .mockReset()
    .mockImplementation(async (category, _class, id) =>
      structuredClone(mocks.storage.get(`${category}/${id}`) ?? null)
    );
  setUser(ADMIN, ROLE.ADMIN, []);
  setUser(ASSIGNED, ROLE.USER);
  setUser(UNASSIGNED, ROLE.USER, []);
});

describe("console shortcut endpoints", () => {
  it("shares the admin's saved list only with assigned operators and executes the stored command", async () => {
    expect(await request(ASSIGNED, "GET")).toEqual({ status: 200, body: [] });
    const saved = await request(ADMIN, "PUT", payload);
    expect(saved.status).toBe(200);
    const [item] = saved.body as { id: string }[];
    expect(await request(ASSIGNED, "GET")).toEqual(saved);
    expect((await request(UNASSIGNED, "GET")).status).toBe(403);
    expect((await request(ASSIGNED, "PUT", payload)).status).toBe(403);
    expect((await request(UNASSIGNED, "POST", { id: item.id }, "/run")).status).toBe(403);
    expect(
      (
        await request(
          ASSIGNED,
          "POST",
          {
            id: item.id,
            command: "untrusted override"
          },
          "/run"
        )
      ).status
    ).toBe(200);
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledWith(
      "instance/command",
      { instanceUuid: "server1", command: "save-all", requireRunning: true },
      3000
    );
    expect(await request(ADMIN, "GET", undefined, "", "daemonId=node2&uuid=server1")).toEqual({
      status: 200,
      body: []
    });
  });

  it("rejects invalid lists and stale shortcut IDs", async () => {
    const commands = ["", "x".repeat(201), "say hello\nstop", "say hello\u2028stop", "\x03"];
    for (const command of commands) {
      expect((await request(ADMIN, "PUT", { shortcuts: [{ name: "Save", command }] })).status).toBe(
        400
      );
    }
    expect(
      (await request(ADMIN, "PUT", { shortcuts: Array(21).fill(payload.shortcuts[0]) })).status
    ).toBe(400);
    expect(
      (await request(ADMIN, "PUT", payload, "", "daemonId=node1&uuid=../server1")).status
    ).toBe(400);
    expect(mocks.storage.size).toBe(0);

    const saved = await request(ADMIN, "PUT", payload);
    const [item] = saved.body as { id: string }[];
    await request(ADMIN, "PUT", { shortcuts: [] });
    expect((await request(ASSIGNED, "POST", { id: item.id }, "/run")).status).toBe(404);
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("rechecks assignment after reading storage", async () => {
    const { body } = await request(ADMIN, "PUT", payload);
    const [item] = body as { id: string }[];
    mocks.load.mockImplementationOnce(async () => {
      setUser(ASSIGNED, ROLE.USER, []);
      return { shortcuts: body };
    });
    expect((await request(ASSIGNED, "POST", { id: item.id }, "/run")).status).toBe(403);
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
