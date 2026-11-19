import crypto from "node:crypto";
import { BACKUP_OAUTH_STATE_TTL_MS, sanitizeBackupError } from "mcsmanager-common";
import { decryptSecret, isEncryptedSecret } from "./backup_secret";
import {
  BackupServiceError,
  buildRedirectUri,
  getStoredDestination,
  storeRefreshToken,
  validateRedirectBaseUrl
} from "./backup_service";
import { logger } from "./log";

// Google OAuth 2.0 (authorization code flow) for "gdrive" destinations with authMethod "oauth".
// Google hosts are hardcoded; the redirect URI comes from the destination's `redirectBaseUrl`
// (admin configured), never from request headers.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const MAX_PENDING_STATES = 200;
const TOKEN_TIMEOUT_MS = 15_000;

interface PendingState {
  destinationId: string;
  clientId: string;
  /** panel user uuid of the administrator who started the flow */
  userUuid: string;
  exp: number;
}

const pending = new Map<string, PendingState>();

function prune(now: number) {
  for (const [k, v] of pending) if (v.exp <= now) pending.delete(k);
}

/** Start a flow: returns the Google consent URL. The `state` is bound to the admin and destination. */
export async function createGDriveConnectUrl(
  destinationId: string,
  userUuid: string,
  now = Date.now()
): Promise<string> {
  const dest = await getStoredDestination(destinationId);
  if (!dest) throw new BackupServiceError("DESTINATION_NOT_FOUND", 404);
  if (dest.type !== "gdrive" || dest.config.authMethod !== "oauth")
    throw new BackupServiceError("OAUTH_NOT_APPLICABLE", 400);
  const clientId = dest.config.clientId;
  const redirectBaseUrl = (dest.config as { redirectBaseUrl?: string }).redirectBaseUrl;
  if (!clientId || !isEncryptedSecret(dest.secrets.clientSecret))
    throw new BackupServiceError("OAUTH_CLIENT_MISSING", 400);
  if (!validateRedirectBaseUrl(redirectBaseUrl))
    throw new BackupServiceError("OAUTH_REDIRECT_BASE_URL_MISSING", 400);

  prune(now);
  if (pending.size >= MAX_PENDING_STATES)
    throw new BackupServiceError("OAUTH_TOO_MANY_PENDING", 429);
  const state = crypto.randomBytes(16).toString("hex"); // 128 bit
  pending.set(state, { destinationId, clientId, userUuid, exp: now + BACKUP_OAUTH_STATE_TTL_MS });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", buildRedirectUri(redirectBaseUrl as string));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  // offline + consent: Google always returns a refresh token
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Single use: the state is removed on the first lookup whatever the outcome, so a leaked value
 * cannot be retried from another session.
 */
export function consumeState(state: unknown, userUuid: string, now = Date.now()): PendingState {
  if (typeof state !== "string" || !/^[a-f0-9]{32}$/.test(state))
    throw new BackupServiceError("OAUTH_STATE_INVALID", 400);
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.exp <= now) throw new BackupServiceError("OAUTH_STATE_INVALID", 400);
  if (!userUuid || entry.userUuid !== userUuid)
    throw new BackupServiceError("OAUTH_STATE_INVALID", 400);
  return entry;
}

type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;
let tokenFetch: TokenFetch = (url, init) => fetch(url, init);
/** Test hook (the URL passed is always GOOGLE_TOKEN_URL). */
export function setGoogleTokenFetchForTest(fn: TokenFetch | null) {
  tokenFetch = fn ?? ((url, init) => fetch(url, init));
}

/** Complete the flow: validates state + session, exchanges the code, stores the refresh token. */
export async function completeGDriveConnect(
  code: unknown,
  state: unknown,
  userUuid: string
): Promise<{ destinationId: string }> {
  const entry = consumeState(state, userUuid);
  if (typeof code !== "string" || code.length === 0 || code.length > 2048)
    throw new BackupServiceError("OAUTH_CODE_INVALID", 400);
  const dest = await getStoredDestination(entry.destinationId);
  if (
    !dest ||
    dest.type !== "gdrive" ||
    dest.config.authMethod !== "oauth" ||
    dest.config.clientId !== entry.clientId ||
    !isEncryptedSecret(dest.secrets.clientSecret)
  ) {
    throw new BackupServiceError("OAUTH_DESTINATION_CHANGED", 409);
  }
  const redirectBaseUrl = (dest.config as { redirectBaseUrl?: string }).redirectBaseUrl;
  if (!validateRedirectBaseUrl(redirectBaseUrl))
    throw new BackupServiceError("OAUTH_REDIRECT_BASE_URL_MISSING", 400);
  const clientSecret = decryptSecret(dest.secrets.clientSecret);

  const body = new URLSearchParams({
    code,
    client_id: entry.clientId,
    client_secret: clientSecret,
    redirect_uri: buildRedirectUri(redirectBaseUrl as string),
    grant_type: "authorization_code"
  });
  let json: { refresh_token?: unknown };
  try {
    const res = await tokenFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    });
    if (!res.ok) {
      logger.warn(`[Backup] Google token exchange rejected (HTTP ${res.status})`);
      throw new BackupServiceError("OAUTH_EXCHANGE_FAILED", 502);
    }
    json = (await res.json()) as { refresh_token?: unknown };
  } catch (err) {
    if (err instanceof BackupServiceError) throw err;
    logger.warn(
      `[Backup] Google token exchange failed: ${sanitizeBackupError(err, [clientSecret, code])}`
    );
    throw new BackupServiceError("OAUTH_EXCHANGE_FAILED", 502);
  }
  const refreshToken = json?.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > 2048)
    throw new BackupServiceError("OAUTH_NO_REFRESH_TOKEN", 502);
  await storeRefreshToken(entry.destinationId, entry.clientId, refreshToken);
  return { destinationId: entry.destinationId };
}

export function pendingStateCountForTest() {
  return pending.size;
}
export function clearStatesForTest() {
  pending.clear();
}
