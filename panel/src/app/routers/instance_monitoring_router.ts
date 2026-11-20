import Router from "@koa/router";
import { isMonitoringId, type InstanceMonitoringResponse } from "mcsmanager-common";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid } from "../service/permission_service";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";

const router = new Router({ prefix: "/protected_instance" });

router.get("/monitoring", permission({ level: ROLE.USER }), async (ctx) => {
  const { daemonId, uuid, view } = ctx.query;
  if (
    !isMonitoringId(daemonId) ||
    !isMonitoringId(uuid) ||
    (view !== undefined && view !== "compact")
  ) {
    ctx.status = 400;
    ctx.body = $t("TXT_CODE_instance_monitoring.invalidRequest");
    return;
  }
  if (!isHaveInstanceByUuid(getUserUuid(ctx), daemonId, uuid)) {
    ctx.status = 403;
    ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
    return;
  }

  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  ctx.set("Cache-Control", "no-store");
  ctx.body = await new RemoteRequest(remoteService).request<InstanceMonitoringResponse>(
    "instance/monitoring",
    { instanceUuid: uuid, compact: view === "compact" }
  );
});

export default router;
