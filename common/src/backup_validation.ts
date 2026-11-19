/**
 * Pure validators for the `instance-backups` change (no fs, no network).
 *
 * Every validator returns a `BackupValidationResult`; failures carry a string-enum code the panel
 * translates, the offending `field` and (for list items) the `index`. Validators take `unknown`
 * so they can be applied directly to request bodies. They fail fast (first problem only).
 *
 * ## Include path rules (relative to the instance working directory)
 * - string, 1..256 chars, at most 32 segments, no NUL / control characters
 * - separators `/` and `\` are both treated as separators and normalised to `/`
 * - not absolute: no leading `/` or `\`, no drive letter (`C:`), no UNC (`\\server`)
 * - no `:` `<` `>` `"` `|` `?` `*` anywhere (Windows-invalid / glob characters; paths are literal)
 * - no `..` segment (checked after splitting, so `a/../../b` is rejected, not normalised away)
 * - no percent-encoded `.` `/` `\` (`%2e`, `%2f`, `%5c`, any case) - rejected outright
 * - no segment made only of dots/spaces other than a single `.` (Windows quirks such as `...`)
 * - `.` and empty segments are dropped by `normalizeBackupIncludePath`; `.` alone = whole directory
 * - the daemon MUST still re-check against the real directory (symlinks) at job time
 *
 * ## Exclude glob syntax (bounded subset, linear-ish matcher, no regex is ever built)
 * - patterns use `/` separators, 1..256 chars, at most 32 segments, no NUL / control / `\`
 * - `*`  matches any run of characters inside one segment (not `/`)
 * - `?`  matches exactly one character inside one segment
 * - `**` is allowed only as a whole segment and matches zero or more segments
 * - everything else is literal and case-sensitive; `[ ] { }` and a leading `!` are rejected
 * - a pattern WITHOUT `/` matches any path segment at any depth (like `.gitignore`: `cache`
 *   excludes `a/cache/x`, `*.tmp` excludes every `.tmp` file)
 * - a pattern WITH `/` is anchored at the instance root: `plugins/*.jar`
 * - a trailing `/` is ignored. If a pattern matches a path or any of its ancestor directories the
 *   path is excluded
 * - matching a segment is O(pattern x segment) (two-pointer wildcard algorithm, no backtracking
 *   blowup) and `**` handling is a DP over (pattern segments x path segments)
 */
import {
  BACKUP_DESTINATION_TYPES,
  BACKUP_LIMITS,
  BACKUP_PRESET_NAMES,
  BACKUP_SECRET_MASK,
  isValidBackupId
} from "./backup";

