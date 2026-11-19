import {
  BACKUP_LIMITS,
  BackupErrorCode,
  BackupFinishedPayload,
  BackupRecord,
  isValidBackupId
} from "mcsmanager-common";
import { BackupError } from "./errors";

/** Minimal storage surface (matches StorageSubsystem) so tests can inject an in-memory one. */
export interface BackupStorage {
  store(category: string, uuid: string, object: any): void;
  load(category: string, classz: any, uuid: string): any;
  list(category: string): string[];
  delete(category: string, uuid: string): void;
}

export const BACKUP_INDEX_CATEGORY = "BackupIndex";
const RESERVED_INFLIGHT = "inflight";
const RESERVED_PENDING = "pending_events";
const RESERVED_LOCAL_DIRS = "local_dirs";
const RESERVED = new Set([RESERVED_INFLIGHT, RESERVED_PENDING, RESERVED_LOCAL_DIRS]);
const MAX_PENDING_EVENTS = 200;

class IndexFile {
  records: BackupRecord[] = [];
}
class InflightFile {
  jobs: InflightJob[] = [];
}
class PendingFile {
  events: BackupFinishedPayload[] = [];
}
class LocalDirsFile {
  dirs: Record<string, string> = {};
}

/** Job that was running; persisted by id only (no secrets) for restart recovery. */
export interface InflightJob {
  instanceUuid: string;
  backupId: string;
  planId: string;
  trigger: "manual" | "schedule";
  startedAt: number;
  destinations: { id: string; name: string; type: "local" | "s3" | "gdrive" }[];
  initiatedBy?: string;
  instanceName?: string;
}

/** A record with no usable copy can be dropped to make room. */
function isDroppable(record: BackupRecord): boolean {
  return !Object.values(record.copies).some((c) => c.status === "ok");
}

