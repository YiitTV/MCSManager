import { setTimeout as delay } from "node:timers/promises";
import {
  isMinecraftGameServer,
  maintenanceConsoleCommand,
  parseMaintenanceOperation,
  parsePlayerOperation,
  playerConsoleCommand,
  VELOCITY_TYPE
} from "mcsmanager-common";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import * as protocol from "../service/protocol";
import { readMaintenance } from "../service/minecraft_maintenance";
import { getPlayerRoster } from "../service/minecraft_players";
import { routerApp } from "../service/router_app";
import instances from "../service/system_instance";

const activeEdits = new WeakSet<Instance>();

function isRunning(instance: Instance) {
  return instance.status() === Instance.STATUS_RUNNING && !!instance.process;
}

type Handler = (instance: Instance, operation: unknown) => Promise<unknown>;

function minecraftRoute(event: string, handler: Handler) {
  routerApp.on(event, async (ctx, data) => {
    try {
      const id = data?.instanceUuid;
      const instance =
        typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id)
          ? instances.getInstance(id)
          : undefined;
      if (!instance || instance.isGlobalInstance()) {
        throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
      }
      protocol.response(ctx, await handler(instance, data.operation));
    } catch (error) {
      protocol.responseError(ctx, error instanceof Error ? error : String(error));
    }
  });
}

minecraftRoute("minecraft/players", async (instance) => {
  const velocity = instance.config.type === VELOCITY_TYPE;
  if ((!velocity && !isMinecraftGameServer(instance.config.type)) || !isRunning(instance)) {
    throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
  }
  const process = instance.process;
  const players = await getPlayerRoster(instance);
  if (!isRunning(instance) || instance.process !== process) {
    throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
  }
  return {
    players,
    online: instance.info.mcPingOnline ? instance.info.currentPlayers : null,
    max: instance.info.mcPingOnline ? instance.info.maxPlayers : null,
    canManage: !velocity
  };
});

minecraftRoute("minecraft/player_action", async (instance, input) => {
  const operation = parsePlayerOperation(input);
  if (!operation || !isMinecraftGameServer(instance.config.type) || !isRunning(instance)) {
    throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
  }
  await instance.execPreset("command", playerConsoleCommand(instance.config.type, operation));
  return { accepted: true };
});

minecraftRoute("minecraft/maintenance", async (instance) => {
  if (instance.config.type !== VELOCITY_TYPE)
    throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
  return { ...(await readMaintenance(instance.absoluteCwdPath())), running: isRunning(instance) };
});

minecraftRoute("minecraft/maintenance_action", async (instance, input) => {
  const operation = parseMaintenanceOperation(input);
  const process = instance.process;
  if (
    !operation ||
    instance.config.type !== VELOCITY_TYPE ||
    !isRunning(instance) ||
    activeEdits.has(instance)
  ) {
    throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
  }
  activeEdits.add(instance);
  try {
    const workspace = instance.absoluteCwdPath();
    let state = await readMaintenance(workspace);
    if (state.status !== "ready" || (operation.action !== "toggle" && !state.players)) {
      throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
    }
    if (!isRunning(instance) || instance.process !== process) {
      throw new Error($t("TXT_CODE_minecraft_ops.unavailable"));
    }
    await instance.execPreset("command", maintenanceConsoleCommand(operation));

    for (let attempt = 0; attempt < 12; attempt++) {
      await delay(250);
      if (!isRunning(instance) || instance.process !== process) break;
      state = await readMaintenance(workspace);
      if (state.status !== "ready") break;
      const confirmed =
        operation.action === "toggle"
          ? state.enabled === operation.enabled
          : state.players?.some((name) => name.toLowerCase() === operation.player.toLowerCase()) ===
            (operation.action === "add");
      if (confirmed) return { ...state, running: true, confirmed };
    }

    return { ...state, running: isRunning(instance), confirmed: false };
  } finally {
    activeEdits.delete(instance);
  }
});
