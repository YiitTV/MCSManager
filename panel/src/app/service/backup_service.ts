import crypto from "node:crypto";
import path from "path";
import { v4 } from "uuid";
import {
  BACKUP_DEFAULT_LOCAL_DESTINATION_ID,
  BACKUP_LIMITS,
  BACKUP_NOW_RATE_LIMIT_MS,
  BACKUP_PROTOCOL,
  BACKUP_SCHEDULE_ACTION_TYPE,
  BACKUP_SECRET_MASK,
  BackupCancelRes,
  BackupDestinationRef,
  BackupDownloadTicketReq,
  BackupDownloadTicketRes,
  BackupErrorCode,
  BackupPlan,
  BackupRecord,
  BackupRecordsRes,
  BackupRestoreRes,
  BackupRunReq,
  BackupRunRes,
  BackupStatusRes,
  BackupTestResult,
  BackupTrigger,
  BackupValidationCode,
  PlainBackupDestination,
  PublicBackupDestination,
  StoredBackupDestination,
  backupScheduleName,
  expandBackupPreset,
  isMaskedSecret,
  isValidBackupId,
  sanitizeBackupError,
  stripSecrets,
  toDestinationRef,
  validateDestination,
  validatePlan
} from "mcsmanager-common";
import Storage from "../common/storage/sys_storage";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import { decryptSecrets, encryptSecret, mergeSecrets } from "./backup_secret";
import { execWithMutexId } from "../utils/sync";

// Destination and plan management, plan -> daemon schedule sync and daemon requests for the
// instance-backups feature. Routers stay thin; every rule lives here so it is unit-testable.

export const BACKUP_DESTINATION_CATEGORY = "BackupDestination";
export const BACKUP_PLAN_CATEGORY = "BackupPlan";
const CONFIG_MUTEX = "backup-config";
const DEFAULT_LOCAL_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const DAEMON_TIMEOUT_MS = 15_000;
const SCHEDULE_ACTION_TYPE_INTERVAL = 1;
const SCHEDULE_ACTION_TYPE_CRON = 2;
const INSTANCE_STATUS_STOP = 0;

/** Error with a machine-readable code; routers translate `code` to an i18n message. */
export class BackupServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 400,
    public readonly params: Record<string, string | number> = {}
  ) {
    super(code);
    this.name = "BackupServiceError";
  }
}

// Storage envelope: the file storage only copies keys that exist on the target class, so the
// (dynamic-shaped) entity is kept inside an array which is copied as-is.
class BackupDoc {
  record: any[] = [];
}

async function loadDoc<T>(category: string, id: string): Promise<T | null> {
  if (!isValidBackupId(id)) return null;
  const doc = (await Storage.getStorage().load(category, BackupDoc, id)) as BackupDoc | null;
  return (doc?.record?.[0] as T | undefined) ?? null;
}

async function storeDoc(category: string, id: string, item: unknown) {
  await Storage.getStorage().store(category, id, { record: [item] });
}

