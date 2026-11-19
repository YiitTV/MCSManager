/**
 * Shared contract for the `instance-backups` change.
 *
 * This file is the frozen contract between the panel, the daemon and the frontend:
 * types, limits, protocol event names and the destination driver interface.
 * It is pure (no fs, no network). Validators live in `./backup_validation`.
 *
 * Wire conventions:
 * - Panel -> daemon requests use the daemon's existing socket.io protocol; the payload of each
 *   event below is the `data` field of the request, and the response value is the `Res` type.
 * - All timestamps are epoch milliseconds.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker returned by panel APIs in place of any non-empty secret.
 * NOTE: intentionally DUPLICATED from the literal used in
 * `panel/src/app/routers/manage_user_router.ts` (that value is an inline string, not an
 * importable constant). Keep both in sync; never change this value.
 */
export const BACKUP_SECRET_MASK = "__MCSM_SECRET_DATA__";

/** Limits from design D8 / the spec. */
export const BACKUP_LIMITS = {
  /** Max destinations stored by one panel. */
  MAX_DESTINATIONS: 20,
  /** Max plans per instance. */
  MAX_PLANS_PER_INSTANCE: 4,
  /** Max records in one per-instance index on the daemon. */
  MAX_RECORDS_PER_INSTANCE: 500,
  /** Retention (copies kept per destination) range, inclusive. */
  MIN_RETENTION: 1,
  MAX_RETENTION: 100,
  /** Destinations per plan, inclusive range. */
  MIN_DESTINATIONS_PER_PLAN: 1,
  MAX_DESTINATIONS_PER_PLAN: 5,
  /** Include paths / exclude globs per plan. */
  MAX_INCLUDE_PATHS: 50,
  MAX_EXCLUDE_GLOBS: 50,
  /** Max characters of one include path / exclude glob. */
  MAX_PATH_LENGTH: 256,
  /** Max path segments of one include path / exclude glob. */
  MAX_PATH_SEGMENTS: 32,
  /** Destination / plan display name length, inclusive. */
  MIN_NAME_LENGTH: 1,
  MAX_NAME_LENGTH: 40,
  /** Max length of ids (destination, plan, backup, daemon, instance). */
  MAX_ID_LENGTH: 64,
  /** Queue: jobs waiting behind the one running job (per daemon). */
  QUEUE_LIMIT: 20,
  /** Jobs running at once per daemon. */
  MAX_CONCURRENT_JOBS: 1,
  /** Max length of a sanitized error summary stored in records/events. */
  MAX_ERROR_LENGTH: 300,
  /** Max warnings kept per record. */
  MAX_WARNINGS: 20,
  /** Min interval of an `interval` schedule, in seconds. */
  MIN_INTERVAL_SECONDS: 60,
  /** Max interval of an `interval` schedule, in seconds (1 year). */
  MAX_INTERVAL_SECONDS: 31536000,
  /** Max length of S3 endpoint URL. */
  MAX_ENDPOINT_LENGTH: 255,
  /** Max length of a `local` destination directory. */
  MAX_DIRECTORY_LENGTH: 512,
  /** Max size of a pasted service account JSON, in characters. */
  MAX_SERVICE_ACCOUNT_JSON_LENGTH: 16384
} as const;

/** Rate limit: one "Backup now" per user per plan per this many ms (regular users). */
export const BACKUP_NOW_RATE_LIMIT_MS = 60_000;

/** Lifetime of a single-use download ticket. */
export const BACKUP_DOWNLOAD_TICKET_TTL_MS = 60_000;

/** Lifetime of the Google OAuth `state` value. */
export const BACKUP_OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Upload part / chunk sizes (bytes). */
export const BACKUP_PART_SIZES = {
  /** S3 multipart part size. */
  S3_PART: 8 * 1024 * 1024,
  /** S3 part size used when 8 MiB parts would exceed S3_MAX_PARTS. */
  S3_LARGE_PART: 16 * 1024 * 1024,
  /** S3 hard limit on part count. */
  S3_MAX_PARTS: 10000,
  /** Google Drive resumable chunk size (must be a multiple of 256 KiB). */
  GDRIVE_CHUNK: 8 * 1024 * 1024
} as const;

/** Timing / retry constants (design D9, spec "Failure handling"). */
export const BACKUP_TIMING = {
  /** Retries after the first attempt for retryable errors. */
  UPLOAD_RETRIES: 3,
  /** Backoff before retry 1, 2, 3 (ms). */
  UPLOAD_BACKOFF_MS: [1000, 4000, 16000],
  /** Per-HTTP-request timeout. */
  REQUEST_TIMEOUT_MS: 60_000,
  /** Default overall job timeout (6 h). */
  JOB_TIMEOUT_MS: 6 * 60 * 60_000,
  /** Max wait for the Minecraft save-complete line. */
  SAVE_HOOK_TIMEOUT_MS: 60_000,
  /** Free space must be >= estimated size * this factor. */
  DISK_SAFETY_FACTOR: 1.2
} as const;

