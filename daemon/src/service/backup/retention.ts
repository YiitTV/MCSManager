import {
  BackupCopyResult,
  BackupDriverCallOptions,
  BackupRecord,
  DestinationDriver,
  sanitizeBackupError
} from "mcsmanager-common";
import { BackupIndexStore } from "./index_store";
import { removeRecordedLocalCopy } from "./destinations/local";

export interface RetentionDeletion {
  recordId: string;
  destinationId: string;
  remoteId: string;
}

/**
 * Design D10, pure part. For every destination the current job uploaded to successfully: keep the
 * newest `retention` `ok` copies of this plan (the new record always first) and select the rest,
 * by recorded remote id only. Destinations whose current upload failed are never pruned.
 */
export function selectRetentionDeletions(
  records: BackupRecord[],
  plan: { id: string; retention: number; destinationIds: readonly string[] },
  newRecord: BackupRecord
): RetentionDeletion[] {
  const out: RetentionDeletion[] = [];
  for (const destinationId of plan.destinationIds) {
    if (newRecord.copies[destinationId]?.status !== "ok") continue;
    const ok = records
      .filter((r) => r.planId === plan.id && r.copies[destinationId]?.status === "ok")
      .sort((a, b) => {
        if (a.id === newRecord.id) return -1;
        if (b.id === newRecord.id) return 1;
        return b.createdAt - a.createdAt;
      });
    for (const r of ok.slice(Math.max(plan.retention, 1))) {
      if (r.id === newRecord.id) continue;
      const remoteId = r.copies[destinationId].remoteId;
      if (!remoteId) continue;
      out.push({ recordId: r.id, destinationId, remoteId });
    }
  }
  return out;
}

export interface ApplyRetentionOptions {
  store: BackupIndexStore;
  instanceUuid: string;
  plan: { id: string; retention: number; destinationIds: readonly string[] };
  newRecord: BackupRecord;
  getDriver: (destinationId: string) => DestinationDriver | undefined;
  secretValues?: readonly string[];
  call?: BackupDriverCallOptions;
}

/**
 * Apply retention against the index. Deleted copies are marked `deleted`; a failed deletion keeps
 * the copy `ok` (retried at the next job) and yields a warning. Records whose copies are all
 * deleted are dropped. Returns warnings to attach to the new record.
 */
export async function applyRetention(opts: ApplyRetentionOptions): Promise<string[]> {
  const { store, instanceUuid, plan, newRecord } = opts;
  const warnings: string[] = [];
  const records = store.list(instanceUuid);
  const byId = new Map(records.map((record) => [record.id, record]));
  const deletions = selectRetentionDeletions(records, plan, newRecord);
  const deleted: RetentionDeletion[] = [];
  for (const d of deletions) {
    if (opts.call?.signal?.aborted) break;
    const driver = opts.getDriver(d.destinationId);
    if (!driver) continue;
    try {
      const copy = byId.get(d.recordId)?.copies[d.destinationId];
      if (copy?.type === "local" && copy.localDirectory) {
        await removeRecordedLocalCopy(copy.localDirectory, d.remoteId);
      } else {
        await driver.remove(d.remoteId, opts.call);
      }
      deleted.push(d);
    } catch (err) {
      const name = newRecord.copies[d.destinationId]?.name ?? d.destinationId;
      warnings.push(
        `retention_delete_failed: ${name}: ${sanitizeBackupError(err, opts.secretValues)}`
      );
    }
  }
  if (deleted.length > 0) {
    await store.mutate(instanceUuid, (records) => {
      for (const d of deleted) {
        const copy: BackupCopyResult | undefined = records.find((r) => r.id === d.recordId)?.copies[
          d.destinationId
        ];
        // Only flip the copy that still points at the id we deleted.
        if (copy && copy.remoteId === d.remoteId) copy.status = "deleted";
      }
      for (let i = records.length - 1; i >= 0; i--) {
        const copies = Object.values(records[i].copies);
        if (copies.length > 0 && copies.every((c) => c.status === "deleted")) records.splice(i, 1);
      }
    });
  }
  return warnings;
}