async function listDocs<T>(category: string): Promise<T[]> {
  const ids = await Storage.getStorage().list(category);
  const items: T[] = [];
  for (const id of ids) {
    const item = await loadDoc<T>(category, id);
    if (item) items.push(item);
  }
  return items;
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validationError(r: { ok: false; code: BackupValidationCode; field: string }) {
  return new BackupServiceError("VALIDATION", 400, { field: r.field, code: r.code });
}

// ---------------------------------------------------------------------------
// Google redirect base URL (non-secret, admin supplied, panel public URL)
// ---------------------------------------------------------------------------

/**
 * `redirectBaseUrl` is the panel's public URL; the OAuth redirect URI is always
 * `<redirectBaseUrl>/api/backup/gdrive/callback`. It is never derived from request headers.
 * https only (plain http is accepted for localhost development).
 */
export function validateRedirectBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (/[\s\u0000-\u001f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const localDev =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDev) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return true;
}

export function buildRedirectUri(redirectBaseUrl: string): string {
  return `${redirectBaseUrl.replace(/\/+$/, "")}/api/backup/gdrive/callback`;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const SECRET_KEYS = {
  local: [] as string[],
  s3: ["secretAccessKey"],
  gdriveOauth: ["clientSecret", "refreshToken"],
  gdriveServiceAccount: ["serviceAccountJson"]
};

function secretKeysFor(type: string, authMethod?: string): string[] {
  if (type === "s3") return SECRET_KEYS.s3;
  if (type === "gdrive")
    return authMethod === "service_account"
      ? SECRET_KEYS.gdriveServiceAccount
      : SECRET_KEYS.gdriveOauth;
  return SECRET_KEYS.local;
}

function pickConfig(type: string, raw: Record<string, any>): Record<string, any> {
  const pick = (keys: string[]) => {
    const out: Record<string, any> = {};
    for (const k of keys) if (raw[k] !== undefined && raw[k] !== "") out[k] = raw[k];
    return out;
  };
  if (type === "local") return pick(["directory", "maxTotalBytes"]);
  if (type === "s3")
    return pick([
      "endpoint",
      "region",
      "bucket",
      "prefix",
      "pathStyle",
      "allowPrivateNetwork",
      "accessKeyId"
    ]);
  return pick(["authMethod", "clientId", "folderId", "redirectBaseUrl"]);
}

export async function ensureDefaultLocalDestination() {
  await execWithMutexId(CONFIG_MUTEX, ensureDefaultLocalDestinationUnlocked);
}

async function ensureDefaultLocalDestinationUnlocked() {
  {
    const existing = await loadDoc<StoredBackupDestination>(
      BACKUP_DESTINATION_CATEGORY,
      BACKUP_DEFAULT_LOCAL_DESTINATION_ID
    );
    if (existing) return;
    const now = Date.now();
    const dest: StoredBackupDestination = {
      id: BACKUP_DEFAULT_LOCAL_DESTINATION_ID,
      type: "local",
      name: "Local",
      // Assumes a daemon on the same host as the panel; admins can change it per deployment.
      config: {
        directory: path.resolve(process.cwd(), "..", "daemon", "data", "Backups"),
        maxTotalBytes: DEFAULT_LOCAL_MAX_BYTES
      },
      secrets: {},
      createdAt: now,
      updatedAt: now
    };
    await storeDoc(BACKUP_DESTINATION_CATEGORY, dest.id, dest);
  }
}

export async function getStoredDestination(id: string) {
  return loadDoc<StoredBackupDestination>(BACKUP_DESTINATION_CATEGORY, id);
}

export async function listStoredDestinations() {
  await ensureDefaultLocalDestination();
  const items = await listDocs<StoredBackupDestination>(BACKUP_DESTINATION_CATEGORY);
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/** Admin view: secrets masked. */
export async function listPublicDestinations(): Promise<PublicBackupDestination[]> {
  return (await listStoredDestinations()).map((d) => stripSecrets(d));
}

export function toPublicDestination(d: StoredBackupDestination): PublicBackupDestination {
  return stripSecrets(d);
}

/**
 * Build a validated stored destination from a request body.
 * `existing` set = update: masked / missing secrets keep the stored ones.
 */
export function buildDestination(
  body: unknown,
  existing?: StoredBackupDestination
): StoredBackupDestination {
  if (!isObject(body))
    throw new BackupServiceError("VALIDATION", 400, { field: "body", code: "NOT_AN_OBJECT" });
  const type = existing ? existing.type : body.type;
  if (existing && body.type !== undefined && body.type !== existing.type)
    throw new BackupServiceError("DESTINATION_TYPE_IMMUTABLE");
  const rawConfig = isObject(body.config) ? body.config : {};
  const config = pickConfig(String(type), rawConfig);
  const incoming: Record<string, unknown> = isObject(body.secrets) ? { ...body.secrets } : {};

  if (type === "gdrive") {
    const authMethod = config.authMethod;
    const allowed = secretKeysFor("gdrive", authMethod);
    // The refresh token is only ever set by the OAuth callback
    delete incoming.refreshToken;
    for (const k of Object.keys(incoming)) if (!allowed.includes(k)) delete incoming[k];
    if (config.redirectBaseUrl !== undefined && !validateRedirectBaseUrl(config.redirectBaseUrl)) {
      throw new BackupServiceError("VALIDATION", 400, {
        field: "config.redirectBaseUrl",
        code: "REDIRECT_BASE_URL_INVALID"
      });
    }
    if (existing && existing.type === "gdrive") {
      const sameClient =
        existing.config.authMethod === config.authMethod &&
        existing.config.clientId === config.clientId;
      // A different client / method invalidates the stored refresh token
      if (sameClient) {
        config.connectedEmail = existing.config.connectedEmail;
      }
    }
  }

  // Missing secret keys on update mean "keep"
  if (existing) {
    for (const k of Object.keys(existing.secrets ?? {})) {
      if (existing.secrets[k as keyof typeof existing.secrets] && incoming[k] === undefined)
        incoming[k] = BACKUP_SECRET_MASK;
    }
    if (type === "gdrive") {
      const sameClient =
        existing.type === "gdrive" &&
        existing.config.authMethod === config.authMethod &&
        existing.config.clientId === config.clientId;
      if (!sameClient) delete incoming.refreshToken;
    }
  }

  const candidate = {
    id: existing?.id,
    type,
    name: typeof body.name === "string" ? body.name.trim() : body.name,
    config,
    secrets: incoming
  };
  // connectedEmail is display-only and never accepted from clients
  const toValidate = JSON.parse(JSON.stringify(candidate));
  const r = validateDestination(toValidate, { allowMaskedSecrets: !!existing });
  if (!r.ok) throw validationError(r);
  // secretAccessKey etc. must not be the mask on create (validator enforces) - double check
  for (const v of Object.values(incoming)) {
    if (!existing && isMaskedSecret(v))
      throw new BackupServiceError("VALIDATION", 400, {
        field: "secrets",
        code: "DEST_SECRETS_INVALID"
      });
  }

  const keys = secretKeysFor(String(type), config.authMethod);
  const secrets = mergeSecrets((existing?.secrets ?? {}) as Record<string, any>, incoming, keys);
  if (type === "gdrive" && existing) {
    const sameClient =
      existing.type === "gdrive" &&
      existing.config.authMethod === config.authMethod &&
      existing.config.clientId === config.clientId;
    // A different client / method invalidates the stored refresh token
    if (!sameClient) delete secrets.refreshToken;
  }
  const now = Date.now();
  return {
    id: existing?.id ?? v4(),
    type,
    name: String(candidate.name),
    config,
    secrets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  } as StoredBackupDestination;
}

export async function createDestination(body: unknown): Promise<PublicBackupDestination> {
  return execWithMutexId(CONFIG_MUTEX, async () => {
    await ensureDefaultLocalDestinationUnlocked();
    const all = await listDocs<StoredBackupDestination>(BACKUP_DESTINATION_CATEGORY);
    if (all.length >= BACKUP_LIMITS.MAX_DESTINATIONS)
      throw new BackupServiceError("DESTINATION_LIMIT");
    const dest = buildDestination(body);
    await storeDoc(BACKUP_DESTINATION_CATEGORY, dest.id, dest);
    return stripSecrets(dest);
  });
}

export async function updateDestination(body: unknown): Promise<PublicBackupDestination> {
  const id = isObject(body) ? body.id : undefined;
  if (!isValidBackupId(id))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "id",
      code: BackupValidationCode.INVALID_ID
    });
  return execWithMutexId(CONFIG_MUTEX, async () => {
    const existing = await getStoredDestination(id);
    if (!existing) throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
    const dest = buildDestination(body, existing);
    await storeDoc(BACKUP_DESTINATION_CATEGORY, dest.id, dest);
    return stripSecrets(dest);
  });
}

export async function deleteDestination(id: unknown): Promise<void> {
  if (!isValidBackupId(id))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "id",
      code: BackupValidationCode.INVALID_ID
    });
  if (id === BACKUP_DEFAULT_LOCAL_DESTINATION_ID)
    throw new BackupServiceError("DESTINATION_DEFAULT_PROTECTED", 409);
  await execWithMutexId(CONFIG_MUTEX, async () => {
    if (!(await getStoredDestination(id)))
      throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
    const plans = await listDocs<BackupPlan>(BACKUP_PLAN_CATEGORY);
    const used = plans.filter((p) => p.destinationIds.includes(id)).length;
    if (used > 0) throw new BackupServiceError("DESTINATION_IN_USE", 409, { count: used });
    await Storage.getStorage().delete(BACKUP_DESTINATION_CATEGORY, id);
  });
}