/** Archive format. */
export const BACKUP_ARCHIVE = {
  EXTENSION: ".zip",
  /** deflate level used by the archiver. */
  ZLIB_LEVEL: 1,
  /** Suffix of staging files that are not yet complete. */
  TMP_SUFFIX: ".tmp",
  /** Prefix of the restore rollback directory inside the instance dir. */
  ROLLBACK_DIR_PREFIX: ".mcsm_restore_rollback_"
} as const;

/** Schedule action type string registered with the daemon schedule engine. */
export const BACKUP_SCHEDULE_ACTION_TYPE = "backup";

/** Name of the daemon schedule created for a plan: `backup-<first 8 chars of plan id>`. */
export function backupScheduleName(planId: string): string {
  return `backup-${planId.slice(0, 8)}`;
}

/** Id of the always-present default local destination. */
export const BACKUP_DEFAULT_LOCAL_DESTINATION_ID = "local";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Preset names. `custom` means the include/exclude lists are user supplied. */
export type BackupPreset =
  | "minecraft-worlds"
  | "minecraft-worlds-plugins-configs"
  | "whole-directory"
  | "custom";

/** Runtime list of valid presets (for validation and UI). */
export const BACKUP_PRESET_NAMES: readonly BackupPreset[] = [
  "minecraft-worlds",
  "minecraft-worlds-plugins-configs",
  "whole-directory",
  "custom"
];

/**
 * Default exclude globs applied by every non-custom preset.
 * Syntax is the bounded glob subset documented in `backup_validation.ts`.
 */
export const BACKUP_DEFAULT_EXCLUDES: readonly string[] = [
  "session.lock",
  "*.tmp",
  ".mcsm_restore_rollback_*",
  "logs",
  "crash-reports",
  "cache"
];

/** Include / exclude lists a preset expands to. */
export interface BackupPresetDefinition {
  /** Include paths, relative to the instance working directory (`.` means the whole directory). */
  include: readonly string[];
  /** Exclude globs. */
  exclude: readonly string[];
}

/** Preset definitions (spec "Preset definitions"). `custom` has no definition. */
export const BACKUP_PRESETS: Readonly<
  Record<Exclude<BackupPreset, "custom">, BackupPresetDefinition>
> = {
  "minecraft-worlds": {
    include: ["world", "world_nether", "world_the_end"],
    exclude: BACKUP_DEFAULT_EXCLUDES
  },
  "minecraft-worlds-plugins-configs": {
    include: [
      "world",
      "world_nether",
      "world_the_end",
      "plugins",
      "config",
      "server.properties",
      "ops.json",
      "whitelist.json",
      "bukkit.yml",
      "spigot.yml"
    ],
    exclude: BACKUP_DEFAULT_EXCLUDES
  },
  "whole-directory": {
    include: ["."],
    exclude: BACKUP_DEFAULT_EXCLUDES
  }
};

/**
 * Expand a preset to concrete include/exclude lists. For `custom` (or an unknown preset) the
 * supplied lists are returned unchanged (copied). Result is not validated; call `validatePlan`.
 */
