import Router from "@koa/router";
import { FILENAME_BLACKLIST } from "../const";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { getInstanceNameSafely } from "../service/instance_name_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid, isTopPermissionByUuid } from "../service/permission_service";
import { BACKUP_SCHEDULE_ACTION_TYPE } from "mcsmanager-common";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
const router = new Router({ prefix: "/protected_schedule" });

// Schedules containing a `backup` action are managed by administrators only (they are created by
// backup plans and trigger credential-bearing jobs).
function hasBackupAction(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some(
    (a) => a && typeof a === "object" && String((a as any).type) === BACKUP_SCHEDULE_ACTION_TYPE
  );
}

// Routing permission verification middleware
router.use(async (ctx, next) => {
  const instanceUuid = String(ctx.query.uuid);
  const daemonId = String(ctx.query.daemonId);
  const userUuid = getUserUuid(ctx);
  if (isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    await next();
  } else {
    ctx.status = 403;
    ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
  }
});

// [Low-level Permission]
// Get the list of scheduled tasks
router.get(
  "/",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const list = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        "schedule/list",
        {
          instanceUuid
        }
      );
      ctx.body = list;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// create a scheduled task
router.post(
  "/",
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String },
    body: { name: String, count: Number, time: String, actions: Array, type: Number }
  }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const task = ctx.request.body;

      if (hasBackupAction(task.actions) && !isTopPermissionByUuid(getUserUuid(ctx))) {
        ctx.status = 403;
        ctx.body = $t("TXT_CODE_permission.forbidden");
        return;
      }

      // Scheduled task name needs file name format check
      const name = String(task.name);
      FILENAME_BLACKLIST.forEach((ch) => {
        if (name.includes(ch)) throw new Error($t("TXT_CODE_router.schedule.invalidName"));
      });

      operationLogger.log("instance_task_create", {
        ...getOperationLoggerOperator(ctx),
        instance_id: instanceUuid,
        daemon_id: daemonId,
        instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
        task_name: name
      });

      ctx.body = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        "schedule/register",
        {
          instanceUuid,
          name,
          count: Number(task.count),
          time: String(task.time),
          actions: task.actions,
          type: Number(task.type)
        }
      );
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// delete scheduled task
router.delete(
  "/",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const name = String(ctx.query.task_name);

      if (!isTopPermissionByUuid(getUserUuid(ctx))) {
        const existing: any[] = await new RemoteRequest(
          RemoteServiceSubsystem.getInstance(daemonId)
        ).request("schedule/list", { instanceUuid });
        const target = Array.isArray(existing) ? existing.find((t) => t?.name === name) : null;
        if (target && hasBackupAction(target.actions)) {
          ctx.status = 403;
          ctx.body = $t("TXT_CODE_permission.forbidden");
          return;
        }
      }

      operationLogger.log("instance_task_delete", {
        ...getOperationLoggerOperator(ctx),
        instance_id: instanceUuid,
        daemon_id: daemonId,
        instance_name: await getInstanceNameSafely(daemonId, instanceUuid),
        task_name: name
      });

      ctx.body = await new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId)).request(
        "schedule/delete",
        {
          instanceUuid,
          name
        }
      );
    } catch (err) {
      ctx.body = err;
    }
  }
);

export default router;