/** Decrypt a stored destination for a daemon request (the daemon keeps it in memory only). */
export function toPlainDestination(d: StoredBackupDestination): PlainBackupDestination {
  const { redirectBaseUrl: _ignored, ...config } = d.config as any;
  return {
    ...d,
    config,
    secrets: decryptSecrets(d.secrets as any)
  } as PlainBackupDestination;
}

/** Test a destination (stored id, or an unsaved body whose masked secrets resolve to stored ones). */
export async function testDestination(daemonId: string, body: unknown): Promise<BackupTestResult> {
  if (!isObject(body))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "destination",
      code: "NOT_AN_OBJECT"
    });
  let existing: StoredBackupDestination | undefined;
  if (body.id !== undefined) {
    existing = (await getStoredDestination(String(body.id))) ?? undefined;
    if (!existing) throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
  }
  const dest = buildDestination(body, existing);
  const plain = toPlainDestination(dest);
  const secretValues = Object.values(plain.secrets as Record<string, string>);
  try {
    return await daemonRequest<BackupTestResult>(
      daemonId,
      BACKUP_PROTOCOL.TEST_DESTINATION,
      {
        destination: plain
      },
      60_000
    );
  } catch (err) {
    if (err instanceof BackupServiceError) throw err;
    return { ok: false, error: sanitizeBackupError(err, secretValues) };
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function getPlan(id: string) {
  return loadDoc<BackupPlan>(BACKUP_PLAN_CATEGORY, id);
}

export async function listPlansForInstance(daemonId: string, instanceUuid: string) {
  const all = await listDocs<BackupPlan>(BACKUP_PLAN_CATEGORY);
  return all.filter((p) => p.daemonId === daemonId && p.instanceUuid === instanceUuid);
}

/** Remove plans after the daemon confirms deletion and has removed the instance schedules. */
export async function deletePlansForInstances(daemonId: string, instanceUuids: string[]) {
  const ids = new Set(instanceUuids);
  await execWithMutexId(CONFIG_MUTEX, async () => {
    for (const plan of await listDocs<BackupPlan>(BACKUP_PLAN_CATEGORY)) {
      if (plan.daemonId === daemonId && ids.has(plan.instanceUuid)) {
        await Storage.getStorage().delete(BACKUP_PLAN_CATEGORY, plan.id);
      }
    }
  });
}

/** Plan view with destination name/type refs (what every role may see). */
export async function describePlans(plans: BackupPlan[]) {
  const dests = await listStoredDestinations();
  const byId = new Map(dests.map((d) => [d.id, toDestinationRef(d)]));
  return plans.map((p) => ({
    ...p,
    destinations: p.destinationIds
      .map((id) => byId.get(id))
      .filter((r): r is BackupDestinationRef => !!r)
  }));
}

function buildPlan(body: unknown, existing?: BackupPlan): BackupPlan {
  if (!isObject(body))
    throw new BackupServiceError("VALIDATION", 400, { field: "body", code: "NOT_AN_OBJECT" });
  const preset = body.preset ?? existing?.preset;
  const expanded = expandBackupPreset(preset as any, {
    include: Array.isArray(body.include) ? body.include : existing?.include,
    exclude: Array.isArray(body.exclude) ? body.exclude : existing?.exclude
  });
  const schedule =
    body.schedule === undefined
      ? existing?.schedule
      : body.schedule === null
        ? undefined
        : body.schedule;
  const plan: any = {
    id: existing?.id ?? v4(),
    daemonId: existing?.daemonId ?? body.daemonId,
    instanceUuid: existing?.instanceUuid ?? body.instanceUuid ?? body.uuid,
    name: typeof body.name === "string" ? body.name.trim() : (body.name ?? existing?.name),
    preset,
    include: expanded.include,
    exclude: expanded.exclude,
    retention: body.retention ?? existing?.retention,
    destinationIds: body.destinationIds ?? existing?.destinationIds,
    minecraftSaveHook: body.minecraftSaveHook ?? existing?.minecraftSaveHook ?? false,
    enabled: body.enabled ?? existing?.enabled ?? true
  };
  if (schedule !== undefined) plan.schedule = schedule;
  if (existing) {
    for (const k of ["daemonId", "instanceUuid"] as const) {
      const given = k === "instanceUuid" ? (body.instanceUuid ?? body.uuid) : body.daemonId;
      if (given !== undefined && given !== existing[k])
        throw new BackupServiceError("PLAN_INSTANCE_IMMUTABLE");
    }
  }
  const r = validatePlan(plan, { requireIdentity: true });
  if (!r.ok) throw validationError(r);
  // Only keep known fields
  const clean: BackupPlan = {
    id: plan.id,
    daemonId: plan.daemonId,
    instanceUuid: plan.instanceUuid,
    name: plan.name,
    preset: plan.preset,
    include: plan.include,
    exclude: plan.exclude,
    retention: plan.retention,
    destinationIds: plan.destinationIds,
    minecraftSaveHook: plan.minecraftSaveHook,
    enabled: plan.enabled
  };
  if (plan.schedule) clean.schedule = { kind: plan.schedule.kind, value: plan.schedule.value };
  return clean;
}

// Must be called inside the config mutex
async function assertDestinationsExist(ids: string[]) {
  await ensureDefaultLocalDestinationUnlocked();
  for (const id of ids) {
    if (!(await getStoredDestination(id)))
      throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
  }
}

/** Register / update / remove the daemon schedule of a plan (one `backup` action). */
export async function syncPlanSchedule(plan: BackupPlan): Promise<void> {
  const name = backupScheduleName(plan.id);
  const wanted = plan.enabled && !!plan.schedule;
  // The daemon refuses a duplicate name, so update = delete + register
  await daemonRequest(plan.daemonId, "schedule/delete", { instanceUuid: plan.instanceUuid, name });
  if (!wanted || !plan.schedule) return;
  await daemonRequest(plan.daemonId, "schedule/register", {
    instanceUuid: plan.instanceUuid,
    name,
    count: -1,
    time: plan.schedule.value,
    actions: [{ type: BACKUP_SCHEDULE_ACTION_TYPE, payload: plan.id }],
    type:
      plan.schedule.kind === "interval" ? SCHEDULE_ACTION_TYPE_INTERVAL : SCHEDULE_ACTION_TYPE_CRON
  });
}

export async function createPlan(body: unknown): Promise<BackupPlan> {
  return execWithMutexId(CONFIG_MUTEX, async () => {
    const plan = buildPlan(body);
    const siblings = await listPlansForInstance(plan.daemonId, plan.instanceUuid);
    if (siblings.length >= BACKUP_LIMITS.MAX_PLANS_PER_INSTANCE)
      throw new BackupServiceError("PLAN_LIMIT", 409);
    await assertDestinationsExist(plan.destinationIds);
    // The instance must exist on that daemon
    await daemonRequest(plan.daemonId, "instance/detail", { instanceUuid: plan.instanceUuid });
    await syncOrFail(plan);
    await storeDoc(BACKUP_PLAN_CATEGORY, plan.id, plan);
    return plan;
  });
}

async function syncOrFail(plan: BackupPlan) {
  try {
    await syncPlanSchedule(plan);
  } catch (err) {
    logger.warn(`[Backup] schedule sync failed for plan ${plan.id}: ${sanitizeBackupError(err)}`);
    throw new BackupServiceError("SCHEDULE_SYNC_FAILED", 502);
  }
}

export async function updatePlan(body: unknown): Promise<BackupPlan> {
  const id = isObject(body) ? (body.id ?? body.planId) : undefined;
  if (!isValidBackupId(id))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "id",
      code: BackupValidationCode.INVALID_ID
    });
  return execWithMutexId(CONFIG_MUTEX, async () => {
    const existing = await getPlan(id);
    if (!existing) throw new BackupServiceError("PLAN_NOT_FOUND", 404);
    const plan = buildPlan(body, existing);
    await assertDestinationsExist(plan.destinationIds);
    await syncOrFail(plan);
    await storeDoc(BACKUP_PLAN_CATEGORY, plan.id, plan);
    return plan;
  });
}

