import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import Koa from "koa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE } from "../../entity/user";
import router from "../instance_monitoring_router";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getDaemon: vi.fn(),
  request: vi.fn()
}));

vi.mock("../../service/user_service", () => ({ default: { getInstance: mocks.getUser } }));
vi.mock("../../service/remote_service", () => ({ default: { getInstance: mocks.getDaemon } }));
vi.mock("../../service/remote_command", () => ({
  default: class {
    request = mocks.request;
  }
}));
vi.mock("../../service/log", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const result = {
  current: null,
  history: [],
  memoryLimitBytes: null,
  warnings: { memory: false, tps: false }
};

const users = {
  alice: { permission: ROLE.USER, instances: [{ daemonId: "node-1", instanceUuid: "server-1" }] },
  bob: { permission: ROLE.USER, instances: [{ daemonId: "node-2", instanceUuid: "server-1" }] },
  admin: { permission: ROLE.ADMIN, instances: [] }
};

async function request(query: string, user?: keyof typeof users, token = "valid") {
  const app = new Koa();
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = `/protected_instance/monitoring?${query}&token=${token}`;
  req.headers["x-requested-with"] = "XMLHttpRequest";
  const res = new ServerResponse(req);
  const ctx = app.createContext(req, res);
  ctx.session = user ? { uuid: user, userName: user, login: true, token: "valid" } : {};
  await router.routes()(ctx, async () => undefined);
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockImplementation((uuid: keyof typeof users) => users[uuid]);
  mocks.request.mockResolvedValue(result);
});

describe("instance monitoring route", () => {
  it("allows the exact daemon and instance assignment and forwards compact mode", async () => {
    const ctx = await request("daemonId=node-1&uuid=server-1&view=compact", "alice");
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual(result);
    expect(ctx.response.get("Cache-Control")).toBe("no-store");
    expect(mocks.getDaemon).toHaveBeenCalledWith("node-1");
    expect(mocks.request).toHaveBeenCalledWith("instance/monitoring", {
      instanceUuid: "server-1",
      compact: true
    });
  });

  it("allows an administrator to request full monitoring", async () => {
    expect((await request("daemonId=node-1&uuid=server-1", "admin")).status).toBe(200);
    expect(mocks.request).toHaveBeenCalledWith("instance/monitoring", {
      instanceUuid: "server-1",
      compact: false
    });
  });

  it("blocks anonymous, invalid-token, and unassigned requests before daemon access", async () => {
    const query = "daemonId=node-1&uuid=server-1";
    expect((await request(query)).status).toBe(403);
    expect((await request(query, "alice", "wrong")).status).toBe(403);
    expect((await request(query, "bob")).status).toBe(403);
    expect(mocks.getDaemon).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    "daemonId=node-1&uuid=server%2f1",
    "daemonId=node-1&uuid=server-1&uuid=server-2",
    "daemonId=node-1",
    "daemonId=node%0a&uuid=server-1",
    "daemonId=node-1&uuid=server-1&view=long",
    `daemonId=node-1&uuid=${"a".repeat(65)}`
  ])("rejects malformed input before daemon access (%s)", async (query) => {
    expect((await request(query, "admin")).status).toBe(400);
    expect(mocks.getDaemon).not.toHaveBeenCalled();
  });
});
