import {
  BACKUP_PROTOCOL,
  BackupCancelReq,
  BackupDownloadTicketReq,
  BackupDownloadTicketRes,
  BackupErrorCode,
  BackupRecordsReq,
  BackupRestoreReq,
  BackupRunReq,
  BackupStatusReq,
  BackupTestDestinationReq,
  isValidBackupId,
  sanitizeBackupError
} from "mcsmanager-common";
import RouterContext from "../entity/ctx";
import { BackupError } from "../service/backup/errors";
import { validateDestinationList } from "../service/backup/job_runner";
import { getBackupRunner } from "../service/backup/service";
import { backupDownloadTickets } from "../service/backup/download_tickets";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

function asObject(data: unknown): Record<string, any> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BackupError(BackupErrorCode.INVALID_REQUEST, "Invalid request");
  }
  return data as Record<string, any>;
}

function requireInstance(data: Record<string, any>): string {
  const uuid = data.instanceUuid;
  if (!isValidBackupId(uuid)) {
    throw new BackupError(BackupErrorCode.INVALID_REQUEST, "Invalid instance");
  }
  if (!InstanceSubsystem.exists(uuid)) {
    throw new BackupError(BackupErrorCode.INSTANCE_NOT_FOUND, "Instance not found");
  }
  return uuid;
}

/** Register an event: validates the payload shape, answers with the result or a coded error. */
function handle(event: string, fn: (data: Record<string, any>) => unknown | Promise<unknown>) {
  routerApp.on(event, async (ctx: RouterContext, raw: unknown) => {
    try {
      protocol.response(ctx, await fn(asObject(raw)));
    } catch (err) {
      const e =
        err instanceof BackupError
          ? err
          : new BackupError(BackupErrorCode.INTERNAL, sanitizeBackupError(err));
      protocol.responseError(ctx, e);
    }
  });
}

handle(BACKUP_PROTOCOL.RUN, (data) => {
  const instanceUuid = requireInstance(data);
  return getBackupRunner().enqueueBackup({ ...(data as BackupRunReq), instanceUuid });
});

handle(BACKUP_PROTOCOL.STATUS, (data) => {
  const req = data as BackupStatusReq;
  return getBackupRunner().status(requireInstance(req));
});

handle(BACKUP_PROTOCOL.CANCEL, (data) => {
  const req = data as BackupCancelReq;
  const instanceUuid = requireInstance(req);
  if (!isValidBackupId(req.backupId)) {
    throw new BackupError(BackupErrorCode.INVALID_REQUEST, "Invalid backup id");
  }
  return { cancelled: getBackupRunner().cancel(instanceUuid, req.backupId) };
});

handle(BACKUP_PROTOCOL.RECORDS, (data) => {
  const req = data as BackupRecordsReq;
  return { records: getBackupRunner().records(requireInstance(req)) };
});

handle(BACKUP_PROTOCOL.RESTORE, (data) => {
  const req = data as BackupRestoreReq;
  const instanceUuid = requireInstance(req);
  return getBackupRunner().enqueueRestore({
    instanceUuid,
    recordId: req.recordId,
    destinations: req.destinations ?? []
  });
});

handle(BACKUP_PROTOCOL.DOWNLOAD_TICKET, async (data): Promise<BackupDownloadTicketRes> => {
  const req = data as BackupDownloadTicketReq;
  const instanceUuid = requireInstance(req);
  const destinations = req.destinations ? validateDestinationList(req.destinations) : [];
  const file = await getBackupRunner().resolveLocalCopy(instanceUuid, req.recordId, destinations);
  const { ticket, expiresAt } = backupDownloadTickets.issue(
    instanceUuid,
    file.filePath,
    file.fileName
  );
  return { ticket, fileName: file.fileName, sizeBytes: file.sizeBytes, expiresAt };
});

handle(BACKUP_PROTOCOL.TEST_DESTINATION, (data) => {
  const req = data as BackupTestDestinationReq;
  return getBackupRunner().testDestination(req.destination);
});

handle(BACKUP_PROTOCOL.PENDING_EVENTS, async () => ({
  events: await getBackupRunner().pendingEvents()
}));