export async function deletePlan(id: unknown): Promise<BackupPlan> {
  if (!isValidBackupId(id))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "id",
      code: BackupValidationCode.INVALID_ID
    });
  return execWithMutexId(CONFIG_MUTEX, async () => {
    const existing = await getPlan(id);
    if (!existing) throw new BackupServiceError("PLAN_NOT_FOUND", 404);
    try {
      await syncPlanSchedule({ ...existing, enabled: false });
    } catch (err) {
      // A dangling schedule only produces a skipped (plan invalid) firing; do not block deletion
      logger.warn(`[Backup] schedule removal failed for plan ${id}: ${sanitizeBackupError(err)}`);
    }
    await Storage.getStorage().delete(BACKUP_PLAN_CATEGORY, id);
    return existing;
  });
}

// ---------------------------------------------------------------------------
// Daemon requests
// ---------------------------------------------------------------------------

const KNOWN_DAEMON_CODES = new Set<string>(Object.values(BackupErrorCode));

export function translateDaemonError(err: unknown): BackupServiceError {
  if (err instanceof BackupServiceError) return err;
  const text = String((err as Error)?.message ?? err ?? "");
  for (const code of KNOWN_DAEMON_CODES) {
    if (text.includes(code)) {
      const status = code === BackupErrorCode.RATE_LIMITED ? 429 : 400;
      return new BackupServiceError(code, status);
    }
  }
  return new BackupServiceError("DAEMON_ERROR", 502, { message: sanitizeBackupError(text) });
}

