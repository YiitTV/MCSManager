import Router from "@koa/router";
import type Koa from "koa";
import { parseMaintenanceOperation, parsePlayerOperation } from "mcsmanager-common";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import { logger } from "../service/log";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { getUserFromCtx } from "../service/passport_service";
import { isHaveInstance } from "../service/permission_service";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";

const router = new Router({ prefix: "/minecraft" });
const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const COMMAND_TIMEOUT_MS = 18_000;

function route(
  event: string,
  level: ROLE,
  parse?: typeof parsePlayerOperation | typeof parseMaintenanceOperation
) {
  return async (ctx: Koa.ParameterizedContext) => {
    const { daemonId, uuid } = ctx.query;
    if (
      typeof daemonId !== "string" ||
      typeof uuid !== "string" ||
      !identifier.test(daemonId) ||
      !identifier.test(uuid)
    ) {
      ctx.status = 400;
      ctx.body = $t("TXT_CODE_minecraft_ops.invalidInput");
      return;
    }

    const user = getUserFromCtx(ctx);
    if (!user || user.permission < level || !isHaveInstance(user, daemonId, uuid)) {
      ctx.status = 403;
      ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
      return;
    }
    const operation = parse?.(ctx.request.body);
    if (parse && !operation) {
      ctx.status = 400;
      ctx.body = $t("TXT_CODE_minecraft_ops.invalidInput");
      return;
    }

    try {
      const request = new RemoteRequest(RemoteServiceSubsystem.getInstance(daemonId));
      if (operation) {
        const action =
          operation.action === "toggle"
            ? operation.enabled
              ? "enable"
              : "disable"
            : operation.action;
        operationLogger.log(
          "instance_minecraft_action",
          {
            daemon_id: daemonId,
            instance_id: uuid,
            action,
            player: "player" in operation ? operation.player : undefined,
            ...getOperationLoggerOperator(ctx)
          },
          "info",
          true
        );
      }
      ctx.body = await request.request(
        `minecraft/${event}`,
        { instanceUuid: uuid, operation },
        event === "player_action" ? COMMAND_TIMEOUT_MS : undefined
      );
    } catch (error) {
      logger.warn(`Minecraft operation ${event} failed for ${daemonId}/${uuid}`, error);
      ctx.status = 502;
      ctx.body = $t("TXT_CODE_minecraft_ops.unavailable");
    }
  };
}

router.get("/players", permission({ level: ROLE.USER }), route("players", ROLE.USER));
router.post(
  "/player_action",
  permission({ level: ROLE.USER }),
  route("player_action", ROLE.USER, parsePlayerOperation)
);
router.get("/maintenance", permission({ level: ROLE.ADMIN }), route("maintenance", ROLE.ADMIN));
router.post(
  "/maintenance",
  permission({ level: ROLE.ADMIN }),
  route("maintenance_action", ROLE.ADMIN, parseMaintenanceOperation)
);

export default router;
