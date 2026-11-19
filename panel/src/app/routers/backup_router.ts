import Router from "@koa/router";
import Koa from "koa";
import {
  BACKUP_DOWNLOAD_TICKET_TTL_MS,
  BackupErrorCode,
  isValidBackupId,
  redactRecordForUser,
  removeTrail
} from "mcsmanager-common";
import { ROLE } from "../entity/user";
import { DataPlaneMode } from "../entity/setting";
import { $t } from "../i18n";
import { speedLimit } from "../middleware/limit";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import {
  BackupServiceError,
  cancelJob,
  createDestination,
  createPlan,
  deleteDestination,
  deletePlan,
  describePlans,
  getJobs,
  getPlan,
  getRecords,
  listPlansForInstance,
  listPublicDestinations,
  releaseRunSlot,
  requestDownloadTicket,
  reserveRunSlot,
  restoreRecord,
  runPlan,
  testDestination,
  updateDestination,
  updatePlan
} from "../service/backup_service";
import { completeGDriveConnect, createGDriveConnectUrl } from "../service/backup_oauth";
import * as GatewayToken from "../service/gateway_token";
import { logger } from "../service/log";
import { getInstanceNameSafely } from "../service/instance_name_service";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { getUserFromCtx, getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid, isTopPermissionByUuid } from "../service/permission_service";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import { browserFacingAddr } from "../service/proxy_addr";
import { systemConfig } from "../setting";
import { timeUuid } from "../service/password";

// Backup HTTP API (design "Panel HTTP API"). Destinations, plans, restore and cancel are
// administrator-only; run / records / download / jobs / plan listing are open to administrators
// and users assigned to the instance. Secrets are never returned (masked).

const router = new Router({ prefix: "/backup" });

function errorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof BackupServiceError) {
    return {
      status: err.status,
      message: $t(`TXT_CODE_backup.error.${err.code}`, err.params as any)
    };
  }
  logger.error("[Backup] unexpected error:", (err as Error)?.message);
  return { status: 500, message: $t("TXT_CODE_backup.error.INTERNAL") };
}

async function respond(ctx: Koa.ParameterizedContext, fn: () => Promise<unknown>) {
  try {
    ctx.body = await fn();
  } catch (err) {
    const { status, message } = errorMessage(err);
    ctx.status = status;
    ctx.body = message;
  }
}

function bad(code: string): never {
  throw new BackupServiceError("VALIDATION", 400, { field: code, code: "INVALID_ID" });
}

/** daemonId + instance uuid from query or body, validated as safe ids. */
function instanceRef(src: Record<string, any> | undefined) {
  const daemonId = String(src?.daemonId ?? "");
  const uuid = String(src?.uuid ?? "");
  if (!isValidBackupId(daemonId)) bad("daemonId");
  if (!isValidBackupId(uuid)) bad("uuid");
  return { daemonId, uuid };
}

function requireAssigned(ctx: Koa.ParameterizedContext, daemonId: string, uuid: string) {
  if (!isHaveInstanceByUuid(getUserUuid(ctx), daemonId, uuid))
    throw new BackupServiceError("FORBIDDEN_INSTANCE", 403);
}

function isAdminCtx(ctx: Koa.ParameterizedContext) {
  return isTopPermissionByUuid(getUserUuid(ctx));
}

function body(ctx: Koa.ParameterizedContext): Record<string, any> {
  const b = (ctx.request as any).body;
  return b && typeof b === "object" ? b : {};
}

function logInstance(
  ctx: Koa.ParameterizedContext,
  action: "run" | "cancel" | "restore" | "download",
  daemonId: string,
  uuid: string,
  extra: { plan_name?: string; backup_id?: string } = {}
) {
  getInstanceNameSafely(daemonId, uuid)
    .then((instance_name) =>
      operationLogger.log("instance_backup", {
        ...getOperationLoggerOperator(ctx),
        instance_id: uuid,
        daemon_id: daemonId,
        instance_name,
        action,
        ...extra
      })
    )
    .catch(() => {});
}

function logConfig(
  ctx: Koa.ParameterizedContext,
  target: "destination" | "plan" | "gdrive_connect",
  action: "create" | "update" | "delete" | "test" | "connect",
  targetName?: string
) {
  operationLogger.log("backup_config_change", {
    ...getOperationLoggerOperator(ctx),
    target,
    action,
    target_name: targetName
  });
}