export async function daemonRequest<T = any>(
  daemonId: string,
  event: string,
  data: unknown,
  timeout = DAEMON_TIMEOUT_MS
): Promise<T> {
  const service = RemoteServiceSubsystem.getInstance(daemonId);
  if (!service) throw new BackupServiceError("DAEMON_NOT_FOUND", 404);
  try {
    return await new RemoteRequest(service).request<T>(event, data, timeout);
  } catch (err) {
    throw translateDaemonError(err);
  }
}

async function plainDestinationsFor(ids: string[]): Promise<PlainBackupDestination[]> {
  const out: PlainBackupDestination[] = [];
  for (const id of ids) {
    const d = await getStoredDestination(id);
    if (!d) throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
    out.push(toPlainDestination(d));
  }
  return out;
}

/** Build and send `backup/run`. Credentials go to that daemon only. */
export async function runPlan(
  plan: BackupPlan,
  trigger: BackupTrigger,
  initiatedBy?: string,
  instanceName?: string
): Promise<BackupRunRes> {
  if (!plan.enabled) throw new BackupServiceError(BackupErrorCode.PLAN_INVALID);
  const req: BackupRunReq = {
    instanceUuid: plan.instanceUuid,
    plan: {
      id: plan.id,
      name: plan.name,
      include: plan.include,
      exclude: plan.exclude,
      retention: plan.retention,
      destinationIds: plan.destinationIds,
      minecraftSaveHook: plan.minecraftSaveHook
    },
    destinations: await plainDestinationsFor(plan.destinationIds),
    trigger,
    ...(initiatedBy ? { initiatedBy } : {}),
    ...(instanceName ? { instanceName } : {})
  };
  return daemonRequest<BackupRunRes>(plan.daemonId, BACKUP_PROTOCOL.RUN, req, 30_000);
}

