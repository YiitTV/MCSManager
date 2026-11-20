import Koa from "koa";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../common/storage/sys_storage", () => ({ default: {} }));
vi.mock("../../service/remote_service", () => ({ default: { getInstance: vi.fn() } }));
vi.mock("../../service/remote_command", () => ({
  default: class {
    request = request;
  }
}));
vi.mock("../../service/operation_logger", () => ({
  operationLogger: { log: vi.fn() },
  getOperationLoggerOperator: () => ({ operator_ip: "127.0.0.1", operator_name: "tester" })
}));

import { User } from "../../entity/user";
import { operationLogger } from "../../service/operation_logger";
import users from "../../service/user_service";
import router from "../minecraft_operations_router";

const request = vi.fn();
const app = new Koa();
const dispatch = router.routes();

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ accepted: true });
  for (const [uuid, permission] of [
    ["admin", 10],
    ["assigned", 1],
    ["unassigned", 1]
  ] as const) {
    const user = new User();
    user.uuid = uuid;
    user.userName = uuid;
    user.permission = permission;
    user.instances = uuid === "assigned" ? [{ daemonId: "d1", instanceUuid: "i1" }] : [];
    users.setInstance(uuid, user);
  }
});

async function call(
  uuid: string,
  method: string,
  route: string,
  body?: unknown,
  target = "daemonId=d1&uuid=i1"
) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = `/minecraft/${route}?${target}&token=token`;
  req.headers["x-requested-with"] = "XMLHttpRequest";
  const ctx = app.createContext(req, new ServerResponse(req));
  Object.assign(ctx, { session: { uuid, userName: uuid, login: true, token: "token" } });
  ctx.request.body = body;
  await dispatch(ctx, async () => {});
  return ctx;
}

describe("Minecraft operation endpoints", () => {
  it("denies unassigned players reads and writes before touching the daemon", async () => {
    expect((await call("unassigned", "GET", "players")).status).toBe(403);
    expect(
      (await call("unassigned", "POST", "player_action", { action: "op", player: "Notch" })).status
    ).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves a roster only on the assigned daemon and instance pair", async () => {
    expect(
      (await call("assigned", "GET", "players", undefined, "daemonId=d2&uuid=i1")).status
    ).toBe(403);
    expect((await call("assigned", "GET", "players")).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "minecraft/players",
      { instanceUuid: "i1", operation: undefined },
      undefined
    );
  });

  it("requires administrator permission to read and change maintenance", async () => {
    expect((await call("assigned", "GET", "maintenance")).status).toBe(403);
    expect(
      (await call("assigned", "POST", "maintenance", { action: "toggle", enabled: false })).status
    ).toBe(403);
    expect(request).not.toHaveBeenCalled();
    expect((await call("admin", "GET", "maintenance")).status).toBe(200);
    expect(
      (await call("admin", "POST", "maintenance", { action: "toggle", enabled: false })).status
    ).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "minecraft/maintenance_action",
      {
        instanceUuid: "i1",
        operation: { action: "toggle", enabled: false }
      },
      undefined
    );
    expect(operationLogger.log).toHaveBeenCalledWith(
      "instance_minecraft_action",
      expect.objectContaining({ action: "disable" }),
      "info",
      true
    );
  });

  it("validates names, action values and target IDs before sending", async () => {
    expect(
      (await call("assigned", "POST", "player_action", { action: "op", player: "Notch\n" })).status
    ).toBe(400);
    expect(
      (await call("assigned", "POST", "player_action", { action: "constructor", player: "Notch" }))
        .status
    ).toBe(400);
    expect(
      (await call("admin", "GET", "maintenance", undefined, "daemonId=d1&uuid=i1&uuid=i2")).status
    ).toBe(400);
    expect(request).not.toHaveBeenCalled();
    expect(operationLogger.log).not.toHaveBeenCalled();
  });

  it("sanitizes text, strips extra fields and audits without storing message contents", async () => {
    const result = await call("assigned", "POST", "player_action", {
      action: "tell",
      player: "Notch",
      text: "Hello\nthere",
      command: "op Notch"
    });
    expect(result.status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "minecraft/player_action",
      {
        instanceUuid: "i1",
        operation: { action: "tell", player: "Notch", text: "Hello there" }
      },
      expect.any(Number)
    );
    expect(operationLogger.log).toHaveBeenCalledWith(
      "instance_minecraft_action",
      {
        daemon_id: "d1",
        instance_id: "i1",
        player: "Notch",
        action: "tell",
        operator_name: "tester",
        operator_ip: "127.0.0.1"
      },
      "info",
      true
    );
  });
});
