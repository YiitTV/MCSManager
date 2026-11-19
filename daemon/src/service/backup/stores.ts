import StorageSubsystem from "../../common/system_storage";
import { BackupIndexStore } from "./index_store";

/** Process-wide index store backed by the daemon StorageSubsystem (`data/BackupIndex`). */
export const backupIndexStore = new BackupIndexStore(StorageSubsystem);