export async function getRecords(daemonId: string, instanceUuid: string): Promise<BackupRecord[]> {
  const res = await daemonRequest<BackupRecordsRes>(daemonId, BACKUP_PROTOCOL.RECORDS, {
    instanceUuid
  });
  return Array.isArray(res?.records) ? res.records : [];
}

export async function getJobs(daemonId: string, instanceUuid: string): Promise<BackupStatusRes> {
  const res = await daemonRequest<BackupStatusRes>(daemonId, BACKUP_PROTOCOL.STATUS, {
    instanceUuid
  });
  return { running: res?.running, queued: Array.isArray(res?.queued) ? res.queued : [] };
}

export async function cancelJob(daemonId: string, instanceUuid: string, backupId: string) {
  if (!isValidBackupId(backupId))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "backupId",
      code: BackupValidationCode.INVALID_ID
    });
  return daemonRequest<BackupCancelRes>(daemonId, BACKUP_PROTOCOL.CANCEL, {
    instanceUuid,
    backupId
  });
}

async function destinationsForRecord(record: BackupRecord, localOnly = false) {
  const destinations: PlainBackupDestination[] = [];
  for (const [id, copy] of Object.entries(record.copies)) {
    if (copy.status !== "ok" || (localOnly && copy.type !== "local")) continue;
    const destination = await getStoredDestination(id);
    if (destination && (!localOnly || destination.type === "local")) {
      destinations.push(toPlainDestination(destination));
    }
  }
  return destinations;
}

