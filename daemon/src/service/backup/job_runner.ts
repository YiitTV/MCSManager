import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import {
  BACKUP_ARCHIVE,
  BACKUP_LIMITS,
  BACKUP_TIMING,
  BackupCopyResult,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupErrorCode,
  BackupFinishedPayload,
  BackupPlanSnapshot,
  BackupRecord,
  BackupRestoreReq,
  BackupRestoreRes,
  BackupRunReq,
  BackupRunRes,
  BackupStatusRes,
  BackupTestResult,
  BACKUP_PROTOCOL,
  DestinationDriver,
  DestinationDriverFactory,
  isValidBackupId,
  PlainBackupDestination,
  sanitizeBackupError,
  validateBackupName,
  validateDestination,
  validateDestinationIds,
  validateExcludeGlobs,
  validateIncludePaths,
  validateRetention
} from "mcsmanager-common";
import logger from "../log";
import { createArchive, lowerPriority, scanInstanceFiles } from "./archiver";
import {
  checkDiskSpace,
  directoryUsedBytes,
  previewRetentionFreedBytes,
  StatfsFn
} from "./disk_check";
import { abortError, BackupError, throwIfAborted, toBackupFailure } from "./errors";
import { BackupIndexStore } from "./index_store";
import { HookInstance, withMinecraftSaveHook } from "./minecraft_hook";
import { BackupQueue, JobContext } from "./queue";
import { restoreArchive } from "./restore";
import { applyRetention } from "./retention";
import { resolveLocalCopyPath } from "./destinations/local";
import { assertLocalDirectoryAllowed } from "./local_dir_policy";

/** Extra broadcast (daemon only) with the outcome of a restore job. */
export const BACKUP_RESTORE_FINISHED_EVENT = "backup/restore_finished";

export interface BackupRestoreFinishedPayload {
  instanceUuid: string;
  jobId: string;
  recordId: string;
  ok: boolean;
  errorCode?: BackupErrorCode;
  errorSummary?: string;
  warnings: string[];
  durationMs: number;
}

/** Slice of an instance the runner needs. */
export interface RunnerInstance extends HookInstance {
  name: string;
  absoluteCwdPath(): string;
  isStopped(): boolean;
}

export interface RunnerDeps {
  getInstance(instanceUuid: string): RunnerInstance | undefined;
  store: BackupIndexStore;
  queue: BackupQueue;
  driverFactory: DestinationDriverFactory;
  stagingDir: string;
  /** Broadcast a protocol event to every connected panel. */
  broadcast(event: string, payload: unknown): void;
  /** True when at least one panel socket is connected. */
  hasPanel(): boolean;
  maxUncompressedBytes(): number;
  /** Instance working directories (a local destination may not live inside one). */
  instanceDirs?: () => string[];
  /** Daemon data directory (only `<dataDir>/Backups` is allowed inside it). */
  dataDir?: string;
  afterRestoreExtract?(instanceUuid: string, topLevelPaths: string[]): Promise<void>;
  statfs?: StatfsFn;
  lowerPriority?: () => () => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoffMs?: readonly number[];
  newId?: () => string;
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function secretsOf(destinations: readonly PlainBackupDestination[]): string[] {
  const out: string[] = [];
  for (const d of destinations) {
    for (const v of Object.values(d.secrets ?? {})) {
      if (typeof v === "string" && v.length >= 4) out.push(v);
      // Service account JSON carries the private key inside; mask its fields too.
      if (typeof v === "string" && v.startsWith("{")) {
        try {
          for (const inner of Object.values(JSON.parse(v))) {
            if (typeof inner === "string" && inner.length >= 4) out.push(inner);
          }
        } catch {
          // not json
        }
      }
    }
  }
  return out;
}

function invalid(message: string): never {
  throw new BackupError(BackupErrorCode.INVALID_REQUEST, message);
}

export function validatePlanSnapshot(plan: unknown): BackupPlanSnapshot {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) invalid("Invalid plan");
  const p = plan as Record<string, unknown>;
  if (!isValidBackupId(p.id)) invalid("Invalid plan id");
  const checks = [
    validateBackupName(p.name),
    validateIncludePaths(p.include),
    validateExcludeGlobs(p.exclude ?? []),
    validateRetention(p.retention),
    validateDestinationIds(p.destinationIds)
  ];
  for (const c of checks) if (!c.ok) invalid("Invalid plan");
  if (typeof p.minecraftSaveHook !== "boolean") invalid("Invalid plan");
  return {
    id: p.id as string,
    name: String(p.name).trim(),
    include: [...(p.include as string[])],
    exclude: [...((p.exclude as string[]) ?? [])],
    retention: p.retention as number,
    destinationIds: [...(p.destinationIds as string[])],
    minecraftSaveHook: p.minecraftSaveHook as boolean
  };
}

