import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
vi.mock("../../entity/instance/instance", () => ({ default: { STATUS_RUNNING: 3 } }));
vi.mock("../../service/system_instance", () => ({ default: { getInstance: () => instance } }));
vi.mock("../../service/minecraft_maintenance", () => ({
  readMaintenance: (...args: unknown[]) => readMaintenance(...args)
}));
vi.mock("../../service/minecraft_players", () => ({ getPlayerRoster: async () => ["Notch"] }));

import type RouterContext from "../../entity/ctx";
import { routerApp } from "../../service/router_app";
import "../minecraft_operations_router";

const readMaintenance = vi.fn();
const instance = {
  config: { type: "minecraft/java/paper" },
  process: {},
  info: { mcPingOnline: true, currentPlayers: 1, maxPlayers: 20 },
  status: vi.fn(() => 3),
  isGlobalInstance: vi.fn(() => false),
  execPreset: vi.fn(async () => {}),
  absoluteCwdPath: () => "/workspace"
};

beforeEach(() => {
  vi.clearAllMocks();
  instance.config.type = "minecraft/java/paper";
  instance.status.mockReturnValue(3);
});

type Reply = { status: number; data: unknown };

function call(event: string, operation?: unknown) {
  return new Promise<Reply>((resolve) => {
    const ctx = {
      event,
      socket: {
        id: "test",
        handshake: { address: "test" },
        emit: (_: string, packet: Reply) => resolve(packet)
      }
    } as unknown as RouterContext;
    routerApp.emitRouter(event, ctx, { instanceUuid: "i1", operation });
  });
}

describe("Minecraft daemon routes", () => {
  it("returns the existing ping fields with the parsed roster", async () => {
    await expect(call("minecraft/players")).resolves.toMatchObject({
      status: 200,
      data: { players: ["Notch"], online: 1, max: 20, canManage: true }
    });
    instance.config.type = "minecraft/java/velocity";
    await expect(call("minecraft/players")).resolves.toMatchObject({
      status: 200,
      data: { canManage: false }
    });
  });

  it("dispatches a whitelisted player command only on a running backend", async () => {
    const operation = { action: "whitelistAdd", player: "Notch" };
    expect((await call("minecraft/player_action", operation)).status).toBe(200);
    expect(instance.execPreset).toHaveBeenCalledWith("command", "minecraft:whitelist add Notch");

    instance.status.mockReturnValue(0);
    expect((await call("minecraft/player_action", operation)).status).toBe(500);
    instance.status.mockReturnValue(3);
    instance.config.type = "minecraft/java/velocity";
    expect((await call("minecraft/player_action", operation)).status).toBe(500);
    expect(instance.execPreset).toHaveBeenCalledTimes(1);
  });

  it("confirms a maintenance toggle only after the plugin file reflects it", async () => {
    const operation = { action: "toggle", enabled: true };
    const before = { status: "ready", enabled: false, players: [] };
    expect((await call("minecraft/maintenance_action", operation)).status).toBe(500);
    expect(instance.execPreset).not.toHaveBeenCalled();

    instance.config.type = "minecraft/java/velocity";
    readMaintenance.mockResolvedValueOnce(before);
    readMaintenance.mockResolvedValueOnce({ ...before, enabled: true });
    await expect(call("minecraft/maintenance_action", operation)).resolves.toMatchObject({
      status: 200,
      data: { enabled: true, confirmed: true, running: true }
    });
    expect(instance.execPreset).toHaveBeenCalledWith("command", "maintenance on");

    readMaintenance.mockResolvedValue(before);
    await expect(call("minecraft/maintenance_action", operation)).resolves.toMatchObject({
      status: 200,
      data: { enabled: false, confirmed: false, running: true }
    });
  });
});
