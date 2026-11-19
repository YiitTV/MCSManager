import {
  BACKUP_LIMITS,
  BACKUP_TIMING,
  BackupErrorCode,
  BackupJobKind,
  BackupJobPhase,
  BackupJobStatus,
  BackupTrigger
} from "mcsmanager-common";
import { BackupError } from "./errors";

/** Handed to a running job: abort signal and progress reporting. */
export interface JobContext {
  signal: AbortSignal;
  setPhase(phase: BackupJobPhase): void;
  setProgress(doneBytes: number, totalBytes: number): void;
  setDestination(destinationId?: string): void;
}

export interface QueueJobSpec {
  backupId: string;
  instanceUuid: string;
  kind: BackupJobKind;
  planId: string;
  trigger: BackupTrigger;
  run: (ctx: JobContext) => Promise<void>;
  /** Called instead of `run` when the job is cancelled while still queued. */
  onDropped?: (error: BackupError) => void | Promise<void>;
}

interface Entry {
  spec: QueueJobSpec;
  status: BackupJobStatus;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

export interface QueueOptions {
  limit?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** One running job per daemon, up to `limit` waiting. */
export class BackupQueue {
  private readonly waiting: Entry[] = [];
  private current?: Entry;
  private readonly limit: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private idleResolvers: (() => void)[] = [];

  constructor(options: QueueOptions = {}) {
    this.limit = options.limit ?? BACKUP_LIMITS.QUEUE_LIMIT;
    this.timeoutMs = options.timeoutMs ?? BACKUP_TIMING.JOB_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Queue a job; rejects with BUSY when `limit` jobs already wait. */
  enqueue(spec: QueueJobSpec): void {
    if (this.waiting.length >= this.limit) {
      throw new BackupError(BackupErrorCode.BUSY, "Backup queue is full");
    }
    this.waiting.push({
      spec,
      controller: new AbortController(),
      status: {
        backupId: spec.backupId,
        kind: spec.kind,
        planId: spec.planId,
        trigger: spec.trigger,
        state: "queued",
        phase: "waiting",
        doneBytes: 0,
        totalBytes: 0,
        queuedAt: this.now()
      }
    });
    setImmediate(() => this.pump());
  }

  /** Cancel a queued or running job of the instance. */
  cancel(instanceUuid: string, backupId: string): boolean {
    const idx = this.waiting.findIndex(
      (e) => e.spec.backupId === backupId && e.spec.instanceUuid === instanceUuid
    );
    if (idx >= 0) {
      const [entry] = this.waiting.splice(idx, 1);
      const err = new BackupError(BackupErrorCode.CANCELLED, "Backup cancelled");
      void Promise.resolve(entry.spec.onDropped?.(err)).catch(() => undefined);
      return true;
    }
    const cur = this.current;
    if (cur && cur.spec.backupId === backupId && cur.spec.instanceUuid === instanceUuid) {
      if (cur.status.state !== "cancelling") {
        cur.status.state = "cancelling";
        cur.controller.abort(new BackupError(BackupErrorCode.CANCELLED, "Backup cancelled"));
      }
      return true;
    }
    return false;
  }

  status(instanceUuid?: string): { running?: BackupJobStatus; queued: BackupJobStatus[] } {
    const match = (e: Entry) => !instanceUuid || e.spec.instanceUuid === instanceUuid;
    return {
      running: this.current && match(this.current) ? { ...this.current.status } : undefined,
      queued: this.waiting.filter(match).map((e) => ({ ...e.status }))
    };
  }

  isBusy(): boolean {
    return !!this.current || this.waiting.length > 0;
  }

  /** Resolves once nothing runs or waits. */
  whenIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private pump() {
    if (this.current) return;
    const entry = this.waiting.shift();
    if (!entry) {
      const rs = this.idleResolvers;
      this.idleResolvers = [];
      rs.forEach((r) => r());
      return;
    }
    this.current = entry;
    entry.status.state = "running";
    entry.status.startedAt = this.now();
    entry.timer = setTimeout(() => {
      entry.controller.abort(new BackupError(BackupErrorCode.TIMEOUT, "Backup timed out"));
    }, this.timeoutMs);
    entry.timer.unref?.();
    const ctx: JobContext = {
      signal: entry.controller.signal,
      setPhase: (p) => {
        entry.status.phase = p;
        entry.status.doneBytes = 0;
        entry.status.totalBytes = 0;
      },
      setProgress: (d, t) => {
        entry.status.doneBytes = d;
        entry.status.totalBytes = t;
      },
      setDestination: (id) => {
        entry.status.destinationId = id;
      }
    };
    entry.spec
      .run(ctx)
      .catch(() => undefined)
      .finally(() => {
        if (entry.timer) clearTimeout(entry.timer);
        this.current = undefined;
        setImmediate(() => this.pump());
      });
  }
}