export function expandBackupPreset(
  preset: BackupPreset,
  custom?: { include?: readonly string[]; exclude?: readonly string[] }
): { include: string[]; exclude: string[] } {
  if (preset !== "custom" && Object.prototype.hasOwnProperty.call(BACKUP_PRESETS, preset)) {
    const def = BACKUP_PRESETS[preset];
    return { include: [...def.include], exclude: [...def.exclude] };
  }
  return { include: [...(custom?.include ?? [])], exclude: [...(custom?.exclude ?? [])] };
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** Kind of backup destination. */
export type BackupDestinationType = "local" | "s3" | "gdrive";

/** Runtime list of valid destination types. */
export const BACKUP_DESTINATION_TYPES: readonly BackupDestinationType[] = ["local", "s3", "gdrive"];

/** AES-256-GCM ciphertext as stored by the panel (all fields base64). Never leaves the panel. */
export interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Non-secret config of a `local` destination. */
export interface LocalConfig {
  /**
   * Absolute directory on the daemon host where archives are kept. Administrator-only input.
   * The daemon must create it if missing and only ever write files it names itself inside it.
   */
  directory: string;
  /** Max total bytes of all backup files kept in `directory` (> 0). */
  maxTotalBytes: number;
}

/** Non-secret config of an S3-compatible destination. */
export interface S3Config {
  /** `https` URL of the endpoint, <= 255 chars, no credentials/query/fragment (`http` only with allowPrivateNetwork). */
  endpoint: string;
  /** Signing region, e.g. `us-east-1`, `auto`. */
  region: string;
  /** Bucket name (S3 naming rules). */
  bucket: string;
  /** Optional key prefix (no leading slash, no `..`). */
  prefix?: string;
  /** Path-style addressing (`https://endpoint/bucket/key`) instead of virtual-hosted. */
  pathStyle: boolean;
  /** Allow private/loopback addresses, IP literals and `http` (design D7). Default false. */
  allowPrivateNetwork: boolean;
  /** Access key id (not secret). */
  accessKeyId: string;
}

/** Google authentication methods. */
export type GDriveAuthMethod = "oauth" | "service_account";

/** Non-secret config of a Google Drive destination. */
export interface GDriveConfig {
  /** `oauth` = operator's own OAuth client; `service_account` = JSON key + shared folder. */
  authMethod: GDriveAuthMethod;
  /** OAuth client id (oauth only). Not secret. */
  clientId?: string;
  /** Parent folder id (required for service_account; optional for oauth). */
  folderId?: string;
  /** Email of the connected account, display only. Set by the panel, never trusted. */
  connectedEmail?: string;
}

/** Secrets of an S3 destination. `V` is the storage form (plain / encrypted / masked). */
export interface S3Secrets<V = string> {
  secretAccessKey?: V;
}

/** Secrets of a Google Drive destination. */
export interface GDriveSecrets<V = string> {
  /** OAuth client secret (oauth). */
  clientSecret?: V;
  /** OAuth refresh token (oauth, set by the callback). */
  refreshToken?: V;
  /** Whole service account JSON document (service_account). */
  serviceAccountJson?: V;
}

/** Fields shared by every destination. */
export interface BackupDestinationBase {
  /** Unique id (`[A-Za-z0-9_-]{1,64}`), usually a uuid. */
  id: string;
  /** Display name, 1..40 chars. */
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalDestination<V = string> extends BackupDestinationBase {
  type: "local";
  config: LocalConfig;
  secrets: Record<string, V | undefined>;
}

export interface S3Destination<V = string> extends BackupDestinationBase {
  type: "s3";
  config: S3Config;
  secrets: S3Secrets<V>;
}

export interface GDriveDestination<V = string> extends BackupDestinationBase {
  type: "gdrive";
  config: GDriveConfig;
  secrets: GDriveSecrets<V>;
}

/**
 * A destination whose secrets have storage form `V`:
 * - `BackupDestination<EncryptedSecret>`: as stored in panel data (`StoredBackupDestination`).
 * - `BackupDestination<string>` with plain text: as sent to the daemon (`PlainBackupDestination`).
 * - `BackupDestination<string>` with `BACKUP_SECRET_MASK`: as returned by panel APIs
 *   (`PublicBackupDestination`, produced by `stripSecrets`).
 */
export type BackupDestination<V = string> =
  | LocalDestination<V>
  | S3Destination<V>
  | GDriveDestination<V>;

/** Destination as persisted by the panel (`data/BackupDestination/<id>.json`). */
export type StoredBackupDestination = BackupDestination<EncryptedSecret>;
/** Destination with decrypted secrets, sent panel -> daemon inside a job request. Never persisted. */
export type PlainBackupDestination = BackupDestination<string>;
/** Destination as returned by panel HTTP APIs: every non-empty secret is `BACKUP_SECRET_MASK`. */
export type PublicBackupDestination = BackupDestination<string>;

/** Minimal destination view shown to regular users (name and type only). */
export interface BackupDestinationRef {
  id: string;
  name: string;
  type: BackupDestinationType;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Schedule of a plan. Absent = manual only. */
export interface BackupSchedule {
  /**
   * `interval`: `value` is a decimal integer number of seconds (60..31536000).
   * `cron`: `value` is a 5- or 6-field cron expression (node-schedule syntax subset, see validator).
   */
  kind: "interval" | "cron";
  value: string;
}

/** A backup plan, owned by the panel (`data/BackupPlan/<id>.json`) and sent to the daemon per job. */
export interface BackupPlan {
  /** Unique id (`[A-Za-z0-9_-]{1,64}`). */
  id: string;
  /** Daemon (node) id that owns the instance. */
  daemonId: string;
  instanceUuid: string;
  /** Display name, 1..40 chars. */
  name: string;
  preset: BackupPreset;
  /** Include paths relative to the instance directory (already expanded from the preset). */
  include: string[];
  /** Exclude globs (see `backup_validation.ts` for the syntax). */
  exclude: string[];
  /** Optional automatic schedule. */
  schedule?: BackupSchedule;
  /** Newest N `ok` copies kept per destination, 1..100. */
  retention: number;
  /** 1..5 destination ids. */
  destinationIds: string[];
  /** Send save-off / save-all flush / save-on around the archive for a running instance. */
  minecraftSaveHook: boolean;
  enabled: boolean;
}

/** Plan fields the daemon needs for one job (a plan view without panel-only concerns). */
export type BackupPlanSnapshot = Pick<
  BackupPlan,
  "id" | "name" | "include" | "exclude" | "retention" | "destinationIds" | "minecraftSaveHook"
>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** What started a job. */
export type BackupTrigger = "manual" | "schedule";

/** State of one copy at one destination. */
export type BackupCopyStatus = "ok" | "failed" | "deleted";

/** Per-destination result inside a record. */
export interface BackupCopyResult {
  status: BackupCopyStatus;
  type: BackupDestinationType;
  /** Destination display name at job time. */
  name: string;
  /** S3 object key, Drive file id or local file name. Hidden from regular users. */
  remoteId?: string;
  /** Sanitized error text (secrets/URLs removed), max 300 chars. */
  error?: string;
}

/** One backup, persisted by the daemon in `data/BackupIndex/<instanceUuid>.json`. */
export interface BackupRecord {
  /** Backup id (`[A-Za-z0-9_-]{1,64}`), generated by the daemon. */
  id: string;
  planId: string;
  createdAt: number;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the archive. */
  sha256: string;
  trigger: BackupTrigger;
  /** Non-fatal notes (missing include path, save timeout, failed retention delete ...). */
  warnings: string[];
  /** Per-destination result keyed by destination id. */
  copies: Record<string, BackupCopyResult>;
}

/** Record view for regular users: no remote ids. */
export interface BackupRecordPublic extends Omit<BackupRecord, "copies"> {
  copies: Record<string, Omit<BackupCopyResult, "remoteId">>;
}

/** Redact a record for regular users (drops `remoteId`; error text is already sanitized). */
export function redactRecordForUser(record: BackupRecord): BackupRecordPublic {
  const copies: BackupRecordPublic["copies"] = {};
  for (const [id, copy] of Object.entries(record.copies)) {
    const { remoteId: _remoteId, ...rest } = copy;
    copies[id] = rest;
  }
  return { ...record, copies };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Job lifecycle state. */
export type BackupJobState = "queued" | "running" | "cancelling";

/** Coarse phase of a running job (for progress UI). */
export type BackupJobPhase =
  | "waiting"
  | "save_hook"
  | "scanning"
  | "archiving"
  | "uploading"
  | "retention"
  | "restoring";

/** Kind of job occupying the single queue slot. */
export type BackupJobKind = "backup" | "restore";

/** Status of one queued or running job. */
export interface BackupJobStatus {
  backupId: string;
  kind: BackupJobKind;
  planId: string;
  trigger: BackupTrigger;
  state: BackupJobState;
  phase: BackupJobPhase;
  /** Bytes processed in the current phase (archived or uploaded). */
  doneBytes: number;
  /** Total bytes of the current phase if known, else 0. */
  totalBytes: number;
  /** Destination currently uploading to, if any. */
  destinationId?: string;
  queuedAt: number;
  startedAt?: number;
}

/** Machine-readable job / request failure reasons (the panel translates these). */
export enum BackupErrorCode {
  /** Queue is full (20 waiting jobs). */
  BUSY = "BACKUP_BUSY",
  /** Index already holds 500 records. */
  INDEX_FULL = "BACKUP_INDEX_FULL",
  /** Not enough free disk space on the staging volume or local destination cap. */
  DISK_SPACE = "BACKUP_DISK_SPACE",
  /** Include path illegal at job time. */
  ILLEGAL_PATH = "BACKUP_ILLEGAL_PATH",
  /** No include path exists. */
  NOTHING_TO_BACKUP = "BACKUP_NOTHING_TO_BACKUP",
  /** Instance not found on the daemon. */
  INSTANCE_NOT_FOUND = "BACKUP_INSTANCE_NOT_FOUND",
  /** Plan missing, disabled or belonging to another instance. */
  PLAN_INVALID = "BACKUP_PLAN_INVALID",
  /** Request payload failed validation. */
  INVALID_REQUEST = "BACKUP_INVALID_REQUEST",
  /** Job cancelled by an administrator. */
  CANCELLED = "BACKUP_CANCELLED",
  /** Job exceeded the overall timeout. */
  TIMEOUT = "BACKUP_TIMEOUT",
  /** Daemon restarted while the job was running. */
  DAEMON_RESTART = "BACKUP_DAEMON_RESTART",
  /** Scheduled job fired but no panel socket was connected. */
  PANEL_UNREACHABLE = "BACKUP_PANEL_UNREACHABLE",
  /** All destinations failed. */
  ALL_DESTINATIONS_FAILED = "BACKUP_ALL_DESTINATIONS_FAILED",
  /** Restore requested while the instance is not stopped. */
  INSTANCE_MUST_BE_STOPPED = "BACKUP_INSTANCE_MUST_BE_STOPPED",
  /** SHA-256 of the fetched archive did not match the record. */
  CHECKSUM_MISMATCH = "BACKUP_CHECKSUM_MISMATCH",
  /** Archive contains an illegal entry (traversal, absolute, escaping symlink, too large). */
  ILLEGAL_ARCHIVE = "BACKUP_ILLEGAL_ARCHIVE",
  /** Record not found or has no usable copy. */
  RECORD_NOT_FOUND = "BACKUP_RECORD_NOT_FOUND",
  /** Rate limit hit (Backup now once per 60 s per plan for regular users). */
  RATE_LIMITED = "BACKUP_RATE_LIMITED",
  /** Anything else; `message` is sanitized. */
  INTERNAL = "BACKUP_INTERNAL"
}

// ---------------------------------------------------------------------------
// Destination driver
// ---------------------------------------------------------------------------

/** Codes a driver reports; `retryable` ones are retried by the job runner (3x, 1/4/16 s). */
export enum BackupDriverErrorCode {
  /** Network error, timeout, HTTP 5xx or 429. Retryable. */
  TRANSIENT = "DRIVER_TRANSIENT",
  /** Bad credentials / forbidden. Not retryable. */
  AUTH = "DRIVER_AUTH",
  /** Endpoint blocked by SSRF rules. Not retryable. */
  ENDPOINT_NOT_ALLOWED = "DRIVER_ENDPOINT_NOT_ALLOWED",
  /** Bucket / folder / object missing. Not retryable. */
  NOT_FOUND = "DRIVER_NOT_FOUND",
  /** Local cap or remote quota exceeded. Not retryable. */
  QUOTA = "DRIVER_QUOTA",
  /** Aborted through the AbortSignal. Not retryable. */
  ABORTED = "DRIVER_ABORTED",
  /** Anything else. Not retryable. */
  FAILED = "DRIVER_FAILED"
}

/**
 * Error thrown by every driver method. `message` MUST already be sanitized (no secrets, tokens,
 * authorization headers or full URLs); use `sanitizeBackupError`.
 */
export class BackupDriverError extends Error {
  constructor(
    public readonly code: BackupDriverErrorCode,
    message: string,
    public readonly retryable: boolean = code === BackupDriverErrorCode.TRANSIENT
  ) {
    super(message);
    this.name = "BackupDriverError";
  }
}

/** Identifies the object a driver creates and provides optional display metadata. */
export interface BackupObjectContext {
  instanceUuid: string;
  planId: string;
  backupId: string;
  instanceName?: string;
  /** Backup creation time in epoch milliseconds. */
  createdAt?: number;
}

/** Progress callback: `doneBytes` of `totalBytes` transferred so far (monotonic). */
export type BackupProgressCallback = (doneBytes: number, totalBytes: number) => void;

/** Options common to driver calls. */
export interface BackupDriverCallOptions {
  /** Abort the operation; the driver must clean up partial remote state and throw ABORTED. */
  signal?: AbortSignal;
}

/** Arguments of `DestinationDriver.put`. */
export interface BackupPutRequest extends BackupDriverCallOptions {
  /** Absolute path of the staging archive to upload (read in bounded chunks, never fully buffered). */
  filePath: string;
  /** Exact size of the file in bytes. */
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the file (informational; may be stored as object metadata). */
  sha256: string;
  /** Ids and display metadata used to name the new object. */
  object: BackupObjectContext;
  /** Called as bytes are sent. */
  onProgress?: BackupProgressCallback;
}

/** Result of `DestinationDriver.put`. */
export interface BackupPutResult {
  /** Opaque id recorded in `BackupCopyResult.remoteId`: S3 key, Drive file id, or local file name. */
  remoteId: string;
  /** Bytes stored at the destination. */
  sizeBytes: number;
}

/** Arguments of `DestinationDriver.get`. */
export interface BackupGetRequest extends BackupDriverCallOptions {
  /** `remoteId` previously returned by `put`. */
  remoteId: string;
  /** Absolute path of the file to write (created/overwritten; removed on failure). */
  destPath: string;
  onProgress?: BackupProgressCallback;
}

/** Result of `DestinationDriver.head`. */
export interface BackupHeadResult {
  exists: boolean;
  sizeBytes?: number;
}

/** Result of `DestinationDriver.test`. */
export interface BackupTestResult {
  ok: boolean;
  /** Sanitized error summary when `ok` is false. */
  error?: string;
  /** Local destination only: free bytes of the volume. */
  freeBytes?: number;
}

/**
 * Contract implemented by the local, S3 and Google Drive drivers (one instance per job per
 * destination, constructed from a `PlainBackupDestination`; secrets live only in memory).
 *
 * Rules for every implementation:
 * - Never log or put secrets / authorization headers / full URLs into thrown messages.
 * - Throw `BackupDriverError`; map transient failures to `TRANSIENT` (the caller retries).
 * - `put` performs no retries of its own across whole-file attempts, but MAY retry single
 *   requests / resume chunks internally; it must clean up partial remote state before throwing.
 * - `remove` and `head` only act on a `remoteId` previously returned by `put`; they never list or
 *   pattern-match remote objects.
 */
export interface DestinationDriver {
  /** Destination type this driver serves. */
  readonly type: BackupDestinationType;

  /**
   * Verify access: write, read metadata of and delete a small marker object
   * (local: write and remove a marker file, report `freeBytes`). Never throws for expected
   * failures; returns `{ ok: false, error }` with a sanitized error.
   */
  test(options?: BackupDriverCallOptions): Promise<BackupTestResult>;

  /** Upload `filePath` and return the remote id to record. */
  put(request: BackupPutRequest): Promise<BackupPutResult>;

  /** Check that the object exists and report its size. Missing object is `{ exists: false }`. */
  head(remoteId: string, options?: BackupDriverCallOptions): Promise<BackupHeadResult>;

  /** Download the object to `request.destPath`. */
  get(request: BackupGetRequest): Promise<void>;

  /** Delete the object. Deleting a missing object resolves successfully (idempotent). */
  remove(remoteId: string, options?: BackupDriverCallOptions): Promise<void>;
}

/** Factory the job runner uses to obtain a driver for a destination of any type. */
export type DestinationDriverFactory = (destination: PlainBackupDestination) => DestinationDriver;

// ---------------------------------------------------------------------------
// Panel <-> daemon protocol
// ---------------------------------------------------------------------------

/** Event names of the backup protocol (design "Panel to daemon protocol"). */
export const BACKUP_PROTOCOL = {
  /** panel -> daemon: start (queue) a backup job. */
  RUN: "backup/run",
  /** panel -> daemon: queue / running job / progress of an instance. */
  STATUS: "backup/status",
  /** panel -> daemon: cancel a queued or running job. */
  CANCEL: "backup/cancel",
  /** panel -> daemon: list records of an instance. */
  RECORDS: "backup/records",
  /** panel -> daemon: restore a record into the (stopped) instance. */
  RESTORE: "backup/restore",
  /** panel -> daemon: create a single-use download ticket for a local copy. */
  DOWNLOAD_TICKET: "backup/download_ticket",
  /** panel -> daemon: test a destination. */
  TEST_DESTINATION: "backup/test_destination",
  /** panel -> daemon: handshake after (re)connect; returns finished-events the daemon queued. */
  PENDING_EVENTS: "backup/pending_events",
  /** daemon -> panel (broadcast): a scheduled `backup` action fired. */
  TRIGGER: "backup/trigger",
  /** daemon -> panel (broadcast): a job finished (source of the notification event). */
  FINISHED: "backup/finished"
} as const;

/** Union of all protocol event names. */
export type BackupProtocolEvent = (typeof BACKUP_PROTOCOL)[keyof typeof BACKUP_PROTOCOL];

/** `backup/run` request. Carries decrypted secrets; the daemon keeps them in memory only. */
export interface BackupRunReq {
  instanceUuid: string;
  plan: BackupPlanSnapshot;
  /** Exactly the destinations referenced by `plan.destinationIds`, in any order. */
  destinations: PlainBackupDestination[];
  trigger: BackupTrigger;
  /** Display name of the initiating user (manual only). */
  initiatedBy?: string;
  /** Display name of the instance (for the finished event; the daemon echoes it back). */
  instanceName?: string;
}
/** `backup/run` response. */
export interface BackupRunRes {
  backupId: string;
}

/** `backup/status` request. */
export interface BackupStatusReq {
  instanceUuid: string;
}
/** `backup/status` response. `running` is first-class; `queued` are waiting jobs in order. */
export interface BackupStatusRes {
  running?: BackupJobStatus;
  queued: BackupJobStatus[];
}

/** `backup/cancel` request. */
export interface BackupCancelReq {
  instanceUuid: string;
  backupId: string;
}
/** `backup/cancel` response. */
export interface BackupCancelRes {
  /** True if a queued or running job was found and cancellation started. */
  cancelled: boolean;
}

/** `backup/records` request. */
export interface BackupRecordsReq {
  instanceUuid: string;
}
/** `backup/records` response, newest first. */
export interface BackupRecordsRes {
  records: BackupRecord[];
}

/** `backup/restore` request. */
export interface BackupRestoreReq {
  instanceUuid: string;
  recordId: string;
  destinations: PlainBackupDestination[];
}
/** `backup/restore` response. */
export interface BackupRestoreRes {
  /** Id of the restore job (occupies the single queue slot). */
  jobId: string;
}

/** `backup/download_ticket` request. */
export interface BackupDownloadTicketReq {
  instanceUuid: string;
  recordId: string;
  /** Configured local destinations for this record's successful copies. */
  destinations?: PlainBackupDestination[];
}
/** `backup/download_ticket` response. */
export interface BackupDownloadTicketRes {
  /** Opaque single-use ticket path/id consumed by the existing daemon download channel. */
  ticket: string;
  /** Suggested file name for the browser download. */
  fileName: string;
  sizeBytes: number;
  /** Epoch ms after which the ticket is invalid (<= now + 60 s). */
  expiresAt: number;
}

/** `backup/test_destination` request. */
export interface BackupTestDestinationReq {
  destination: PlainBackupDestination;
}
/** `backup/test_destination` response. */
export type BackupTestDestinationRes = BackupTestResult;

/** `backup/trigger` broadcast payload (daemon -> panel). */
export interface BackupTriggerPayload {
  instanceUuid: string;
  planId: string;
}

/** `backup/finished` broadcast payload (daemon -> panel). Also an element of the pending list. */
export interface BackupFinishedPayload {
  instanceUuid: string;
  /** Plan id the job ran for. */
  planId: string;
  /** The final record (also present for total failure, with every copy `failed`). */
  record: BackupRecord;
  /** Set when no destination holds a copy; sanitized, max 300 chars. */
  errorSummary?: string;
  /** Machine-readable reason when failed. */
  errorCode?: BackupErrorCode;
  durationMs: number;
  /** Echo of `BackupRunReq.initiatedBy`. */
  initiatedBy?: string;
  /** Echo of `BackupRunReq.instanceName`. */
  instanceName?: string;
}

/** `backup/pending_events` request (no data). */
export type BackupPendingEventsReq = Record<string, never>;
/**
 * `backup/pending_events` response: finished-events produced while no panel was connected
 * (e.g. `PANEL_UNREACHABLE`). The daemon drops them after answering.
 */
export interface BackupPendingEventsRes {
  events: BackupFinishedPayload[];
}

// ---------------------------------------------------------------------------
// Notification event (design D12)
// ---------------------------------------------------------------------------

/** Event names published on the panel's in-process event bus. */
export const BACKUP_EVENT_NAMES = {
  SUCCEEDED: "backup.succeeded",
  FAILED: "backup.failed"
} as const;

/**
 * Payload published for every finished job (exactly one event per job). Contains no secrets,
 * remote keys, host paths or URLs.
 */
export interface BackupEventPayload {
  event: "backup.succeeded" | "backup.failed";
  /** Epoch ms. */
  occurredAt: number;
  instance: { daemonId: string; uuid: string; name: string };
  plan: { id: string; name: string };
  backupId: string;
  trigger: BackupTrigger;
  /** Display name of the user for manual backups. */
  initiatedBy?: string;
  sizeBytes?: number;
  durationMs: number;
  destinations: {
    id: string;
    name: string;
    type: BackupDestinationType;
    status: "ok" | "failed";
    error?: string;
  }[];
  warnings: string[];
  /** Failed events only; sanitized, max 300 chars. */
  errorSummary?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** True for ids safe to use in file names, object keys and schedule payloads. */
export function isValidBackupId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Remote object name for a backup: `<instanceUuid>/<planId>/<backupId>.zip`. Drivers prepend their
 * own prefix/folder. Throws on an invalid id so no client-supplied path text can reach a key.
 */
export function buildBackupObjectName(object: BackupObjectContext): string {
  for (const id of [object.instanceUuid, object.planId, object.backupId]) {
    if (!isValidBackupId(id)) throw new Error("Invalid backup object id");
  }
  return `${object.instanceUuid}/${object.planId}/${object.backupId}${BACKUP_ARCHIVE.EXTENSION}`;
}

/** Flat file name `<planId>_<backupId>.zip` (used for downloads and legacy callers). */
export function buildBackupFileName(planId: string, backupId: string): string {
  if (!isValidBackupId(planId) || !isValidBackupId(backupId)) {
    throw new Error("Invalid backup file id");
  }
  return `${planId}_${backupId}${BACKUP_ARCHIVE.EXTENSION}`;
}

// Windows reserves these names even when followed by an extension.
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]) *\./i;

export function sanitizeBackupInstanceName(
  instanceName: string | undefined,
  instanceUuid: string
): string {
  if (!isValidBackupId(instanceUuid)) throw new Error("Invalid backup object id");
  let name = (instanceName ?? "").replace(/[^\p{L}\p{Nd} _.-]/gu, "_").trim();
  if (DEVICE_NAME.test(name)) name = `_${name}`;

  // Leave room for the 28-byte timestamp, id suffix and extension on 255-byte filesystems.
  let prefix = "";
  let bytes = 0;
  let chars = 0;
  for (const char of name) {
    bytes += Buffer.byteLength(char);
    if (++chars > 60 || bytes > 227) break;
    prefix += char;
  }
  prefix = prefix.trimEnd();
  return !prefix || prefix === "." || prefix === ".." ? instanceUuid.slice(0, 8) : prefix;
}

/** Display name for Drive and local copies, with a stable name across upload retries. */
export function buildReadableBackupFileName(object: BackupObjectContext): string {
  const legacyName = buildBackupFileName(object.planId, object.backupId);
  if (object.createdAt === undefined) return legacyName;
  const name = sanitizeBackupInstanceName(object.instanceName, object.instanceUuid);
  const iso = new Date(object.createdAt).toISOString();
  if (iso.length !== 24) throw new Error("Invalid backup creation year");
  const timestamp = iso.slice(0, 16).replace("T", "_").replace(":", "-");
  const suffix = object.backupId.slice(0, 6);
  return `${name}_${timestamp}_${suffix}${BACKUP_ARCHIVE.EXTENSION}`;
}

/** S3 multipart part size for a file: 8 MiB, or 16 MiB if 8 MiB parts would exceed 10000 parts. */
export function chooseS3PartSize(totalBytes: number): number {
  const parts = Math.ceil(totalBytes / BACKUP_PART_SIZES.S3_PART);
  return parts > BACKUP_PART_SIZES.S3_MAX_PARTS
    ? BACKUP_PART_SIZES.S3_LARGE_PART
    : BACKUP_PART_SIZES.S3_PART;
}

function isSecretPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  return true;
}

/** True if `value` is exactly the masked placeholder. */
export function isMaskedSecret(value: unknown): boolean {
  return value === BACKUP_SECRET_MASK;
}

/**
 * Return a copy of `destination` safe to send to clients: every present secret (any storage form)
 * becomes `BACKUP_SECRET_MASK`, absent/empty secrets become `""`. Non-secret config is kept.
 * The input is not mutated.
 */
export function stripSecrets<V>(destination: BackupDestination<V>): PublicBackupDestination {
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(destination.secrets ?? {})) {
    secrets[key] = isSecretPresent(value) ? BACKUP_SECRET_MASK : "";
  }
  return {
    ...destination,
    config: { ...destination.config },
    secrets
  } as PublicBackupDestination;
}

/** Reduce a destination to its name/type reference (what regular users may see). */
export function toDestinationRef(destination: {
  id: string;
  name: string;
  type: BackupDestinationType;
}): BackupDestinationRef {
  return { id: destination.id, name: destination.name, type: destination.type };
}

/**
 * Produce a short error text safe for records, events and API responses:
 * removes each non-empty string in `secretValues`, URLs, `Authorization`/bearer values, long
 * token-like runs, control characters, collapses whitespace and truncates to 300 chars.
 */
export function sanitizeBackupError(error: unknown, secretValues: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error ?? "");
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("***");
  }
  text = text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(
      /(authorization|x-amz-[a-z-]*|bearer|token|secret|password|signature)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
      "$1$2***"
    )
    .replace(/\bbearer\s+[^\s"',;]+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "***")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > BACKUP_LIMITS.MAX_ERROR_LENGTH) {
    text = text.slice(0, BACKUP_LIMITS.MAX_ERROR_LENGTH - 3) + "...";
  }
  return text;
}