// ---------------------------------------------------------------------------
// Destinations (admin)
// ---------------------------------------------------------------------------

router.get("/destinations", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, () => listPublicDestinations());
});

router.post("/destinations", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const dest = await createDestination(body(ctx));
    logConfig(ctx, "destination", "create", dest.name);
    return dest;
  });
});

router.put("/destinations", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const dest = await updateDestination(body(ctx));
    logConfig(ctx, "destination", "update", dest.name);
    return dest;
  });
});

router.delete("/destinations", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const id = body(ctx).id ?? ctx.query.id;
    await deleteDestination(typeof id === "string" ? id : undefined);
    logConfig(ctx, "destination", "delete", String(id));
    return true;
  });
});

router.post("/destinations/test", permission({ level: ROLE.ADMIN }), speedLimit(1), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    let daemonId = typeof b.daemonId === "string" ? b.daemonId : "";
    if (!daemonId) {
      for (const [id, svc] of RemoteServiceSubsystem.services) {
        if (svc.available) {
          daemonId = id;
          break;
        }
      }
    }
    if (!isValidBackupId(daemonId)) throw new BackupServiceError("DAEMON_NOT_FOUND", 404);
    const result = await testDestination(daemonId, b.destination);
    logConfig(ctx, "destination", "test", String(b.destination?.name ?? ""));
    return result;
  });
});

// ---------------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------------

router.get("/gdrive/connect", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const destinationId = String(ctx.query.destinationId ?? "");
    if (!isValidBackupId(destinationId)) bad("destinationId");
    const url = await createGDriveConnectUrl(destinationId, getUserUuid(ctx));
    logConfig(ctx, "gdrive_connect", "connect");
    return { url };
  });
});

function settingsRedirect(params: Record<string, string>) {
  const prefix = removeTrail(systemConfig?.prefix || "", "/");
  const q = new URLSearchParams(params);
  return `${prefix}/#/settings?${q.toString()}`;
}

// Called by the browser after Google's consent screen: a normal navigation (no API token, no
// XMLHttpRequest header), authenticated by the administrator session cookie and the `state`.
router.get("/gdrive/callback", permission({ level: ROLE.ADMIN, token: false }), async (ctx) => {
  const state = ctx.query.state;
  try {
    if (typeof ctx.query.error === "string") {
      // The user denied access or Google reported an error: burn the state, show a short code
      try {
        const { consumeState } = await import("../service/backup_oauth");
        consumeState(state, getUserUuid(ctx));
      } catch {
        /* ignored */
      }
      return ctx.redirect(settingsRedirect({ backupGdrive: "error", reason: "OAUTH_DENIED" }));
    }
    const { destinationId } = await completeGDriveConnect(ctx.query.code, state, getUserUuid(ctx));
    logConfig(ctx, "gdrive_connect", "connect");
    return ctx.redirect(settingsRedirect({ backupGdrive: "connected", destinationId }));
  } catch (err) {
    const reason = err instanceof BackupServiceError ? err.code : "INTERNAL";
    if (!(err instanceof BackupServiceError)) logger.error("[Backup] OAuth callback error");
    return ctx.redirect(settingsRedirect({ backupGdrive: "error", reason }));
  }
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

router.get(
  "/plans",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    await respond(ctx, async () => {
      const { daemonId, uuid } = instanceRef(ctx.query);
      requireAssigned(ctx, daemonId, uuid);
      return describePlans(await listPlansForInstance(daemonId, uuid));
    });
  }
);

router.post("/plans", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const plan = await createPlan(body(ctx));
    logConfig(ctx, "plan", "create", plan.name);
    return plan;
  });
});

router.put("/plans", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const plan = await updatePlan(body(ctx));
    logConfig(ctx, "plan", "update", plan.name);
    return plan;
  });
});

