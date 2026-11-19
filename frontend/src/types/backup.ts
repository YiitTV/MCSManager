// Frontend mirror of the shared contract in `common/src/backup.ts` (the frontend does not import
// `mcsmanager-common`). Keep in sync with that file: limits, presets and wire shapes.

export const BACKUP_SECRET_MASK = "__MCSM_SECRET_DATA__";

export const BACKUP_LIMITS = {
  MAX_DESTINATIONS: 20,
  MAX_PLANS_PER_INSTANCE: 4,
  MIN_RETENTION: 1,
  MAX_RETENTION: 100,
  MIN_DESTINATIONS_PER_PLAN: 1,
  MAX_DESTINATIONS_PER_PLAN: 5,
  MAX_INCLUDE_PATHS: 50,
  MAX_EXCLUDE_GLOBS: 50,
  MAX_PATH_LENGTH: 256,
  MAX_PATH_SEGMENTS: 32,
  MIN_NAME_LENGTH: 1,
  MAX_NAME_LENGTH: 40,
  MIN_INTERVAL_SECONDS: 60,
  MAX_INTERVAL_SECONDS: 31536000,
  MAX_ENDPOINT_LENGTH: 255,
  MAX_DIRECTORY_LENGTH: 512,
  MAX_SERVICE_ACCOUNT_JSON_LENGTH: 16384
} as const;

/** One "Backup now" per user per plan per this many ms (regular users). */
export const BACKUP_NOW_RATE_LIMIT_MS = 60_000;

export type BackupPreset =
  | "minecraft-worlds"
  | "minecraft-worlds-plugins-configs"
  | "whole-directory"
  | "custom";

export const BACKUP_DEFAULT_EXCLUDES: readonly string[] = [
  "session.lock",
  "*.tmp",
  ".mcsm_restore_rollback_*",
  "logs",
  "crash-reports",
  "cache"
];

export const BACKUP_PRESETS: Readonly<
  Record<
    Exclude<BackupPreset, "custom">,
    { include: readonly string[]; exclude: readonly string[] }
  >
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
  "whole-directory": { include: ["."], exclude: BACKUP_DEFAULT_EXCLUDES }
};

export type BackupDestinationType = "local" | "s3" | "gdrive";
export type GDriveAuthMethod = "oauth" | "service_account";

export interface LocalConfig {
  directory: string;
  maxTotalBytes: number;
}
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  pathStyle: boolean;
  allowPrivateNetwork: boolean;
  accessKeyId: string;
}
export interface GDriveConfig {
  authMethod: GDriveAuthMethod;
  clientId?: string;
  folderId?: string;
  connectedEmail?: string;
  /** Panel public URL; the OAuth redirect URI is `<redirectBaseUrl>/api/backup/gdrive/callback`. */
  redirectBaseUrl?: string;
}

/** Destination as returned by the panel: every non-empty secret is `BACKUP_SECRET_MASK`. */
export interface BackupDestination {
  id: string;
  type: BackupDestinationType;
  name: string;
  config: Partial<LocalConfig> & Partial<S3Config> & Partial<GDriveConfig>;
  secrets: Record<string, string | undefined>;
  createdAt?: number;
  updatedAt?: number;
}

/** Name/type only (what regular users get in plan listings). */
export interface BackupDestinationRef {
  id: string;
  name: string;
  type: BackupDestinationType;
}

export interface BackupSchedule {
  kind: "interval" | "cron";
  value: string;
}

export interface BackupPlan {
  id: string;
  daemonId: string;
  instanceUuid: string;
  name: string;
  preset: BackupPreset;
  include: string[];
  exclude: string[];
  schedule?: BackupSchedule;
  retention: number;
  destinationIds: string[];
  minecraftSaveHook: boolean;
  enabled: boolean;
}

export type BackupCopyStatus = "ok" | "failed" | "deleted";
export type BackupTrigger = "manual" | "schedule";

export interface BackupCopyResult {
  status: BackupCopyStatus;
  type: BackupDestinationType;
  name: string;
  /** Hidden from regular users. */
  remoteId?: string;
  error?: string;
}

export interface BackupRecord {
  id: string;
  planId: string;
  createdAt: number;
  sizeBytes: number;
  sha256: string;
  trigger: BackupTrigger;
  warnings: string[];
  copies: Record<string, BackupCopyResult>;
}

export type BackupJobState = "queued" | "running" | "cancelling";
export type BackupJobPhase =
  | "waiting"
  | "save_hook"
  | "scanning"
  | "archiving"
  | "uploading"
  | "retention"
  | "restoring";

export interface BackupJobStatus {
  backupId: string;
  kind: "backup" | "restore";
  planId: string;
  trigger: BackupTrigger;
  state: BackupJobState;
  phase: BackupJobPhase;
  doneBytes: number;
  totalBytes: number;
  destinationId?: string;
  queuedAt: number;
  startedAt?: number;
}

export interface BackupJobsResult {
  running?: BackupJobStatus;
  queued: BackupJobStatus[];
}

export interface BackupTestResult {
  ok: boolean;
  error?: string;
  freeBytes?: number;
}

/** Response of `POST /api/backup/download` (mirrors `/api/files/download` plus the file name). */
export interface BackupDownloadTicket {
  addr: string;
  password: string;
  remoteMappings?: any[];
  fileName: string;
  /** Optional ready-made URL; preferred when the panel provides it. */
  url?: string;
  sizeBytes?: number;
  expiresAt?: number;
}
