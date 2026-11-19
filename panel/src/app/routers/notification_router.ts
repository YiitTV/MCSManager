import Router from "@koa/router";
import Koa from "koa";
import {
  applyConfigUpdate,
  generateSecret,
  MaskedNotificationConfig,
  maskConfig,
  NotificationConfigError
} from "../entity/notification_config";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import { speedLimit } from "../middleware/limit";
import permission from "../middleware/permission";
import { logger } from "../service/log";
import {
  getNotificationConfig,
  saveNotificationConfig
} from "../service/notification_config_service";
import notificationService, { NotificationStatus } from "../service/notification_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { OutboundUrlError, resolveOutboundTarget } from "../utils/outbound_url";

const router = new Router({ prefix: "/notification" });

function fail(ctx: Koa.ParameterizedContext, status: number, message: string) {
  ctx.status = status;
  ctx.body = message;
}

function describeError(err: unknown): string | null {
  if (err instanceof OutboundUrlError) return $t(`TXT_CODE_notification.err_${err.code}`);
  if (err instanceof NotificationConfigError) {
    return $t(`TXT_CODE_notification.err_${err.code}`, { field: err.field ?? "" });
  }
  return null;
}

function view(): MaskedNotificationConfig & { status: NotificationStatus } {
  return { ...maskConfig(getNotificationConfig()), status: notificationService.getStatus() };
}

// Operation log entry without any value: only the names of the changed fields.
function logChange(ctx: Koa.ParameterizedContext, fields: string[]) {
  try {
    operationLogger.log(
      "system_config_change",
      {
        ...getOperationLoggerOperator(ctx),
        config_before: { notification: "-" },
        config_after: { notification: fields.join(",") }
      },
      "warning"
    );
  } catch (err: any) {
    logger.warn(`Notification operation log failed: ${err?.name ?? "error"}`);
  }
}

// [Top-level Permission]
router.get("/config", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = view();
});

// [Top-level Permission]
// Partial update. Masked placeholders keep stored values; `secret` is only changed by rotation.
router.put("/config", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const current = getNotificationConfig();
  let result;
  try {
    result = applyConfigUpdate(current, ctx.request.body);
    const next = result.config;
    const needsResolve =
      next.url &&
      (result.changed.includes("url") ||
        result.changed.includes("sinkType") ||
        result.changed.includes("allowPrivateAddress"));
    if (needsResolve) {
      await resolveOutboundTarget(next.url, {
        sinkType: next.sinkType,
        allowPrivate: next.sinkType === "bot_http" && next.allowPrivateAddress
      });
    }
  } catch (err) {
    const message = describeError(err);
    if (message) return fail(ctx, 400, message);
    throw err;
  }
  await saveNotificationConfig(result.config);
  if (result.changed.length > 0) logChange(ctx, result.changed);
  ctx.body = view();
});

// [Top-level Permission]
// Generates (or rotates) the bot_http HMAC secret. The plaintext is returned only here.
router.post("/secret/rotate", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const next = { ...getNotificationConfig(), secret: generateSecret() };
  await saveNotificationConfig(next);
  logChange(ctx, ["secret"]);
  ctx.body = { secret: next.secret };
});

// [Top-level Permission]
// One attempt, no retry. Rate limited (service-level too, because speedLimit exempts admins).
router.post("/test", permission({ level: ROLE.ADMIN }), speedLimit(5), async (ctx) => {
  ctx.body = await notificationService.sendTest();
});

export default router;
