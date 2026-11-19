import crypto from "crypto";
import {
  BACKUP_PROTOCOL,
  BackupErrorCode,
  BackupFinishedPayload,
  BackupRecord,
  BackupTriggerPayload,
  isValidBackupId
} from "mcsmanager-common";
import { broadcast, hasAuthenticatedPanel } from "../authenticated_sockets";
import logger from "../log";
import { BackupIndexStore } from "./index_store";
import { backupIndexStore } from "./stores";

export interface ScheduleHookDeps {
  store: BackupIndexStore;
  hasPanel: () => boolean;
  broadcast: (event: string, payload: unknown) => void;
  now: () => number;
}

const defaultDeps = (): ScheduleHookDeps => ({
  store: backupIndexStore,
  hasPanel: hasAuthenticatedPanel,
  broadcast,
  now: Date.now
});

/** Payload of a `backup` schedule action must be a plan id of the allowed format. */
export function isValidBackupActionPayload(payload: unknown): payload is string {
  return isValidBackupId(payload);
}

/**
 * Schedule action `backup`: ask the connected panel to run the plan (it owns the plan and the
 * credentials). Never waits for the job. With no panel connected the failure is recorded in the
 * index and kept as a pending event for the next panel connection.
 */
export function triggerScheduledBackup(
  instanceUuid: string,
  planId: string,
  deps: ScheduleHookDeps = defaultDeps(),
  instanceName?: string
): "triggered" | "panel_unreachable" {
  if (deps.hasPanel()) {
    const payload: BackupTriggerPayload = { instanceUuid, planId };
    deps.broadcast(BACKUP_PROTOCOL.TRIGGER, payload);
    return "triggered";
  }
  const now = deps.now();
  const record: BackupRecord = {
    id: crypto.randomUUID(),
    planId,
    createdAt: now,
    sizeBytes: 0,
    sha256: "",
    trigger: "schedule",
    warnings: [],
    copies: {}
  };
  const event: BackupFinishedPayload = {
    instanceUuid,
    planId,
    record,
    errorSummary: "The panel was not connected when the scheduled backup fired",
    errorCode: BackupErrorCode.PANEL_UNREACHABLE,
    durationMs: 0,
    instanceName
  };
  void (async () => {
    try {
      await deps.store.add(instanceUuid, record);
      await deps.store.addPendingEvent(event);
    } catch (err) {
      logger.warn(`Scheduled backup: could not record panel_unreachable: ${String(err)}`);
    }
  })();
  return "panel_unreachable";
}