/** Typed validation error codes. The panel maps each to an i18n key. */
export enum BackupValidationCode {
  // generic
  NOT_AN_OBJECT = "NOT_AN_OBJECT",
  INVALID_ID = "INVALID_ID",
  NAME_INVALID = "NAME_INVALID",
  // include paths
  INCLUDE_NOT_ARRAY = "INCLUDE_NOT_ARRAY",
  INCLUDE_EMPTY_LIST = "INCLUDE_EMPTY_LIST",
  INCLUDE_TOO_MANY = "INCLUDE_TOO_MANY",
  INCLUDE_NOT_STRING = "INCLUDE_NOT_STRING",
  INCLUDE_EMPTY = "INCLUDE_EMPTY",
  INCLUDE_TOO_LONG = "INCLUDE_TOO_LONG",
  INCLUDE_TOO_DEEP = "INCLUDE_TOO_DEEP",
  INCLUDE_CONTROL_CHAR = "INCLUDE_CONTROL_CHAR",
  INCLUDE_ABSOLUTE = "INCLUDE_ABSOLUTE",
  INCLUDE_TRAVERSAL = "INCLUDE_TRAVERSAL",
  INCLUDE_ENCODED_TRAVERSAL = "INCLUDE_ENCODED_TRAVERSAL",
  INCLUDE_ILLEGAL_CHAR = "INCLUDE_ILLEGAL_CHAR",
  INCLUDE_ILLEGAL_SEGMENT = "INCLUDE_ILLEGAL_SEGMENT",
  INCLUDE_DUPLICATE = "INCLUDE_DUPLICATE",
  // exclude globs
  EXCLUDE_NOT_ARRAY = "EXCLUDE_NOT_ARRAY",
  EXCLUDE_TOO_MANY = "EXCLUDE_TOO_MANY",
  EXCLUDE_NOT_STRING = "EXCLUDE_NOT_STRING",
  EXCLUDE_EMPTY = "EXCLUDE_EMPTY",
  EXCLUDE_TOO_LONG = "EXCLUDE_TOO_LONG",
  EXCLUDE_TOO_DEEP = "EXCLUDE_TOO_DEEP",
  EXCLUDE_CONTROL_CHAR = "EXCLUDE_CONTROL_CHAR",
  EXCLUDE_ABSOLUTE = "EXCLUDE_ABSOLUTE",
  EXCLUDE_TRAVERSAL = "EXCLUDE_TRAVERSAL",
  EXCLUDE_UNSUPPORTED_SYNTAX = "EXCLUDE_UNSUPPORTED_SYNTAX",
  EXCLUDE_EMPTY_SEGMENT = "EXCLUDE_EMPTY_SEGMENT",
  // retention / schedule
  RETENTION_INVALID = "RETENTION_INVALID",
  SCHEDULE_INVALID = "SCHEDULE_INVALID",
  SCHEDULE_KIND_INVALID = "SCHEDULE_KIND_INVALID",
  SCHEDULE_INTERVAL_INVALID = "SCHEDULE_INTERVAL_INVALID",
  SCHEDULE_CRON_INVALID = "SCHEDULE_CRON_INVALID",
  // plan
  PLAN_PRESET_INVALID = "PLAN_PRESET_INVALID",
  PLAN_DESTINATIONS_INVALID = "PLAN_DESTINATIONS_INVALID",
  PLAN_DESTINATIONS_COUNT = "PLAN_DESTINATIONS_COUNT",
  PLAN_DESTINATIONS_DUPLICATE = "PLAN_DESTINATIONS_DUPLICATE",
  PLAN_FLAG_INVALID = "PLAN_FLAG_INVALID",
  // destination (common)
  DEST_TYPE_INVALID = "DEST_TYPE_INVALID",
  DEST_CONFIG_INVALID = "DEST_CONFIG_INVALID",
  DEST_SECRETS_INVALID = "DEST_SECRETS_INVALID",
  DEST_SECRET_MISSING = "DEST_SECRET_MISSING",
  // local
  LOCAL_DIRECTORY_INVALID = "LOCAL_DIRECTORY_INVALID",
  LOCAL_MAX_SIZE_INVALID = "LOCAL_MAX_SIZE_INVALID",
  // s3
  S3_ENDPOINT_INVALID = "S3_ENDPOINT_INVALID",
  S3_ENDPOINT_SCHEME = "S3_ENDPOINT_SCHEME",
  S3_ENDPOINT_CREDENTIALS = "S3_ENDPOINT_CREDENTIALS",
  S3_ENDPOINT_EXTRAS = "S3_ENDPOINT_EXTRAS",
  S3_ENDPOINT_HOST_NOT_ALLOWED = "S3_ENDPOINT_HOST_NOT_ALLOWED",
  S3_REGION_INVALID = "S3_REGION_INVALID",
  S3_BUCKET_INVALID = "S3_BUCKET_INVALID",
  S3_PREFIX_INVALID = "S3_PREFIX_INVALID",
  S3_ACCESS_KEY_INVALID = "S3_ACCESS_KEY_INVALID",
  S3_FLAG_INVALID = "S3_FLAG_INVALID",
  // gdrive
  GDRIVE_AUTH_METHOD_INVALID = "GDRIVE_AUTH_METHOD_INVALID",
  GDRIVE_CLIENT_ID_INVALID = "GDRIVE_CLIENT_ID_INVALID",
  GDRIVE_FOLDER_ID_INVALID = "GDRIVE_FOLDER_ID_INVALID",
  GDRIVE_SERVICE_ACCOUNT_INVALID = "GDRIVE_SERVICE_ACCOUNT_INVALID"
}

/** Result of a validator. */
export type BackupValidationResult =
  | { ok: true }
  | { ok: false; code: BackupValidationCode; field: string; index?: number };

const OK: BackupValidationResult = { ok: true };

