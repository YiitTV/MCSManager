// Client-side mirror of `common/src/backup_validation.ts` (relative paths, globs, schedule,
// retention). The server always re-validates; this only gives early feedback.
// Each checker returns an error code (suffix of the `TXT_CODE_backup_ui.err_*` i18n keys) or null.
import { BACKUP_LIMITS } from "@/types/backup";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function checkIncludePath(value: string): string | null {
  if (value.length === 0) return "empty";
  if (value.length > BACKUP_LIMITS.MAX_PATH_LENGTH) return "tooLong";
  if (CONTROL_CHARS.test(value)) return "controlChar";
  if (/%2e|%2f|%5c/i.test(value)) return "traversal";
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return "absolute";
  }
  if (/[:<>"|?*]/.test(value)) return "illegalChar";
  const segments = value.split(/[\\/]/);
  if (segments.length > BACKUP_LIMITS.MAX_PATH_SEGMENTS) return "tooDeep";
  let meaningful = 0;
  for (const seg of segments) {
    if (seg === "..") return "traversal";
    if (seg === "" || seg === ".") continue;
    if (/^[. ]+$/.test(seg)) return "illegalSegment";
    meaningful++;
  }
  if (meaningful === 0 && value !== "." && value !== "./") return "illegalSegment";
  return null;
}

export function normalizeIncludePath(value: string): string {
  const parts = value.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  return parts.length === 0 ? "." : parts.join("/");
}

export function checkExcludeGlob(value: string): string | null {
  if (value.length === 0) return "empty";
  if (value.length > BACKUP_LIMITS.MAX_PATH_LENGTH) return "tooLong";
  if (CONTROL_CHARS.test(value)) return "controlChar";
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "absolute";
  if (/[[\]{}]/.test(value) || value.startsWith("!")) return "unsupportedGlob";
  const body = value.endsWith("/") ? value.slice(0, -1) : value;
  if (body.length === 0) return "empty";
  const segments = body.split("/");
  if (segments.length > BACKUP_LIMITS.MAX_PATH_SEGMENTS) return "tooDeep";
  for (const seg of segments) {
    if (seg === "") return "emptySegment";
    if (seg === "..") return "traversal";
    if (seg.includes("**") && seg !== "**") return "unsupportedGlob";
  }
  return null;
}

/** Returns an error code for the whole include list (or for the candidate being added). */
export function checkIncludeList(list: string[]): string | null {
  if (list.length === 0) return "includeEmptyList";
  if (list.length > BACKUP_LIMITS.MAX_INCLUDE_PATHS) return "tooMany";
  const seen = new Set<string>();
  for (const item of list) {
    const code = checkIncludePath(item);
    if (code) return code;
    const norm = normalizeIncludePath(item);
    if (seen.has(norm)) return "duplicate";
    seen.add(norm);
  }
  return null;
}

export function checkExcludeList(list: string[]): string | null {
  if (list.length > BACKUP_LIMITS.MAX_EXCLUDE_GLOBS) return "tooMany";
  for (const item of list) {
    const code = checkExcludeGlob(item);
    if (code) return code;
  }
  return null;
}

export function checkBackupName(value: string): string | null {
  const name = value.trim();
  if (
    name.length < BACKUP_LIMITS.MIN_NAME_LENGTH ||
    name.length > BACKUP_LIMITS.MAX_NAME_LENGTH ||
    CONTROL_CHARS.test(name)
  ) {
    return "name";
  }
  return null;
}

export function checkRetention(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < BACKUP_LIMITS.MIN_RETENTION ||
    value > BACKUP_LIMITS.MAX_RETENTION
  ) {
    return "retention";
  }
  return null;
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

export function isValidCron(value: string): boolean {
  if (value.length > 100 || CONTROL_CHARS.test(value)) return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  if (fields.length === 6 && !(/^\d{1,2}$/.test(fields[0]) && Number(fields[0]) <= 59)) {
    return false;
  }
  const body = fields.length === 6 ? fields.slice(1) : fields;
  return body.every((f, i) => isValidCronField(f, CRON_RANGES[i][0], CRON_RANGES[i][1]));
}

export function checkIntervalSeconds(seconds: number): string | null {
  if (
    !Number.isInteger(seconds) ||
    seconds < BACKUP_LIMITS.MIN_INTERVAL_SECONDS ||
    seconds > BACKUP_LIMITS.MAX_INTERVAL_SECONDS
  ) {
    return "interval";
  }
  return null;
}

export function checkDestinationCount(ids: string[]): string | null {
  if (
    ids.length < BACKUP_LIMITS.MIN_DESTINATIONS_PER_PLAN ||
    ids.length > BACKUP_LIMITS.MAX_DESTINATIONS_PER_PLAN
  ) {
    return "destinations";
  }
  return null;
}

// ---- destination form checks (mirror of validateDestination shape rules) ----

export function checkS3Endpoint(value: string, allowPrivate: boolean): string | null {
  if (!value || value.length > BACKUP_LIMITS.MAX_ENDPOINT_LENGTH || /\s/.test(value)) {
    return "endpoint";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "endpoint";
  }
  if (!(url.protocol === "https:" || (allowPrivate && url.protocol === "http:"))) {
    return "endpointScheme";
  }
  if (url.username || url.password || url.search || url.hash) return "endpoint";
  if (url.pathname !== "/" && url.pathname !== "") return "endpoint";
  const host = url.hostname.toLowerCase();
  if (host === "0.0.0.0" || /^169\.254\./.test(host) || host === "[::]") return "endpointHost";
  if (!allowPrivate) {
    const local =
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      !host.includes(".") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host.startsWith("[");
    if (local) return "endpointHost";
  }
  return null;
}

export function checkLocalDirectory(value: string): string | null {
  if (!value || value.length > BACKUP_LIMITS.MAX_DIRECTORY_LENGTH || CONTROL_CHARS.test(value)) {
    return "directory";
  }
  const posix = value.startsWith("/") && !value.startsWith("//");
  const drive = /^[A-Za-z]:[\\/]/.test(value);
  if (!posix && !drive) return "directory";
  if (value.split(/[\\/]/).includes("..")) return "directory";
  const rest = drive ? value.slice(3) : value.slice(1);
  if (rest.split(/[\\/]/).filter((s) => s && s !== ".").length === 0) return "directory";
  return null;
}

/** Panel public URL for the Google redirect URI: https (http only for localhost), no extras. */
export function checkRedirectBaseUrl(value: string): string | null {
  if (!value || value.length > 255 || /[\s\u0000-\u001f]/.test(value)) return "redirectUrl";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "redirectUrl";
  }
  const localDev =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDev) return "redirectUrl";
  if (url.username || url.password || url.search || url.hash) return "redirectUrl";
  return null;
}