router.delete("/plans", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    const id = b.planId ?? b.id ?? ctx.query.id ?? ctx.query.planId;
    const plan = await deletePlan(typeof id === "string" ? id : undefined);
    logConfig(ctx, "plan", "delete", plan.name);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Run / records / jobs / download (admin or assigned)
// ---------------------------------------------------------------------------

router.post("/run", permission({ level: ROLE.USER }), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    const { daemonId, uuid } = instanceRef(b);
    requireAssigned(ctx, daemonId, uuid);
    const planId = String(b.planId ?? "");
    if (!isValidBackupId(planId)) bad("planId");
    const plan = await getPlan(planId);
    if (!plan || plan.daemonId !== daemonId || plan.instanceUuid !== uuid)
      throw new BackupServiceError("PLAN_NOT_FOUND", 404);
    if (!plan.enabled) throw new BackupServiceError(BackupErrorCode.PLAN_INVALID, 409);

    const userUuid = getUserUuid(ctx);
    const limited = !isAdminCtx(ctx);
    if (limited && !reserveRunSlot(userUuid, plan.id))
      throw new BackupServiceError(BackupErrorCode.RATE_LIMITED, 429);
    try {
      const instanceName = await getInstanceNameSafely(daemonId, uuid);
      const res = await runPlan(plan, "manual", getUserFromCtx(ctx)?.userName, instanceName);
      logInstance(ctx, "run", daemonId, uuid, { plan_name: plan.name, backup_id: res?.backupId });
      return { backupId: res.backupId };
    } catch (err) {
      if (limited) releaseRunSlot(userUuid, plan.id);
      throw err;
    }
  });
});

router.get(
  "/records",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    await respond(ctx, async () => {
      const { daemonId, uuid } = instanceRef(ctx.query);
      requireAssigned(ctx, daemonId, uuid);
      const records = await getRecords(daemonId, uuid);
      return isAdminCtx(ctx) ? records : records.map(redactRecordForUser);
    });
  }
);

router.get(
  "/jobs",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    await respond(ctx, async () => {
      const { daemonId, uuid } = instanceRef(ctx.query);
      requireAssigned(ctx, daemonId, uuid);
      return getJobs(daemonId, uuid);
    });
  }
);

router.post("/cancel", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    const { daemonId, uuid } = instanceRef(b);
    const res = await cancelJob(daemonId, uuid, String(b.backupId ?? ""));
    logInstance(ctx, "cancel", daemonId, uuid, { backup_id: String(b.backupId) });
    return res;
  });
});

router.post("/restore", permission({ level: ROLE.ADMIN }), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    const { daemonId, uuid } = instanceRef(b);
    const res = await restoreRecord(daemonId, uuid, String(b.recordId ?? ""));
    logInstance(ctx, "restore", daemonId, uuid, { backup_id: String(b.recordId) });
    return res;
  });
});

// Single-use short-lived ticket from the daemon, delivered through the same data-plane mechanism
// as file downloads (proxy token or daemon passport). Response mirrors `/api/files/download`.
router.post("/download", permission({ level: ROLE.USER }), speedLimit(3), async (ctx) => {
  await respond(ctx, async () => {
    const b = body(ctx);
    const { daemonId, uuid } = instanceRef(b);
    requireAssigned(ctx, daemonId, uuid);
    const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remoteService) throw new BackupServiceError("DAEMON_NOT_FOUND", 404);
    const ticket = await requestDownloadTicket(daemonId, uuid, String(b.recordId ?? ""));
    logInstance(ctx, "download", daemonId, uuid, { backup_id: String(b.recordId) });
    const ttlSec = Math.floor(BACKUP_DOWNLOAD_TICKET_TTL_MS / 1000);
    const meta = {
      fileName: ticket.fileName,
      sizeBytes: ticket.sizeBytes,
      expiresAt: ticket.expiresAt
    };
    if (systemConfig?.dataPlane === DataPlaneMode.Proxy) {
      const token = GatewayToken.issueProxyToken({
        daemonId,
        instanceUuid: uuid,
        op: "download",
        target: ticket.ticket,
        ttlSec
      });
      return { password: token, addr: browserFacingAddr(ctx), remoteMappings: [], ...meta };
    }
    const password = timeUuid();
    await new RemoteRequest(remoteService).request("passport/register", {
      name: "download",
      password,
      parameter: { fileName: ticket.ticket, instanceUuid: uuid }
    });
    return {
      password,
      addr: remoteService.config.fullAddr,
      remoteMappings: remoteService.config.getConvertedRemoteMappings(),
      ...meta
    };
  });
});

export default router;