export function validateDestinationList(value: unknown, max = 20): PlainBackupDestination[] {
  if (!Array.isArray(value) || value.length > max) invalid("Invalid destinations");
  const seen = new Set<string>();
  for (const d of value) {
    const r = validateDestination(d, { requireSecrets: false });
    if (!r.ok || !isValidBackupId((d as any).id) || seen.has((d as any).id)) {
      invalid("Invalid destination");
    }
    seen.add((d as any).id);
  }
  return value as PlainBackupDestination[];
}

interface JobMeta {
  backupId: string;
  instanceUuid: string;
  plan: BackupPlanSnapshot;
  destinations: PlainBackupDestination[];
  trigger: "manual" | "schedule";
  initiatedBy?: string;
  instanceName?: string;
}

export class BackupJobRunner {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly backoff: readonly number[];

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? sleepAbortable;
    this.backoff = deps.backoffMs ?? BACKUP_TIMING.UPLOAD_BACKOFF_MS;
  }

  // ---------------------------------------------------------------- public API

  status(instanceUuid: string): BackupStatusRes {
    return this.deps.queue.status(instanceUuid);
  }

  cancel(instanceUuid: string, backupId: string): boolean {
    return this.deps.queue.cancel(instanceUuid, backupId);
  }

  records(instanceUuid: string): BackupRecord[] {
    return this.deps.store.list(instanceUuid);
  }

  async pendingEvents(): Promise<BackupFinishedPayload[]> {
    return this.deps.store.takePendingEvents();
  }

  /** Validate and queue a backup job. Throws BackupError for refused requests. */
  enqueueBackup(req: BackupRunReq): BackupRunRes {
    if (!isValidBackupId(req.instanceUuid)) invalid("Invalid instance");
    const instance = this.deps.getInstance(req.instanceUuid);
    if (!instance) throw new BackupError(BackupErrorCode.INSTANCE_NOT_FOUND, "Instance not found");
    const plan = validatePlanSnapshot(req.plan);
    const destinations = validateDestinationList(req.destinations, BACKUP_LIMITS.MAX_DESTINATIONS);
    const byId = new Map(destinations.map((d) => [d.id, d]));
    if (byId.size !== plan.destinationIds.length) invalid("Destinations do not match the plan");
    for (const id of plan.destinationIds)
      if (!byId.has(id)) invalid("Destinations do not match the plan");
    if (req.trigger !== "manual" && req.trigger !== "schedule") invalid("Invalid trigger");
    this.assertLocalDirs(destinations);
    // Include paths are re-checked physically here and again at job start.
    this.deps.store.assertCapacity(req.instanceUuid);

    const meta: JobMeta = {
      backupId: this.newId(),
      instanceUuid: req.instanceUuid,
      plan,
      destinations: plan.destinationIds.map((id) => byId.get(id)!),
      trigger: req.trigger,
      initiatedBy: typeof req.initiatedBy === "string" ? req.initiatedBy.slice(0, 100) : undefined,
      instanceName: (typeof req.instanceName === "string" && req.instanceName
        ? req.instanceName
        : instance.name
      )?.slice(0, 100)
    };
    this.rememberLocalDirs(meta.destinations);
    this.deps.queue.enqueue({
      backupId: meta.backupId,
      instanceUuid: meta.instanceUuid,
      kind: "backup",
      planId: plan.id,
      trigger: meta.trigger,
      run: (ctx) => this.runBackup(meta, ctx),
      onDropped: (err) => this.finishDropped(meta, err)
    });
    return { backupId: meta.backupId };
  }

  /** Validate and queue a restore job. */
  enqueueRestore(req: BackupRestoreReq): BackupRestoreRes {
    if (!isValidBackupId(req.instanceUuid) || !isValidBackupId(req.recordId))
      invalid("Invalid request");
    const instance = this.deps.getInstance(req.instanceUuid);
    if (!instance) throw new BackupError(BackupErrorCode.INSTANCE_NOT_FOUND, "Instance not found");
    if (!instance.isStopped()) {
      throw new BackupError(BackupErrorCode.INSTANCE_MUST_BE_STOPPED, "Instance must be stopped");
    }
    const destinations = validateDestinationList(
      req.destinations ?? [],
      BACKUP_LIMITS.MAX_DESTINATIONS
    );
    const record = this.deps.store.get(req.instanceUuid, req.recordId);
    if (!record) throw new BackupError(BackupErrorCode.RECORD_NOT_FOUND, "Backup not found");
    this.assertLocalDirs(destinations);
    this.rememberLocalDirs(destinations);
    const source = this.pickRestoreSource(record, destinations);
    if (!source) throw new BackupError(BackupErrorCode.RECORD_NOT_FOUND, "No usable copy");
    const jobId = this.newId();
    this.deps.queue.enqueue({
      backupId: jobId,
      instanceUuid: req.instanceUuid,
      kind: "restore",
      planId: record.planId,
      trigger: "manual",
      run: (ctx) => this.runRestore(jobId, req.instanceUuid, record, destinations, ctx),
      onDropped: (err) =>
        this.broadcastRestoreResult(req.instanceUuid, jobId, record.id, err, [], 0)
    });
    return { jobId };
  }

  /** Test a destination (admin action; the panel already checked the role). */
  async testDestination(destination: PlainBackupDestination): Promise<BackupTestResult> {
    const secrets = secretsOf([destination]);
    try {
      const [valid] = validateDestinationList([destination], 1);
      this.assertLocalDirs([valid]);
      const driver = this.deps.driverFactory(valid);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), BACKUP_TIMING.REQUEST_TIMEOUT_MS * 2);
      try {
        const res = await driver.test({ signal: ac.signal });
        if (res.ok && valid.type === "local") this.rememberLocalDirs([valid]);
        return res.ok
          ? res
          : { ok: false, error: sanitizeBackupError(res.error ?? "Test failed", secrets) };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, error: toBackupFailure(err, secrets).text };
    }
  }

  /** Resolve the local file of a record for a download ticket. */
  async resolveLocalCopy(
    instanceUuid: string,
    recordId: string,
    destinations: PlainBackupDestination[] = []
  ): Promise<{ filePath: string; fileName: string; sizeBytes: number }> {
    if (!isValidBackupId(instanceUuid) || !isValidBackupId(recordId)) invalid("Invalid request");
    const record = this.deps.store.get(instanceUuid, recordId);
    if (!record) throw new BackupError(BackupErrorCode.RECORD_NOT_FOUND, "Backup not found");
    const dirs = { ...this.deps.store.getLocalDirs() };
    this.assertLocalDirs(destinations);
    for (const d of destinations) if (d.type === "local") dirs[d.id] = d.config.directory;
    for (const [destId, copy] of Object.entries(record.copies)) {
      if (copy.type !== "local" || copy.status !== "ok" || !copy.remoteId || !dirs[destId])
        continue;
      try {
        const filePath = resolveLocalCopyPath(dirs[destId], copy.remoteId);
        const st = await fs.lstat(filePath);
        if (st.isFile()) return { filePath, fileName: copy.remoteId, sizeBytes: st.size };
      } catch {
        // try the next copy
      }
    }
    throw new BackupError(BackupErrorCode.RECORD_NOT_FOUND, "No local copy available");
  }

  /**
   * Startup recovery: remove stale staging files and turn jobs that were running when the daemon
   * stopped into failed records plus pending events.
   */
  async recover(): Promise<void> {
    await this.cleanStaging(0);
    for (const job of this.deps.store.listInflight()) {
      const now = this.now();
      const copies: Record<string, BackupCopyResult> = {};
      for (const d of job.destinations) {
        copies[d.id] = {
          status: "failed",
          type: d.type,
          name: d.name,
          error: "Daemon restarted during the backup"
        };
      }
      const record: BackupRecord = {
        id: job.backupId,
        planId: job.planId,
        createdAt: job.startedAt,
        sizeBytes: 0,
        sha256: "",
        trigger: job.trigger,
        warnings: [],
        copies
      };
      await this.deps.store.add(job.instanceUuid, record).catch(() => false);
      await this.deps.store.addPendingEvent({
        instanceUuid: job.instanceUuid,
        planId: job.planId,
        record,
        errorSummary: "Daemon restarted during the backup",
        errorCode: BackupErrorCode.DAEMON_RESTART,
        durationMs: Math.max(0, now - job.startedAt),
        initiatedBy: job.initiatedBy,
        instanceName: job.instanceName
      });
      await this.deps.store.clearInflight(job.backupId);
    }
  }

  /** Remove `*.tmp` staging files older than the daemon uptime (all of them at startup). */
  async cleanStaging(uptimeMs: number = process.uptime() * 1000): Promise<void> {
    const dir = this.deps.stagingDir;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const cutoff = this.now() - uptimeMs;
    for (const n of names) {
      if (!n.endsWith(BACKUP_ARCHIVE.TMP_SUFFIX)) continue;
      const p = path.join(dir, n);
      try {
        const st = await fs.lstat(p);
        if (st.isFile() && st.mtimeMs <= cutoff) await fs.remove(p);
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------- backup job

  /** Refuse local destinations whose directory is not allowed on this daemon. */
  private assertLocalDirs(destinations: readonly PlainBackupDestination[]) {
    for (const d of destinations) {
      if (d.type === "local") {
        assertLocalDirectoryAllowed(d.config.directory, {
          instanceDirs: this.deps.instanceDirs,
          dataDir: this.deps.dataDir
        });
      }
    }
  }

  private rememberLocalDirs(destinations: readonly PlainBackupDestination[]) {
    for (const d of destinations) {
      if (d.type === "local") {
        void this.deps.store.rememberLocalDir(d.id, d.config.directory).catch(() => undefined);
      }
    }
  }

  private stagingPath(id: string): string {
    return path.join(this.deps.stagingDir, `${id}.zip${BACKUP_ARCHIVE.TMP_SUFFIX}`);
  }

  private failedCopies(meta: JobMeta, text: string): Record<string, BackupCopyResult> {
    const copies: Record<string, BackupCopyResult> = {};
    for (const d of meta.destinations) {
      copies[d.id] = { status: "failed", type: d.type, name: d.name, error: text };
    }
    return copies;
  }

  private emitFinished(payload: BackupFinishedPayload) {
    if (this.deps.hasPanel()) {
      this.deps.broadcast(BACKUP_PROTOCOL.FINISHED, payload);
    } else {
      void this.deps.store.addPendingEvent(payload).catch(() => undefined);
    }
  }

  /** Job cancelled while still queued: record + exactly one finished event. */
  private async finishDropped(meta: JobMeta, err: BackupError) {
    const text = sanitizeBackupError(err);
    const record: BackupRecord = {
      id: meta.backupId,
      planId: meta.plan.id,
      createdAt: this.now(),
      sizeBytes: 0,
      sha256: "",
      trigger: meta.trigger,
      warnings: [],
      copies: this.failedCopies(meta, text)
    };
    await this.deps.store.add(meta.instanceUuid, record).catch(() => false);
    this.emitFinished({
      instanceUuid: meta.instanceUuid,
      planId: meta.plan.id,
      record,
      errorSummary: text,
      errorCode: err.code,
      durationMs: 0,
      initiatedBy: meta.initiatedBy,
      instanceName: meta.instanceName
    });
  }

  private async putWithRetry(
    driver: DestinationDriver,
    dest: PlainBackupDestination,
    meta: JobMeta,
    createdAt: number,
    archive: { path: string; sizeBytes: number; sha256: string },
    ctx: JobContext
  ): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(ctx.signal);
      try {
        const res = await driver.put({
          filePath: archive.path,
          sizeBytes: archive.sizeBytes,
          sha256: archive.sha256,
          object: {
            instanceUuid: meta.instanceUuid,
            planId: meta.plan.id,
            backupId: meta.backupId,
            instanceName: meta.instanceName,
            createdAt
          },
          signal: ctx.signal,
          onProgress: (done, total) => ctx.setProgress(done, total)
        });
        return res.remoteId;
      } catch (err) {
        if (ctx.signal.aborted) throw abortError(ctx.signal);
        const retryable =
          err instanceof BackupDriverError &&
          err.retryable &&
          attempt < BACKUP_TIMING.UPLOAD_RETRIES;
        if (!retryable) throw err;
        logger.warn(
          `Backup ${meta.backupId}: upload to "${dest.name}" failed, retry ${attempt + 1}`
        );
        await this.sleep(this.backoff[Math.min(attempt, this.backoff.length - 1)], ctx.signal);
      }
    }
  }

  private async runBackup(meta: JobMeta, ctx: JobContext): Promise<void> {
    const { instanceUuid, plan, destinations } = meta;
    const startedAt = this.now();
    const secrets = secretsOf(destinations);
    const warnings: string[] = [];
    const copies: Record<string, BackupCopyResult> = {};
    const drivers = new Map<string, DestinationDriver>();
    const staging = this.stagingPath(meta.backupId);
    const restorePriority = (this.deps.lowerPriority ?? lowerPriority)();
    let size = 0;
    let sha256 = "";
    let record: BackupRecord | undefined;
    let failure: { code: BackupErrorCode; text: string } | undefined;
    let finished = false;

    try {
      await this.deps.store.setInflight({
        instanceUuid,
        backupId: meta.backupId,
        planId: plan.id,
        trigger: meta.trigger,
        startedAt,
        destinations: destinations.map((d) => ({ id: d.id, name: d.name, type: d.type })),
        initiatedBy: meta.initiatedBy,
        instanceName: meta.instanceName
      });

      const instance = this.deps.getInstance(instanceUuid);
      if (!instance)
        throw new BackupError(BackupErrorCode.INSTANCE_NOT_FOUND, "Instance not found");
      const rootDir = instance.absoluteCwdPath();
      const skipAbsolute = [
        this.deps.stagingDir,
        ...destinations.filter((d) => d.type === "local").map((d) => (d as any).config.directory)
      ];

      // 1. scan + disk check
      ctx.setPhase("scanning");
      throwIfAborted(ctx.signal);
      const scan = await scanInstanceFiles({
        rootDir,
        include: plan.include,
        exclude: plan.exclude,
        skipAbsolute,
        signal: ctx.signal
      });
      if (scan.fileCount === 0 && scan.missing.length === plan.include.length) {
        throw new BackupError(BackupErrorCode.NOTHING_TO_BACKUP, "No include path exists");
      }
      const existing = this.deps.store.list(instanceUuid);
      const locals = [];
      for (const d of destinations) {
        if (d.type !== "local") continue;
        locals.push({
          destination: d,
          usedBytes: await directoryUsedBytes(d.config.directory),
          freedByRetention: previewRetentionFreedBytes(existing, plan.id, d.id, plan.retention)
        });
      }
      await checkDiskSpace({
        estimatedBytes: scan.totalBytes,
        stagingDir: this.deps.stagingDir,
        statfs: this.deps.statfs,
        locals
      });

      // 2. archive (inside the Minecraft save hook)
      ctx.setPhase("save_hook");
      const archive = await withMinecraftSaveHook(
        {
          instance,
          enabled: plan.minecraftSaveHook,
          signal: ctx.signal,
          onWarning: (w) => warnings.push(w)
        },
        async () => {
          ctx.setPhase("archiving");
          return createArchive({
            rootDir,
            include: plan.include,
            exclude: plan.exclude,
            skipAbsolute,
            outPath: staging,
            signal: ctx.signal,
            totalBytes: scan.totalBytes,
            onProgress: (d, t) => ctx.setProgress(d, t)
          });
        }
      );
      size = archive.sizeBytes;
      sha256 = archive.sha256;
      for (const m of archive.missing) warnings.push(`missing_path: ${m}`);

      // 3. upload to every destination
      ctx.setPhase("uploading");
      for (const dest of destinations) {
        throwIfAborted(ctx.signal);
        ctx.setDestination(dest.id);
        ctx.setProgress(0, size);
        try {
          const driver = this.deps.driverFactory(dest);
          drivers.set(dest.id, driver);
          const remoteId = await this.putWithRetry(
            driver,
            dest,
            meta,
            startedAt,
            { path: staging, sizeBytes: size, sha256 },
            ctx
          );
          copies[dest.id] = { status: "ok", type: dest.type, name: dest.name, remoteId };
        } catch (err) {
          if (ctx.signal.aborted) throw abortError(ctx.signal);
          copies[dest.id] = {
            status: "failed",
            type: dest.type,
            name: dest.name,
            error: toBackupFailure(err, secrets).text
          };
          logger.warn(`Backup ${meta.backupId}: destination "${dest.name}" failed`);
        }
      }
      ctx.setDestination(undefined);

      const anyOk = Object.values(copies).some((c) => c.status === "ok");
      record = {
        id: meta.backupId,
        planId: plan.id,
        createdAt: startedAt,
        sizeBytes: size,
        sha256,
        trigger: meta.trigger,
        warnings: warnings.slice(0, BACKUP_LIMITS.MAX_WARNINGS),
        copies
      };
      if (anyOk) {
        for (const dest of destinations) {
          const c = copies[dest.id];
          if (c?.status === "failed") {
            warnings.push(
              `destination_failed: ${sanitizeBackupError(dest.name)}: ${c.error ?? "failed"}`.slice(
                0,
                BACKUP_LIMITS.MAX_ERROR_LENGTH
              )
            );
          }
        }
        record.warnings = warnings.slice(0, BACKUP_LIMITS.MAX_WARNINGS);
      }
      if (!anyOk) {
        const first = Object.values(copies).find((c) => c.error)?.error;
        failure = {
          code: BackupErrorCode.ALL_DESTINATIONS_FAILED,
          text: first ?? "All destinations failed"
        };
      }
      if (!(await this.deps.store.add(instanceUuid, record))) {
        logger.warn(`Backup ${meta.backupId}: index full, record not stored`);
      }

      // 4. retention (never fails the job)
      if (anyOk) {
        ctx.setPhase("retention");
        try {
          const extra = await applyRetention({
            store: this.deps.store,
            instanceUuid,
            plan,
            newRecord: record,
            getDriver: (id) => drivers.get(id),
            secretValues: secrets
          });
          if (extra.length > 0) {
            record.warnings = [...record.warnings, ...extra].slice(0, BACKUP_LIMITS.MAX_WARNINGS);
            await this.deps.store.mutate(instanceUuid, (rs) => {
              const r = rs.find((x) => x.id === record!.id);
              if (r) r.warnings = record!.warnings;
            });
          }
        } catch (err) {
          logger.warn(
            `Backup ${meta.backupId}: retention failed: ${toBackupFailure(err, secrets).text}`
          );
        }
      }
    } catch (err) {
      failure = toBackupFailure(err, secrets);
      // Cancel / timeout / error: remove copies that were already uploaded.
      for (const [id, copy] of Object.entries(copies)) {
        if (copy.status === "ok" && copy.remoteId) {
          try {
            await drivers.get(id)?.remove(copy.remoteId);
          } catch {
            // best effort
          }
        }
      }
      if (!record) {
        record = {
          id: meta.backupId,
          planId: plan.id,
          createdAt: startedAt,
          sizeBytes: size,
          sha256,
          trigger: meta.trigger,
          warnings: warnings.slice(0, BACKUP_LIMITS.MAX_WARNINGS),
          copies: this.failedCopies(meta, failure.text)
        };
        await this.deps.store.add(instanceUuid, record).catch(() => false);
      }
    } finally {
      await fs.remove(staging).catch(() => undefined);
      try {
        restorePriority();
      } catch {
        // ignore
      }
      await this.deps.store.clearInflight(meta.backupId).catch(() => undefined);
      if (!finished && record) {
        finished = true;
        this.emitFinished({
          instanceUuid,
          planId: plan.id,
          record,
          errorSummary: failure?.text,
          errorCode: failure?.code,
          durationMs: Math.max(0, this.now() - startedAt),
          initiatedBy: meta.initiatedBy,
          instanceName: meta.instanceName
        });
      }
    }
  }

  // ---------------------------------------------------------------- restore job

  private pickRestoreSource(
    record: BackupRecord,
    destinations: PlainBackupDestination[]
  ): { destId: string; copy: BackupCopyResult } | undefined {
    return this.restoreCandidates(record, destinations)[0];
  }

  /** Usable copies, local first. */
  private restoreCandidates(
    record: BackupRecord,
    destinations: PlainBackupDestination[]
  ): { destId: string; copy: BackupCopyResult }[] {
    const dirs = this.deps.store.getLocalDirs();
    const byId = new Map(destinations.map((d) => [d.id, d]));
    const ok = Object.entries(record.copies).filter(([, c]) => c.status === "ok" && c.remoteId);
    const usable = ok.filter(([id, c]) =>
      c.type === "local" ? !!(dirs[id] || byId.get(id)) : byId.has(id)
    );
    usable.sort((a, b) => (a[1].type === "local" ? -1 : 0) - (b[1].type === "local" ? -1 : 0));
    return usable.map(([destId, copy]) => ({ destId, copy }));
  }

  private broadcastRestoreResult(
    instanceUuid: string,
    jobId: string,
    recordId: string,
    err: unknown,
    warnings: string[],
    durationMs: number,
    secrets: readonly string[] = []
  ) {
    const failure = err ? toBackupFailure(err, secrets) : undefined;
    const payload: BackupRestoreFinishedPayload = {
      instanceUuid,
      jobId,
      recordId,
      ok: !failure,
      errorCode: failure?.code,
      errorSummary: failure?.text,
      warnings,
      durationMs
    };
    this.deps.broadcast(BACKUP_RESTORE_FINISHED_EVENT, payload);
  }

  private async runRestore(
    jobId: string,
    instanceUuid: string,
    record: BackupRecord,
    destinations: PlainBackupDestination[],
    ctx: JobContext
  ): Promise<void> {
    const startedAt = this.now();
    const warnings: string[] = [];
    const secrets = secretsOf(destinations);
    const staging = this.stagingPath(jobId);
    const restorePriority = (this.deps.lowerPriority ?? lowerPriority)();
    let error: unknown;
    try {
      ctx.setPhase("restoring");
      const instance = this.deps.getInstance(instanceUuid);
      if (!instance)
        throw new BackupError(BackupErrorCode.INSTANCE_NOT_FOUND, "Instance not found");
      if (!instance.isStopped()) {
        throw new BackupError(BackupErrorCode.INSTANCE_MUST_BE_STOPPED, "Instance must be stopped");
      }
      const candidates = this.restoreCandidates(record, destinations);
      let archivePath: string | undefined;
      let lastError: unknown;
      for (const source of candidates) {
        try {
          if (source.copy.type === "local") {
            const dir =
              (destinations.find((d) => d.id === source.destId) as any)?.config?.directory ??
              this.deps.store.getLocalDirs()[source.destId];
            const p = resolveLocalCopyPath(dir, source.copy.remoteId!);
            if (!(await fs.pathExists(p))) continue;
            archivePath = p;
            break;
          }
          const dest = destinations.find((d) => d.id === source.destId)!;
          const driver = this.deps.driverFactory(dest);
          await fs.ensureDir(this.deps.stagingDir);
          for (let attempt = 0; ; attempt++) {
            try {
              await driver.get({
                remoteId: source.copy.remoteId!,
                destPath: staging,
                signal: ctx.signal,
                onProgress: (d, t) => ctx.setProgress(d, t)
              });
              break;
            } catch (err) {
              if (ctx.signal.aborted) throw abortError(ctx.signal);
              if (
                !(err instanceof BackupDriverError && err.retryable) ||
                attempt >= BACKUP_TIMING.UPLOAD_RETRIES
              ) {
                throw err;
              }
              await this.sleep(
                this.backoff[Math.min(attempt, this.backoff.length - 1)],
                ctx.signal
              );
            }
          }
          archivePath = staging;
          break;
        } catch (err) {
          if (ctx.signal.aborted) throw abortError(ctx.signal);
          lastError = err;
        }
      }
      if (!archivePath) {
        throw lastError ?? new BackupError(BackupErrorCode.RECORD_NOT_FOUND, "No usable copy");
      }

      await restoreArchive({
        archivePath,
        instanceDir: instance.absoluteCwdPath(),
        restoreId: jobId,
        expectedSha256: record.sha256,
        maxUncompressedBytes: this.deps.maxUncompressedBytes(),
        signal: ctx.signal,
        statfs: this.deps.statfs,
        onProgress: (d, t) => ctx.setProgress(d, t),
        onWarning: (w) => warnings.push(w),
        afterExtract: this.deps.afterRestoreExtract
          ? (tops) => this.deps.afterRestoreExtract!(instanceUuid, tops)
          : undefined
      });
    } catch (err) {
      error = err;
      logger.warn(`Restore ${jobId} failed: ${toBackupFailure(err, secrets).text}`);
    } finally {
      await fs.remove(staging).catch(() => undefined);
      try {
        restorePriority();
      } catch {
        // ignore
      }
      this.broadcastRestoreResult(
        instanceUuid,
        jobId,
        record.id,
        error,
        warnings,
        Math.max(0, this.now() - startedAt),
        secrets
      );
    }
  }
}