function fail(code: BackupValidationCode, field: string, index?: number): BackupValidationResult {
  return index === undefined ? { ok: false, code, field } : { ok: false, code, field, index };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Include paths
// ---------------------------------------------------------------------------

/** Returns the failure code for one include path, or null when it is valid. */
export function checkBackupIncludePath(value: unknown): BackupValidationCode | null {
  if (typeof value !== "string") return BackupValidationCode.INCLUDE_NOT_STRING;
  if (value.length === 0) return BackupValidationCode.INCLUDE_EMPTY;
  if (value.length > BACKUP_LIMITS.MAX_PATH_LENGTH) return BackupValidationCode.INCLUDE_TOO_LONG;
  if (CONTROL_CHARS.test(value)) return BackupValidationCode.INCLUDE_CONTROL_CHAR;
  if (/%2e|%2f|%5c/i.test(value)) return BackupValidationCode.INCLUDE_ENCODED_TRAVERSAL;
  // Absolute forms: "/x", "\x", "\\server\x", "C:\x", "C:x"
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return BackupValidationCode.INCLUDE_ABSOLUTE;
  }
  if (/[:<>"|?*]/.test(value)) return BackupValidationCode.INCLUDE_ILLEGAL_CHAR;
  const segments = value.split(/[\\/]/);
  if (segments.length > BACKUP_LIMITS.MAX_PATH_SEGMENTS)
    return BackupValidationCode.INCLUDE_TOO_DEEP;
  let meaningful = 0;
  for (const seg of segments) {
    if (seg === "..") return BackupValidationCode.INCLUDE_TRAVERSAL;
    if (seg === "" || seg === ".") continue;
    if (/^[. ]+$/.test(seg)) return BackupValidationCode.INCLUDE_ILLEGAL_SEGMENT;
    meaningful++;
  }
  // Only "." / "./" / "" segments: allowed only as the exact whole-directory forms.
  if (meaningful === 0 && value !== "." && value !== "./") {
    return BackupValidationCode.INCLUDE_ILLEGAL_SEGMENT;
  }
  return null;
}

/**
 * Normalise a VALID include path: `\` -> `/`, drop `.` and empty segments, `.` for the root.
 * Throws if the path is invalid (call `checkBackupIncludePath` first).
 */
export function normalizeBackupIncludePath(value: string): string {
  const code = checkBackupIncludePath(value);
  if (code) throw new Error(`Invalid include path: ${code}`);
  const parts = value.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  return parts.length === 0 ? "." : parts.join("/");
}

/** Validate the include list of a plan (1..50 entries, each valid, no duplicates after normalising). */
export function validateIncludePaths(value: unknown, field = "include"): BackupValidationResult {
  if (!Array.isArray(value)) return fail(BackupValidationCode.INCLUDE_NOT_ARRAY, field);
  if (value.length === 0) return fail(BackupValidationCode.INCLUDE_EMPTY_LIST, field);
  if (value.length > BACKUP_LIMITS.MAX_INCLUDE_PATHS) {
    return fail(BackupValidationCode.INCLUDE_TOO_MANY, field);
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const code = checkBackupIncludePath(value[i]);
    if (code) return fail(code, field, i);
    const normalized = normalizeBackupIncludePath(value[i] as string);
    if (seen.has(normalized)) return fail(BackupValidationCode.INCLUDE_DUPLICATE, field, i);
    seen.add(normalized);
  }
  return OK;
}

// ---------------------------------------------------------------------------
// Exclude globs
// ---------------------------------------------------------------------------

/** Returns the failure code for one exclude glob, or null when it is valid. */
export function checkBackupExcludeGlob(value: unknown): BackupValidationCode | null {
  if (typeof value !== "string") return BackupValidationCode.EXCLUDE_NOT_STRING;
  if (value.length === 0) return BackupValidationCode.EXCLUDE_EMPTY;
  if (value.length > BACKUP_LIMITS.MAX_PATH_LENGTH) return BackupValidationCode.EXCLUDE_TOO_LONG;
  if (CONTROL_CHARS.test(value)) return BackupValidationCode.EXCLUDE_CONTROL_CHAR;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return BackupValidationCode.EXCLUDE_ABSOLUTE;
  }
  if (/[[\]{}]/.test(value) || value.startsWith("!")) {
    return BackupValidationCode.EXCLUDE_UNSUPPORTED_SYNTAX;
  }
  const body = value.endsWith("/") ? value.slice(0, -1) : value;
  if (body.length === 0) return BackupValidationCode.EXCLUDE_EMPTY;
  const segments = body.split("/");
  if (segments.length > BACKUP_LIMITS.MAX_PATH_SEGMENTS)
    return BackupValidationCode.EXCLUDE_TOO_DEEP;
  for (const seg of segments) {
    if (seg === "") return BackupValidationCode.EXCLUDE_EMPTY_SEGMENT;
    if (seg === "..") return BackupValidationCode.EXCLUDE_TRAVERSAL;
    if (seg.includes("**") && seg !== "**") return BackupValidationCode.EXCLUDE_UNSUPPORTED_SYNTAX;
  }
  return null;
}

/** Validate the exclude list of a plan (0..50 entries, each a valid glob). */
export function validateExcludeGlobs(value: unknown, field = "exclude"): BackupValidationResult {
  if (!Array.isArray(value)) return fail(BackupValidationCode.EXCLUDE_NOT_ARRAY, field);
  if (value.length > BACKUP_LIMITS.MAX_EXCLUDE_GLOBS) {
    return fail(BackupValidationCode.EXCLUDE_TOO_MANY, field);
  }
  for (let i = 0; i < value.length; i++) {
    const code = checkBackupExcludeGlob(value[i]);
    if (code) return fail(code, field, i);
  }
  return OK;
}

/**
 * Match one path segment against a segment glob (`*`, `?`, literals). Iterative two-pointer
 * algorithm: O(pattern.length x text.length) worst case, no recursion, no regex.
 */
export function matchGlobSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

interface CompiledGlob {
  anchored: boolean;
  segments: string[];
}

function compileGlob(pattern: string): CompiledGlob {
  const body = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const segments = body.split("/");
  return { anchored: segments.length > 1, segments };
}

function splitPath(relPath: string): string[] {
  return relPath.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

/** Does the compiled anchored glob match some non-empty prefix (path or ancestor) of `path`? */
function anchoredMatchesPrefix(glob: string[], path: string[]): boolean {
  const n = glob.length;
  const closure = (set: Set<number>) => {
    for (let i = 0; i < n; i++) {
      if (set.has(i) && glob[i] === "**") set.add(i + 1);
    }
    return set;
  };
  let states = closure(new Set([0]));
  for (let i = 0; i < path.length; i++) {
    const next = new Set<number>();
    for (const s of states) {
      if (s >= n) continue;
      if (glob[s] === "**") next.add(s);
      else if (matchGlobSegment(glob[s], path[i])) next.add(s + 1);
    }
    if (next.size === 0) return false;
    states = closure(next);
    if (states.has(n)) return true;
  }
  return false;
}

/**
 * Compile exclude globs into a matcher over instance-relative paths (`/` or `\` separated).
 * Patterns must already be valid (`validateExcludeGlobs`); invalid ones throw. The returned
 * function is safe to call per file: cost is bounded by the pattern/path lengths.
 */
export function compileExcludeMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const compiled = patterns.map((p) => {
    const code = checkBackupExcludeGlob(p);
    if (code) throw new Error(`Invalid exclude glob: ${code}`);
    return compileGlob(p);
  });
  return (relPath: string): boolean => {
    const path = splitPath(relPath);
    if (path.length === 0) return false;
    for (const glob of compiled) {
      if (glob.anchored) {
        if (anchoredMatchesPrefix(glob.segments, path)) return true;
      } else {
        const seg = glob.segments[0];
        if (seg === "**") return true;
        for (const part of path) if (matchGlobSegment(seg, part)) return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Names, ids, retention, schedule
// ---------------------------------------------------------------------------

/** Validate a display name: string, 1..40 chars after trim, no control characters. */
export function validateBackupName(value: unknown, field = "name"): BackupValidationResult {
  if (typeof value !== "string") return fail(BackupValidationCode.NAME_INVALID, field);
  const name = value.trim();
  if (
    name.length < BACKUP_LIMITS.MIN_NAME_LENGTH ||
    name.length > BACKUP_LIMITS.MAX_NAME_LENGTH ||
    CONTROL_CHARS.test(name)
  ) {
    return fail(BackupValidationCode.NAME_INVALID, field);
  }
  return OK;
}

/** Validate retention: integer in 1..100. */
export function validateRetention(value: unknown, field = "retention"): BackupValidationResult {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < BACKUP_LIMITS.MIN_RETENTION ||
    value > BACKUP_LIMITS.MAX_RETENTION
  ) {
    return fail(BackupValidationCode.RETENTION_INVALID, field);
  }
  return OK;
}

const CRON_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
];

function isValidCronField(field: string, lo: number, hi: number): boolean {
  if (field.length === 0 || field.length > 40) return false;
  for (const item of field.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!m) return false;
    if (m[4] !== undefined && (Number(m[4]) < 1 || Number(m[4]) > hi)) return false;
    if (m[2] !== undefined) {
      const a = Number(m[2]);
      const b = m[3] !== undefined ? Number(m[3]) : a;
      if (a < lo || b > hi || a > b) return false;
    }
  }
  return true;
}

/**
 * Validate a cron expression: 5 fields (`min hour dom month dow`) or 6 fields (leading seconds).
 * Each field is a comma list of `*`, `n`, `a-b`, optionally with `/step`; digits only (no names,
 * no `?`). In the 6-field form the seconds field must be one plain number (0..59) so a plan
 * cannot fire faster than once a minute.
 */
export function isValidBackupCron(value: string): boolean {
  if (typeof value !== "string" || value.length > 100 || CONTROL_CHARS.test(value)) return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  if (fields.length === 6 && !(/^\d{1,2}$/.test(fields[0]) && Number(fields[0]) <= 59))
    return false;
  const body = fields.length === 6 ? fields.slice(1) : fields;
  return body.every((f, i) => isValidCronField(f, CRON_RANGES[i][0], CRON_RANGES[i][1]));
}

/** Validate an optional plan schedule (`undefined` / `null` = manual only). */
export function validateSchedule(value: unknown, field = "schedule"): BackupValidationResult {
  if (value === undefined || value === null) return OK;
  if (!isPlainObject(value)) return fail(BackupValidationCode.SCHEDULE_INVALID, field);
  if (typeof value.value !== "string") return fail(BackupValidationCode.SCHEDULE_INVALID, field);
  if (value.kind === "interval") {
    if (!/^\d{1,10}$/.test(value.value)) {
      return fail(BackupValidationCode.SCHEDULE_INTERVAL_INVALID, `${field}.value`);
    }
    const seconds = Number(value.value);
    if (
      seconds < BACKUP_LIMITS.MIN_INTERVAL_SECONDS ||
      seconds > BACKUP_LIMITS.MAX_INTERVAL_SECONDS
    ) {
      return fail(BackupValidationCode.SCHEDULE_INTERVAL_INVALID, `${field}.value`);
    }
    return OK;
  }
  if (value.kind === "cron") {
    return isValidBackupCron(value.value)
      ? OK
      : fail(BackupValidationCode.SCHEDULE_CRON_INVALID, `${field}.value`);
  }
  return fail(BackupValidationCode.SCHEDULE_KIND_INVALID, `${field}.kind`);
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Options for `validatePlan`. */
export interface ValidatePlanOptions {
  /**
   * Require `id`, `daemonId` and `instanceUuid` to be present and valid (stored plans). For a
   * create request leave false: they are checked only if present.
   */
  requireIdentity?: boolean;
}

/**
 * Validate a plan (already preset-expanded: `include` is the concrete list). Checks name, preset,
 * include, exclude, schedule, retention, destination ids (1..5, valid, unique) and flags.
 */
export function validatePlan(
  plan: unknown,
  options: ValidatePlanOptions = {}
): BackupValidationResult {
  if (!isPlainObject(plan)) return fail(BackupValidationCode.NOT_AN_OBJECT, "plan");
  for (const key of ["id", "daemonId", "instanceUuid"] as const) {
    const v = plan[key];
    if (v === undefined) {
      if (options.requireIdentity) return fail(BackupValidationCode.INVALID_ID, key);
    } else if (!isValidBackupId(v)) {
      return fail(BackupValidationCode.INVALID_ID, key);
    }
  }
  let r = validateBackupName(plan.name);
  if (!r.ok) return r;
  if (!BACKUP_PRESET_NAMES.includes(plan.preset as never)) {
    return fail(BackupValidationCode.PLAN_PRESET_INVALID, "preset");
  }
  r = validateIncludePaths(plan.include);
  if (!r.ok) return r;
  r = validateExcludeGlobs(plan.exclude ?? []);
  if (!r.ok) return r;
  r = validateSchedule(plan.schedule);
  if (!r.ok) return r;
  r = validateRetention(plan.retention);
  if (!r.ok) return r;
  r = validateDestinationIds(plan.destinationIds);
  if (!r.ok) return r;
  if (typeof plan.minecraftSaveHook !== "boolean") {
    return fail(BackupValidationCode.PLAN_FLAG_INVALID, "minecraftSaveHook");
  }
  if (typeof plan.enabled !== "boolean")
    return fail(BackupValidationCode.PLAN_FLAG_INVALID, "enabled");
  return OK;
}

/** Validate a plan's destination id list: array of 1..5 unique valid ids. */
export function validateDestinationIds(
  value: unknown,
  field = "destinationIds"
): BackupValidationResult {
  if (!Array.isArray(value)) return fail(BackupValidationCode.PLAN_DESTINATIONS_INVALID, field);
  if (
    value.length < BACKUP_LIMITS.MIN_DESTINATIONS_PER_PLAN ||
    value.length > BACKUP_LIMITS.MAX_DESTINATIONS_PER_PLAN
  ) {
    return fail(BackupValidationCode.PLAN_DESTINATIONS_COUNT, field);
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    if (!isValidBackupId(value[i])) return fail(BackupValidationCode.INVALID_ID, field, i);
    if (seen.has(value[i])) return fail(BackupValidationCode.PLAN_DESTINATIONS_DUPLICATE, field, i);
    seen.add(value[i]);
  }
  return OK;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** Options for `validateDestination`. */
export interface ValidateDestinationOptions {
  /**
   * Treat `BACKUP_SECRET_MASK` as "keep the stored secret" (update requests). When false a masked
   * value is rejected (a create request must carry real secrets).
   */
  allowMaskedSecrets?: boolean;
  /** Require a non-empty secret where the type needs one (create / test). Default true. */
  requireSecrets?: boolean;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[A-Za-z0-9-]{1,32}$/;
const ACCESS_KEY_RE = /^[A-Za-z0-9_.\-/+=]{3,128}$/;
const GDRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
const GDRIVE_CLIENT_ID_RE = /^[A-Za-z0-9._-]{5,256}$/;
const PREFIX_RE = /^[A-Za-z0-9._\-/]+$/;

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Validate an S3 endpoint string against the shape rules (spec "S3 endpoint safety"). */
export function validateS3Endpoint(
  value: unknown,
  allowPrivateNetwork: boolean,
  field = "config.endpoint"
): BackupValidationResult {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > BACKUP_LIMITS.MAX_ENDPOINT_LENGTH
  ) {
    return fail(BackupValidationCode.S3_ENDPOINT_INVALID, field);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    return fail(BackupValidationCode.S3_ENDPOINT_INVALID, field);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(BackupValidationCode.S3_ENDPOINT_INVALID, field);
  }
  const schemeOk = url.protocol === "https:" || (allowPrivateNetwork && url.protocol === "http:");
  if (!schemeOk) return fail(BackupValidationCode.S3_ENDPOINT_SCHEME, field);
  if (url.username || url.password)
    return fail(BackupValidationCode.S3_ENDPOINT_CREDENTIALS, field);
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    return fail(BackupValidationCode.S3_ENDPOINT_EXTRAS, field);
  }
  if (url.pathname !== "/" && url.pathname !== "")
    return fail(BackupValidationCode.S3_ENDPOINT_EXTRAS, field);
  const host = url.hostname.toLowerCase();
  if (!host) return fail(BackupValidationCode.S3_ENDPOINT_INVALID, field);
  // Always refused, even with allowPrivateNetwork (metadata / unspecified addresses).
  if (
    host === "0.0.0.0" ||
    host === "[::]" ||
    /^169\.254\./.test(host) ||
    /^\[fe80:/i.test(host) ||
    /^\[fd00:ec2:/i.test(host)
  ) {
    return fail(BackupValidationCode.S3_ENDPOINT_HOST_NOT_ALLOWED, field);
  }
  if (!allowPrivateNetwork) {
    const looksLocal =
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      !host.includes(".") ||
      isIpv4Literal(host) ||
      host.startsWith("[");
    if (looksLocal) return fail(BackupValidationCode.S3_ENDPOINT_HOST_NOT_ALLOWED, field);
  }
  return OK;
}

/** Validate an S3 bucket name (3..63, lowercase letters/digits/dots/hyphens, not an IP). */
export function validateS3Bucket(value: unknown, field = "config.bucket"): BackupValidationResult {
  if (
    typeof value !== "string" ||
    !BUCKET_RE.test(value) ||
    value.includes("..") ||
    value.includes(".-") ||
    value.includes("-.") ||
    isIpv4Literal(value)
  ) {
    return fail(BackupValidationCode.S3_BUCKET_INVALID, field);
  }
  return OK;
}

/** Validate an optional S3 key prefix (<= 128 chars of `[A-Za-z0-9._-/]`, no leading `/`, no `..`, no `//`). */
export function validateS3Prefix(value: unknown, field = "config.prefix"): BackupValidationResult {
  if (value === undefined || value === null || value === "") return OK;
  if (typeof value !== "string" || value.length > 128 || !PREFIX_RE.test(value)) {
    return fail(BackupValidationCode.S3_PREFIX_INVALID, field);
  }
  if (value.startsWith("/") || value.includes("//"))
    return fail(BackupValidationCode.S3_PREFIX_INVALID, field);
  for (const seg of value.split("/")) {
    if (seg === ".." || seg === ".") return fail(BackupValidationCode.S3_PREFIX_INVALID, field);
  }
  return OK;
}

function validateLocalDirectory(value: unknown): BackupValidationResult {
  const field = "config.directory";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > BACKUP_LIMITS.MAX_DIRECTORY_LENGTH ||
    CONTROL_CHARS.test(value)
  ) {
    return fail(BackupValidationCode.LOCAL_DIRECTORY_INVALID, field);
  }
  const posix = value.startsWith("/") && !value.startsWith("//");
  const drive = /^[A-Za-z]:[\\/]/.test(value);
  if (!posix && !drive) return fail(BackupValidationCode.LOCAL_DIRECTORY_INVALID, field);
  const rest = drive ? value.slice(3) : value.slice(1);
  const segments = value.split(/[\\/]/);
  if (segments.includes("..")) return fail(BackupValidationCode.LOCAL_DIRECTORY_INVALID, field);
  if (/[<>"|?*]/.test(rest) || (drive && rest.includes(":")) || (!drive && value.includes("\\"))) {
    return fail(BackupValidationCode.LOCAL_DIRECTORY_INVALID, field);
  }
  // The filesystem root itself is refused.
  if (rest.split(/[\\/]/).filter((s) => s && s !== ".").length === 0) {
    return fail(BackupValidationCode.LOCAL_DIRECTORY_INVALID, field);
  }
  return OK;
}

function checkSecret(
  secrets: Record<string, unknown>,
  key: string,
  required: boolean,
  opts: ValidateDestinationOptions,
  maxLength = 4096
): BackupValidationResult {
  const field = `secrets.${key}`;
  const v = secrets[key];
  if (v === undefined || v === null || v === "") {
    return required && opts.requireSecrets !== false
      ? fail(BackupValidationCode.DEST_SECRET_MISSING, field)
      : OK;
  }
  if (
    typeof v !== "string" ||
    v.length > maxLength ||
    CONTROL_CHARS.test(v.replace(/[\r\n\t]/g, ""))
  ) {
    return fail(BackupValidationCode.DEST_SECRETS_INVALID, field);
  }
  if (v === BACKUP_SECRET_MASK) {
    return opts.allowMaskedSecrets ? OK : fail(BackupValidationCode.DEST_SECRETS_INVALID, field);
  }
  return OK;
}

function validateServiceAccountJson(value: unknown): BackupValidationResult {
  const field = "secrets.serviceAccountJson";
  if (typeof value !== "string" || value.length > BACKUP_LIMITS.MAX_SERVICE_ACCOUNT_JSON_LENGTH) {
    return fail(BackupValidationCode.GDRIVE_SERVICE_ACCOUNT_INVALID, field);
  }
  try {
    const parsed = JSON.parse(value);
    if (
      !isPlainObject(parsed) ||
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string" ||
      !/^[^\s@]+@[^\s@]+$/.test(parsed.client_email) ||
      !parsed.private_key.includes("PRIVATE KEY")
    ) {
      return fail(BackupValidationCode.GDRIVE_SERVICE_ACCOUNT_INVALID, field);
    }
  } catch {
    return fail(BackupValidationCode.GDRIVE_SERVICE_ACCOUNT_INVALID, field);
  }
  return OK;
}

/**
 * Validate a destination request body (`type`, `name`, `config`, `secrets`; `id` only if present).
 * Type-specific shape rules:
 * - local: absolute `directory` (POSIX `/x` or `C:\x`, no `..`, not a root, no UNC), `maxTotalBytes`
 *   a positive safe integer. Administrator-only input per design D6/D8; the daemon must re-check.
 * - s3: endpoint (https; http+IP literals only with allowPrivateNetwork), region, bucket, optional
 *   prefix, boolean flags, accessKeyId; secret `secretAccessKey` required.
 * - gdrive: `authMethod`; oauth needs clientId + clientSecret (refreshToken optional until
 *   connected; folderId optional); service_account needs folderId + serviceAccountJson.
 */
export function validateDestination(
  destination: unknown,
  options: ValidateDestinationOptions = {}
): BackupValidationResult {
  if (!isPlainObject(destination)) return fail(BackupValidationCode.NOT_AN_OBJECT, "destination");
  if (destination.id !== undefined && !isValidBackupId(destination.id)) {
    return fail(BackupValidationCode.INVALID_ID, "id");
  }
  if (!BACKUP_DESTINATION_TYPES.includes(destination.type as never)) {
    return fail(BackupValidationCode.DEST_TYPE_INVALID, "type");
  }
  let r = validateBackupName(destination.name);
  if (!r.ok) return r;
  if (!isPlainObject(destination.config))
    return fail(BackupValidationCode.DEST_CONFIG_INVALID, "config");
  const secretsRaw = destination.secrets ?? {};
  if (!isPlainObject(secretsRaw)) return fail(BackupValidationCode.DEST_SECRETS_INVALID, "secrets");
  const config = destination.config;
  const secrets = secretsRaw;

  switch (destination.type) {
    case "local": {
      r = validateLocalDirectory(config.directory);
      if (!r.ok) return r;
      const max = config.maxTotalBytes;
      if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
        return fail(BackupValidationCode.LOCAL_MAX_SIZE_INVALID, "config.maxTotalBytes");
      }
      return OK;
    }
    case "s3": {
      for (const key of ["pathStyle", "allowPrivateNetwork"] as const) {
        if (typeof config[key] !== "boolean")
          return fail(BackupValidationCode.S3_FLAG_INVALID, `config.${key}`);
      }
      r = validateS3Endpoint(config.endpoint, config.allowPrivateNetwork === true);
      if (!r.ok) return r;
      if (typeof config.region !== "string" || !REGION_RE.test(config.region)) {
        return fail(BackupValidationCode.S3_REGION_INVALID, "config.region");
      }
      r = validateS3Bucket(config.bucket);
      if (!r.ok) return r;
      r = validateS3Prefix(config.prefix);
      if (!r.ok) return r;
      if (typeof config.accessKeyId !== "string" || !ACCESS_KEY_RE.test(config.accessKeyId)) {
        return fail(BackupValidationCode.S3_ACCESS_KEY_INVALID, "config.accessKeyId");
      }
      return checkSecret(secrets, "secretAccessKey", true, options, 256);
    }
    case "gdrive": {
      if (config.authMethod !== "oauth" && config.authMethod !== "service_account") {
        return fail(BackupValidationCode.GDRIVE_AUTH_METHOD_INVALID, "config.authMethod");
      }
      if (config.folderId !== undefined && config.folderId !== "") {
        if (typeof config.folderId !== "string" || !GDRIVE_ID_RE.test(config.folderId)) {
          return fail(BackupValidationCode.GDRIVE_FOLDER_ID_INVALID, "config.folderId");
        }
      }
      if (config.connectedEmail !== undefined && config.connectedEmail !== "") {
        if (
          typeof config.connectedEmail !== "string" ||
          config.connectedEmail.length > 254 ||
          CONTROL_CHARS.test(config.connectedEmail)
        ) {
          return fail(BackupValidationCode.DEST_CONFIG_INVALID, "config.connectedEmail");
        }
      }
      if (config.authMethod === "oauth") {
        if (typeof config.clientId !== "string" || !GDRIVE_CLIENT_ID_RE.test(config.clientId)) {
          return fail(BackupValidationCode.GDRIVE_CLIENT_ID_INVALID, "config.clientId");
        }
        r = checkSecret(secrets, "clientSecret", true, options, 512);
        if (!r.ok) return r;
        return checkSecret(secrets, "refreshToken", false, options, 2048);
      }
      if (!config.folderId)
        return fail(BackupValidationCode.GDRIVE_FOLDER_ID_INVALID, "config.folderId");
      const sa = secrets.serviceAccountJson;
      if (sa === BACKUP_SECRET_MASK && options.allowMaskedSecrets) return OK;
      if (sa === undefined || sa === null || sa === "") {
        return options.requireSecrets === false
          ? OK
          : fail(BackupValidationCode.DEST_SECRET_MISSING, "secrets.serviceAccountJson");
      }
      return validateServiceAccountJson(sa);
    }
  }
  return fail(BackupValidationCode.DEST_TYPE_INVALID, "type");
}
