import Router from "@koa/router";
import Koa from "koa";
import { InstanceGroupRun, RunAction } from "../entity/instance_group";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import instanceGroupService, {
  InstanceGroupError,
  InstanceGroupInput,
  InstanceGroupView,
  MemberStatus,
  MemberStatusResolver,
  buildGroupViews
} from "../service/instance_group_service";
import instanceGroupRunner from "../service/instance_group_runner";
import { logger } from "../service/log";
import { getOperationLoggerOperator } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";

const router = new Router({ prefix: "/instance_group" });

const STATUS_REQUEST_TIMEOUT_MS = 3000;
const MAX_NICKNAME_LENGTH = 200;

// Ask one daemon for the status of the given (already authorised) instances.
// Any failure (daemon offline, older daemon without the event) makes the caller
// fall back to "unknown".
const resolveMemberStatuses: MemberStatusResolver = async (daemonId, instanceUuids) => {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  const result = await new RemoteRequest(remoteService).request(
    "instance/status_batch",
    { instanceUuids },
    STATUS_REQUEST_TIMEOUT_MS
  );
  const asked = new Set(instanceUuids);
  const map = new Map<string, MemberStatus>();
  const list: unknown = result?.instances;
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (!item || typeof item.instanceUuid !== "string" || !asked.has(item.instanceUuid)) continue;
    map.set(item.instanceUuid, {
      nickname:
        typeof item.nickname === "string" ? item.nickname.slice(0, MAX_NICKNAME_LENGTH) : undefined,
      status: typeof item.status === "number" ? item.status : "unknown"
    });
  }
  return map;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only the known group fields are forwarded; everything else in the body is dropped.
function pickInput(body: unknown): InstanceGroupInput {
  if (!isPlainObject(body))
    throw new InstanceGroupError(400, $t("TXT_CODE_instance_group.invalidBody"));
  const input: InstanceGroupInput = {};
  for (const key of ["name", "members", "stopOrder", "advance"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) input[key] = body[key];
  }
  return input;
}

// Wrap a handler: resolve the caller, translate service errors into HTTP statuses.
function handler(fn: (ctx: Koa.ParameterizedContext, userUuid: string) => Promise<void>) {
  return async (ctx: Koa.ParameterizedContext) => {
    try {
      const userUuid = getUserUuid(ctx);
      if (!userUuid) {
        ctx.status = 403;
        ctx.body = $t("TXT_CODE_permission.forbidden");
        return;
      }
      await fn(ctx, userUuid);
    } catch (err) {
      if (err instanceof InstanceGroupError) {
        ctx.status = err.status;
        ctx.body = err.message;
        return;
      }
      logger.error("Instance group request failed:", err);
      ctx.status = 500;
      ctx.body = $t("TXT_CODE_instance_group.internalError");
    }
  };
}

type GroupResponse = InstanceGroupView & { run: InstanceGroupRun | null };

// Group views plus the active or most recent (retained) run, so the page can
// resume progress display after a reload.
async function viewOf(
  userUuid: string,
  groups: Parameters<typeof buildGroupViews>[2]
): Promise<GroupResponse[]> {
  const views = await buildGroupViews(
    instanceGroupService,
    userUuid,
    groups,
    resolveMemberStatuses
  );
  return views.map((view) => ({ ...view, run: instanceGroupRunner.getRun(userUuid, view.uuid) }));
}

// [Low-level Permission]
// List the caller's own groups, with member name and status resolved at read time
router.get(
  "/list",
  permission({ level: ROLE.USER }),
  handler(async (ctx, userUuid) => {
    ctx.body = await viewOf(userUuid, instanceGroupService.listByOwner(userUuid));
  })
);

// Create a group. Every member is validated against the caller's assignments.
router.post(
  "/create",
  permission({ level: ROLE.USER }),
  handler(async (ctx, userUuid) => {
    const group = await instanceGroupService.create(userUuid, pickInput(ctx.request.body));
    const [view] = await viewOf(userUuid, [group]);
    ctx.body = view;
  })
);

// Update fields of one of the caller's groups
router.put(
  "/update",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  handler(async (ctx, userUuid) => {
    const group = await instanceGroupService.update(
      userUuid,
      String(ctx.query.id),
      pickInput(ctx.request.body)
    );
    const [view] = await viewOf(userUuid, [group]);
    ctx.body = view;
  })
);

// Delete one of the caller's groups
router.delete(
  "/delete",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  handler(async (ctx, userUuid) => {
    await instanceGroupService.remove(userUuid, String(ctx.query.id));
    ctx.body = true;
  })
);

// Begin an ordered start or stop of one of the caller's groups. The request
// body is ignored on purpose: the members are always taken from the stored group.
function runRoute(action: RunAction) {
  return handler(async (ctx, userUuid) => {
    const group = instanceGroupService.get(userUuid, String(ctx.query.id));
    const operator = getOperationLoggerOperator(ctx);
    const run = instanceGroupRunner.start(group, action, {
      ip: operator.operator_ip,
      name: operator.operator_name,
      source: operator.operator_source
    });
    ctx.body = { runId: run.runId };
  });
}

router.post(
  "/start",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  runRoute("start")
);

router.post(
  "/stop",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  runRoute("stop")
);

// Cancel the active run; responds with the final run state
router.post(
  "/cancel",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  handler(async (ctx, userUuid) => {
    const group = instanceGroupService.get(userUuid, String(ctx.query.id));
    ctx.body = { run: await instanceGroupRunner.cancel(userUuid, group.uuid) };
  })
);

// State of the active or most recent run ({ run: null } when there is none)
router.get(
  "/run",
  permission({ level: ROLE.USER }),
  validator({ query: { id: String } }),
  handler(async (ctx, userUuid) => {
    const group = instanceGroupService.get(userUuid, String(ctx.query.id));
    ctx.body = { run: instanceGroupRunner.getRun(userUuid, group.uuid) };
  })
);

export default router;
