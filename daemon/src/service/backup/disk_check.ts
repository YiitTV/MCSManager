import fs from "fs-extra";
import path from "path";
import {
  BACKUP_TIMING,
  BackupCopyResult,
  BackupErrorCode,
  BackupRecord,
  LocalDestination
} from "mcsmanager-common";
import { BackupError } from "./errors";

export type StatfsFn = (p: string) => Promise<{ bavail: number; bsize: number }>;

export const defaultStatfs: StatfsFn = async (p) => {
  const s = await fs.promises.statfs(p);
  return { bavail: Number(s.bavail), bsize: Number(s.bsize) };
};

export async function freeBytes(dir: string, statfs: StatfsFn = defaultStatfs): Promise<number> {
  // statfs needs an existing path; walk up to the nearest existing ancestor.
  let p = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(p);
      return s.bavail * s.bsize;
    } catch (err: any) {
      const parent = path.dirname(p);
      if (parent === p || (err?.code !== "ENOENT" && err?.code !== "ENOTDIR")) throw err;
      p = parent;
    }
  }
}

/** Total size of regular files directly inside `directory` (local destination usage). */
export async function directoryUsedBytes(directory: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      total += (await fs.lstat(path.join(directory, e.name))).size;
    } catch {
      // vanished
    }
  }
  return total;
}

/**
 * Bytes that retention would free on `destinationId` once a new copy exists: sizes of the `ok`
 * copies of the plan beyond the newest `retention - 1` existing ones.
 */
export function previewRetentionFreedBytes(
  records: BackupRecord[],
  planId: string,
  destinationId: string,
  retention: number
): number {
  const ok = records
    .filter((r) => r.planId === planId && r.copies[destinationId]?.status === "ok")
    .sort((a, b) => b.createdAt - a.createdAt);
  return ok.slice(Math.max(retention - 1, 0)).reduce((sum, r) => sum + r.sizeBytes, 0);
}

export interface DiskCheckInput {
  estimatedBytes: number;
  stagingDir: string;
  statfs?: StatfsFn;
  locals?: {
    destination: LocalDestination<string>;
    usedBytes: number;
    freedByRetention: number;
  }[];
}

/** Refuse a job when the staging volume or a local destination cap cannot hold it. */
export async function checkDiskSpace(input: DiskCheckInput): Promise<void> {
  const needed = Math.ceil(input.estimatedBytes * BACKUP_TIMING.DISK_SAFETY_FACTOR);
  const free = await freeBytes(input.stagingDir, input.statfs);
  if (free < needed) {
    throw new BackupError(BackupErrorCode.DISK_SPACE, "Not enough free disk space for the backup");
  }
  for (const l of input.locals ?? []) {
    const projected = l.usedBytes - l.freedByRetention + input.estimatedBytes;
    if (projected > l.destination.config.maxTotalBytes) {
      throw new BackupError(
        BackupErrorCode.DISK_SPACE,
        "Local destination size limit would be exceeded"
      );
    }
  }
}

export type { BackupCopyResult };
