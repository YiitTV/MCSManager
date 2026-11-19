import StorageSubsystem from "../../common/system_storage";
import logger from "../log";
import { BACKUP_INDEX_CATEGORY, BackupIndexStore } from "./index_store";

function readLegacyLocalDirs(): Record<string, string> {
  const file = `${BACKUP_INDEX_CATEGORY}/local_dirs.json`;
  try {
    const dirs: unknown = JSON.parse(StorageSubsystem.readFile(file)).dirs;
    if (dirs && typeof dirs === "object" && !Array.isArray(dirs)) {
      return Object.fromEntries(Object.entries(dirs).filter(([, dir]) => typeof dir === "string"));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Could not read legacy backup destination directories");
    }
  }
  return {};
}

/** Process-wide index store backed by the daemon StorageSubsystem (`data/BackupIndex`). */
export const backupIndexStore = new BackupIndexStore(
  StorageSubsystem,
  undefined,
  readLegacyLocalDirs
);