/** Restore: admin only (router), instance must be stopped (checked here), then `backup/restore`. */
export async function restoreRecord(
  daemonId: string,
  instanceUuid: string,
  recordId: string
): Promise<BackupRestoreRes> {
  if (!isValidBackupId(recordId))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "recordId",
      code: BackupValidationCode.INVALID_ID
    });
  const detail = await daemonRequest<{ status?: number }>(daemonId, "instance/detail", {
    instanceUuid
  });
  if (detail?.status !== INSTANCE_STATUS_STOP)
    throw new BackupServiceError(BackupErrorCode.INSTANCE_MUST_BE_STOPPED, 409);
  const records = await getRecords(daemonId, instanceUuid);
  const record = records.find((r) => r.id === recordId);
  if (!record) throw new BackupServiceError(BackupErrorCode.RECORD_NOT_FOUND, 404);
  const destinations = await destinationsForRecord(record);
  return daemonRequest<BackupRestoreRes>(
    daemonId,
    BACKUP_PROTOCOL.RESTORE,
    { instanceUuid, recordId, destinations },
    30_000
  );
}

export async function requestDownloadTicket(
  daemonId: string,
  instanceUuid: string,
  recordId: string
): Promise<BackupDownloadTicketRes> {
  if (!isValidBackupId(recordId))
    throw new BackupServiceError("VALIDATION", 400, {
      field: "recordId",
      code: BackupValidationCode.INVALID_ID
    });
  const records = await getRecords(daemonId, instanceUuid);
  const record = records.find((r) => r.id === recordId);
  const req: BackupDownloadTicketReq = {
    instanceUuid,
    recordId,
    destinations: record ? await destinationsForRecord(record, true) : []
  };
  return daemonRequest<BackupDownloadTicketRes>(daemonId, BACKUP_PROTOCOL.DOWNLOAD_TICKET, req);
}

// ---------------------------------------------------------------------------
// "Backup now" rate limit (regular users): 1 request / 60 s per user per plan
// ---------------------------------------------------------------------------

const lastRun = new Map<string, number>();

/** Returns false when the user must wait. Reserves the slot when it returns true. */
export function reserveRunSlot(userUuid: string, planId: string, now = Date.now()): boolean {
  if (lastRun.size > 2000) {
    for (const [k, t] of lastRun) if (now - t >= BACKUP_NOW_RATE_LIMIT_MS) lastRun.delete(k);
  }
  const key = `${userUuid}:${planId}`;
  const prev = lastRun.get(key);
  if (prev !== undefined && now - prev < BACKUP_NOW_RATE_LIMIT_MS) return false;
  lastRun.set(key, now);
  return true;
}

export function releaseRunSlot(userUuid: string, planId: string) {
  lastRun.delete(`${userUuid}:${planId}`);
}

export function resetRunSlotsForTest() {
  lastRun.clear();
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// OAuth result storage
// ---------------------------------------------------------------------------

/**
 * Store the refresh token obtained by the OAuth callback. `expectedClientId` guards against the
 * destination having been re-pointed at another client while the consent screen was open.
 */
export async function storeRefreshToken(
  destinationId: string,
  expectedClientId: string,
  refreshToken: string
): Promise<void> {
  await execWithMutexId(CONFIG_MUTEX, async () => {
    const dest = await getStoredDestination(destinationId);
    if (
      !dest ||
      dest.type !== "gdrive" ||
      dest.config.authMethod !== "oauth" ||
      dest.config.clientId !== expectedClientId
    ) {
      throw new BackupServiceError("OAUTH_DESTINATION_CHANGED", 409);
    }
    (dest.secrets as Record<string, unknown>).refreshToken = encryptSecret(refreshToken);
    dest.updatedAt = Date.now();
    await storeDoc(BACKUP_DESTINATION_CATEGORY, dest.id, dest);
  });
}
