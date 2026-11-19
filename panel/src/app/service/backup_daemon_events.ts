import {
  BACKUP_EVENT_NAMES,
  BACKUP_LIMITS,
  BACKUP_PROTOCOL,
  BackupEventPayload,
  BackupFinishedPayload,
  BackupPendingEventsRes,
  BackupTriggerPayload,
  isValidBackupId,
  sanitizeBackupError
} from "mcsmanager-common";
import type { Socket } from "socket.io-client";
import RemoteService from "../entity/remote_service";
import { backupEvents } from "./backup_events";
import { BackupServiceError, getPlan, runPlan } from "./backup_service";
import { getInstanceNameSafely } from "./instance_name_service";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

// Daemon -> panel pushes of the backup protocol:
//   backup/trigger  scheduled firing: answer with a credential-bearing backup/run to THAT daemon
//   backup/finished job result: publish exactly one BackupEventPayload on `backupEvents`
//   backup/pending_events handshake after (re)connect: replay results produced while we were away
// Listeners are attached once per socket (a reconnect creates a new socket object).

const attachedSockets = new WeakSet<object>();
const recentFinished: string[] = [];
const recentFinishedSet = new Set<string>();
const RECENT_LIMIT = 1000;

/** Remember a job id; returns false if it was already published (exactly-once guard). */
function markPublished(key: string): boolean {
  if (recentFinishedSet.has(key)) return false;
  recentFinishedSet.add(key);
  recentFinished.push(key);
  while (recentFinished.length > RECENT_LIMIT) {
    const old = recentFinished.shift();
    if (old) recentFinishedSet.delete(old);
  }
  return true;
}

export function resetBackupDaemonEventsForTest() {
  recentFinished.length = 0;
  recentFinishedSet.clear();
}

function unwrap<T>(packet: any): T | null {
  // Daemon pushes are IPacket {uuid, status, event, data}
  if (packet && typeof packet === "object" && "data" in packet) return packet.data as T;
  return null;
}

function clip(text: unknown, max = BACKUP_LIMITS.MAX_ERROR_LENGTH) {
  return sanitizeBackupError(text).slice(0, max);
}

/** Build the notification payload from a daemon result. Pure apart from plan/name lookups. */
export async function buildEventPayload(
  daemonId: string,
  finished: BackupFinishedPayload
): Promise<BackupEventPayload | null> {
  const rec = finished?.record;
  if (
    !finished ||
    !isValidBackupId(finished.instanceUuid) ||
    !isValidBackupId(finished.planId) ||
    !rec ||
    !isValidBackupId(rec.id) ||
    typeof rec.copies !== "object" ||
    rec.copies === null
  ) {
    return null;
  }
  const plan = await getPlan(finished.planId);
  const instanceName =
    (typeof finished.instanceName === "string" && finished.instanceName.slice(0, 100)) ||
    (await getInstanceNameSafely(daemonId, finished.instanceUuid)) ||
    finished.instanceUuid;

  const destinations = Object.entries(rec.copies)
    .filter(([id]) => isValidBackupId(id))
    .map(([id, copy]) => ({
      id,
      name: String(copy?.name ?? id).slice(0, BACKUP_LIMITS.MAX_NAME_LENGTH),
      type: copy?.type,
      status: copy?.status === "ok" ? ("ok" as const) : ("failed" as const),
      ...(copy?.error ? { error: clip(copy.error) } : {})
    }));
  const succeeded = destinations.some((d) => d.status === "ok");
  const event: BackupEventPayload = {
    event: succeeded ? BACKUP_EVENT_NAMES.SUCCEEDED : BACKUP_EVENT_NAMES.FAILED,
    occurredAt: Date.now(),
    instance: { daemonId, uuid: finished.instanceUuid, name: String(instanceName) },
    plan: { id: finished.planId, name: plan?.name ?? finished.planId },
    backupId: rec.id,
    trigger: rec.trigger === "schedule" ? "schedule" : "manual",
    durationMs: Number.isFinite(finished.durationMs) ? Math.max(0, finished.durationMs) : 0,
    destinations,
    warnings: (Array.isArray(rec.warnings) ? rec.warnings : [])
      .slice(0, BACKUP_LIMITS.MAX_WARNINGS)
      .map((w) => clip(w))
  };
  if (typeof finished.initiatedBy === "string" && finished.initiatedBy)
    event.initiatedBy = finished.initiatedBy.slice(0, 100);
  if (succeeded) event.sizeBytes = Number.isFinite(rec.sizeBytes) ? rec.sizeBytes : undefined;
  else {
    event.errorSummary = clip(
      finished.errorSummary ||
        destinations.find((d) => d.error)?.error ||
        finished.errorCode ||
        "BACKUP_FAILED"
    );
  }
  return event;
}