/** Per-instance backup index, serialised per instance, limited to 500 records. */
export class BackupIndexStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: BackupStorage,
    private readonly maxRecords: number = BACKUP_LIMITS.MAX_RECORDS_PER_INSTANCE
  ) {}

  private checkKey(instanceUuid: string) {
    if (!isValidBackupId(instanceUuid) || RESERVED.has(instanceUuid)) {
      throw new BackupError(BackupErrorCode.INVALID_REQUEST, "Invalid instance id");
    }
  }

  /** Run `fn` after every previous mutation of the same key finished. */
  private serialise<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  private read(instanceUuid: string): BackupRecord[] {
    const file = this.storage.load(
      BACKUP_INDEX_CATEGORY,
      IndexFile,
      instanceUuid
    ) as IndexFile | null;
    return file?.records ? [...file.records] : [];
  }

  private write(instanceUuid: string, records: BackupRecord[]) {
    this.storage.store(BACKUP_INDEX_CATEGORY, instanceUuid, { records });
  }

  /** Records newest first. */
  list(instanceUuid: string): BackupRecord[] {
    this.checkKey(instanceUuid);
    return this.read(instanceUuid).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(instanceUuid: string, recordId: string): BackupRecord | undefined {
    return this.list(instanceUuid).find((r) => r.id === recordId);
  }

  /** True when a new job could still be recorded (room or a droppable record exists). */
  hasCapacity(instanceUuid: string): boolean {
    const records = this.list(instanceUuid);
    return records.length < this.maxRecords || records.some(isDroppable);
  }

  /** Refuse the job when the index is full and nothing can be dropped. */
  assertCapacity(instanceUuid: string) {
    if (!this.hasCapacity(instanceUuid)) {
      throw new BackupError(BackupErrorCode.INDEX_FULL, "Backup index is full");
    }
  }

  /** Add a record. Returns false (and stores nothing) when full and nothing is droppable. */
  add(instanceUuid: string, record: BackupRecord): Promise<boolean> {
    this.checkKey(instanceUuid);
    return this.serialise(instanceUuid, () => {
      const records = this.read(instanceUuid).filter((r) => r.id !== record.id);
      while (records.length >= this.maxRecords) {
        const droppable = records.filter(isDroppable).sort((a, b) => a.createdAt - b.createdAt);
        if (droppable.length === 0) return false;
        records.splice(records.indexOf(droppable[0]), 1);
      }
      records.push(record);
      this.write(instanceUuid, records);
      return true;
    });
  }

  /** Atomically mutate the record list (serialised). `fn` may mutate in place. */
  mutate<T>(instanceUuid: string, fn: (records: BackupRecord[]) => T): Promise<T> {
    this.checkKey(instanceUuid);
    return this.serialise(instanceUuid, () => {
      const records = this.read(instanceUuid);
      const result = fn(records);
      this.write(instanceUuid, records);
      return result;
    });
  }

  /** Delete the whole index of an instance (instance removed). */
  deleteInstance(instanceUuid: string): Promise<void> {
    this.checkKey(instanceUuid);
    return this.serialise(instanceUuid, () =>
      this.storage.delete(BACKUP_INDEX_CATEGORY, instanceUuid)
    );
  }

  // ---- in-flight job ids (restart recovery) ----

  listInflight(): InflightJob[] {
    const f = this.storage.load(
      BACKUP_INDEX_CATEGORY,
      InflightFile,
      RESERVED_INFLIGHT
    ) as InflightFile | null;
    return f?.jobs ? [...f.jobs] : [];
  }

  setInflight(job: InflightJob): Promise<void> {
    return this.serialise(RESERVED_INFLIGHT, () => {
      const jobs = this.listInflight().filter((j) => j.backupId !== job.backupId);
      jobs.push(job);
      this.storage.store(BACKUP_INDEX_CATEGORY, RESERVED_INFLIGHT, { jobs });
    });
  }

  clearInflight(backupId: string): Promise<void> {
    return this.serialise(RESERVED_INFLIGHT, () => {
      const jobs = this.listInflight().filter((j) => j.backupId !== backupId);
      this.storage.store(BACKUP_INDEX_CATEGORY, RESERVED_INFLIGHT, { jobs });
    });
  }

  // ---- pending finished events (no panel connected) ----

  addPendingEvent(event: BackupFinishedPayload): Promise<void> {
    return this.serialise(RESERVED_PENDING, () => {
      const events = this.peekPendingEvents();
      events.push(event);
      while (events.length > MAX_PENDING_EVENTS) events.shift();
      this.storage.store(BACKUP_INDEX_CATEGORY, RESERVED_PENDING, { events });
    });
  }

  peekPendingEvents(): BackupFinishedPayload[] {
    const f = this.storage.load(
      BACKUP_INDEX_CATEGORY,
      PendingFile,
      RESERVED_PENDING
    ) as PendingFile | null;
    return f?.events ? [...f.events] : [];
  }

  /** Return and clear the pending events. */
  takePendingEvents(): Promise<BackupFinishedPayload[]> {
    return this.serialise(RESERVED_PENDING, () => {
      const events = this.peekPendingEvents();
      if (events.length)
        this.storage.store(BACKUP_INDEX_CATEGORY, RESERVED_PENDING, { events: [] });
      return events;
    });
  }

  // ---- local destination directories (non secret; needed for download/restore by id) ----

  rememberLocalDir(destinationId: string, directory: string): Promise<void> {
    if (!isValidBackupId(destinationId)) return Promise.resolve();
    return this.serialise(RESERVED_LOCAL_DIRS, () => {
      const dirs = this.getLocalDirs();
      if (dirs[destinationId] === directory) return;
      dirs[destinationId] = directory;
      this.storage.store(BACKUP_INDEX_CATEGORY, RESERVED_LOCAL_DIRS, { dirs });
    });
  }

  getLocalDirs(): Record<string, string> {
    const f = this.storage.load(
      BACKUP_INDEX_CATEGORY,
      LocalDirsFile,
      RESERVED_LOCAL_DIRS
    ) as LocalDirsFile | null;
    return f?.dirs ? { ...f.dirs } : {};
  }

  /** Instance uuids that have an index file. */
  listInstances(): string[] {
    return this.storage.list(BACKUP_INDEX_CATEGORY).filter((n) => !RESERVED.has(n));
  }
}
