import { isValidBackupId } from "mcsmanager-common";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

routerApp.on("crash/history", (ctx, data) => {
  const uuid: unknown = data?.instanceUuid;
  if (!isValidBackupId(uuid)) throw new Error("Invalid instance id");
  const instance = InstanceSubsystem.getInstance(uuid);
  if (!instance || instance.isGlobalInstance()) throw new Error("Instance not found");
  protocol.response(ctx, instance.crashHistory.list());
});