/** Handle one finished result (live push or pending replay). */
export async function handleFinished(daemonId: string, finished: BackupFinishedPayload) {
  try {
    const payload = await buildEventPayload(daemonId, finished);
    if (!payload) {
      logger.warn(`[Backup] ignored malformed backup/finished from daemon ${daemonId}`);
      return;
    }
    if (!markPublished(`${daemonId}:${payload.backupId}`)) return;
    backupEvents.publish(payload);
  } catch (err) {
    logger.warn(`[Backup] backup/finished handling failed: ${clip((err as Error)?.message)}`);
  }
}

/** Handle a scheduled firing: validate, then send credentials to that daemon only. */
export async function handleTrigger(svc: { uuid: string }, trigger: BackupTriggerPayload) {
  const daemonId = svc.uuid;
  try {
    if (!trigger || !isValidBackupId(trigger.instanceUuid) || !isValidBackupId(trigger.planId)) {
      logger.warn(`[Backup] ignored malformed backup/trigger from daemon ${daemonId}`);
      return;
    }
    const plan = await getPlan(trigger.planId);
    if (
      !plan ||
      !plan.enabled ||
      plan.daemonId !== daemonId ||
      plan.instanceUuid !== trigger.instanceUuid
    ) {
      logger.warn(`[Backup] backup/trigger for unknown or foreign plan ${trigger.planId} ignored`);
      return;
    }
    const instanceName = await getInstanceNameSafely(daemonId, plan.instanceUuid);
    await runPlan(plan, "schedule", undefined, instanceName);
  } catch (err) {
    const code = err instanceof BackupServiceError ? err.code : clip((err as Error)?.message);
    logger.warn(`[Backup] scheduled backup could not be started: ${code}`);
    // No job exists on the daemon, so no backup/finished will follow: report the failure once.
    if (trigger && isValidBackupId(trigger.planId) && isValidBackupId(trigger.instanceUuid)) {
      const plan = await getPlan(trigger.planId).catch(() => null);
      if (plan && plan.daemonId === daemonId) {
        backupEvents.publish({
          event: BACKUP_EVENT_NAMES.FAILED,
          occurredAt: Date.now(),
          instance: {
            daemonId,
            uuid: plan.instanceUuid,
            name: (await getInstanceNameSafely(daemonId, plan.instanceUuid)) || plan.instanceUuid
          },
          plan: { id: plan.id, name: plan.name },
          backupId: `not_started_${Date.now()}`,
          trigger: "schedule",
          durationMs: 0,
          destinations: [],
          warnings: [],
          errorSummary: code
        });
      }
    }
  }
}

/** Replay results the daemon queued while no panel was connected. */
export async function requestPendingEvents(svc: RemoteService) {
  try {
    const res = await new RemoteRequest(svc).request<BackupPendingEventsRes>(
      BACKUP_PROTOCOL.PENDING_EVENTS,
      {}
    );
    const events = Array.isArray(res?.events) ? res.events : [];
    for (const e of events) await handleFinished(svc.uuid, e);
  } catch (err) {
    // Older daemons have no such handler: not an error
    logger.debug?.(`[Backup] pending events handshake skipped for ${svc.uuid}`);
  }
}

/** Attach the push listeners to a freshly created socket (idempotent per socket). */
export function attachBackupListeners(svc: RemoteService, socket: Socket) {
  if (attachedSockets.has(socket)) return;
  attachedSockets.add(socket);
  socket.on(BACKUP_PROTOCOL.TRIGGER, (packet: unknown) => {
    // Credentials are only ever sent to an authenticated daemon
    if (!svc.available) return;
    const data = unwrap<BackupTriggerPayload>(packet);
    if (data) void handleTrigger(svc, data);
  });
  socket.on(BACKUP_PROTOCOL.FINISHED, (packet: unknown) => {
    if (!svc.available) return;
    const data = unwrap<BackupFinishedPayload>(packet);
    if (data) void handleFinished(svc.uuid, data);
  });
}

RemoteService.socketHooks.push(attachBackupListeners);
RemoteService.authHooks.push((svc) => void requestPendingEvents(svc));

// Services created before this module loaded (defensive; imports normally run first)
for (const svc of RemoteServiceSubsystem.services.values()) {
  if (svc.socket) attachBackupListeners(svc, svc.socket);
}
