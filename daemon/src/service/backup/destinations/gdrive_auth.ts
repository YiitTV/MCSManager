// Google OAuth / service-account authentication for the Drive backup driver.
// Plain HTTPS over node:https + node:crypto. Hosts are hardcoded: oauth2.googleapis.com and
// www.googleapis.com. The only way to change them is the test seam below, which refuses to work
// outside a vitest run.
import crypto from "crypto";
import http from "http";
import https from "https";
import {
  BACKUP_TIMING,
  BackupDriverError,
  BackupDriverErrorCode,
  GDriveConfig,
  GDriveSecrets,
  sanitizeBackupError
} from "mcsmanager-common";

export interface GoogleEndpoints {
  /** OAuth token endpoint (also the JWT `aud`). */
  tokenUrl: string;
  /** Drive REST base, e.g. https://www.googleapis.com/drive/v3 */
  apiBase: string;
  /** Drive upload base, e.g. https://www.googleapis.com/upload/drive/v3 */
  uploadBase: string;
}

const PRODUCTION_ENDPOINTS: Readonly<GoogleEndpoints> = Object.freeze({
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBase: "https://www.googleapis.com/drive/v3",
  uploadBase: "https://www.googleapis.com/upload/drive/v3"
});

export const GOOGLE_SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";

let activeEndpoints: GoogleEndpoints = { ...PRODUCTION_ENDPOINTS };
let retryDelayOverride: ((attempt: number) => number) | undefined;

/** TEST ONLY. Throws unless running under vitest. Pass null to restore production endpoints. */
export function __setGoogleEndpointsForTests(
  endpoints: GoogleEndpoints | null,
  retryDelay?: (attempt: number) => number
): void {
  if (!process.env.VITEST) {
    throw new Error("Google endpoints can only be overridden in tests");
  }
  activeEndpoints = endpoints ? { ...endpoints } : { ...PRODUCTION_ENDPOINTS };
  retryDelayOverride = endpoints ? retryDelay : undefined;
}

export function getGoogleEndpoints(): Readonly<GoogleEndpoints> {
  return activeEndpoints;
}

export function getRetryDelayMs(attempt: number): number {
  return retryDelayOverride ? retryDelayOverride(attempt) : 500 * 2 ** attempt;
}

export function getProductionGoogleEndpoints(): Readonly<GoogleEndpoints> {
  return PRODUCTION_ENDPOINTS;
}

// ---------------------------------------------------------------------------
// Raw HTTP
// ---------------------------------------------------------------------------

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

export interface RawRequestOptions {
  method: string;
  headers?: Record<string, string | number>;
  body?: Buffer | string;
  signal?: AbortSignal;
}

function abortedError(): BackupDriverError {
  return new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted");
}

/** Send one request. Never follows redirects. Rejects with sanitized BackupDriverError. */
export function rawRequest(url: string, options: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortedError());
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reject(new BackupDriverError(BackupDriverErrorCode.FAILED, "Invalid request URL"));
    }
    const lib = target.protocol === "http:" ? http : https;
    const body =
      typeof options.body === "string" ? Buffer.from(options.body) : (options.body ?? undefined);
    const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
    if (body) headers["Content-Length"] = body.length;
    const req = lib.request(
      target,
      { method: options.method, headers, timeout: BACKUP_TIMING.REQUEST_TIMEOUT_MS },
      (res) => {
        cleanup();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      }
    );
    const onAbort = () => {
      req.destroy();
      reject(abortedError());
    };
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => {
      cleanup();
      reject(
        options.signal?.aborted
          ? abortedError()
          : new BackupDriverError(
              BackupDriverErrorCode.TRANSIENT,
              "Network error talking to Google"
            )
      );
    });
    req.end(body);
  });
}

/** Read a response body fully, bounded. */
export async function readBody(res: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res) {
      total += (chunk as Buffer).length;
      if (total <= maxBytes) chunks.push(chunk as Buffer);
    }
  } catch {
    throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "Network error talking to Google");
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

export interface GoogleTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Drop the cached token (after a 401). */
  invalidate(): void;
  /** Secret strings to scrub from error messages. */
  secrets(): string[];
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function parseServiceAccount(json: string, tokenUrl: string): ServiceAccountKey {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BackupDriverError(BackupDriverErrorCode.AUTH, "Service account JSON is invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    !/^[^\s@<>"']+@[^\s@<>"']+$/.test(parsed.client_email)
  ) {
    throw new BackupDriverError(BackupDriverErrorCode.AUTH, "Service account JSON is invalid");
  }
  if (parsed.type !== undefined && parsed.type !== "service_account") {
    throw new BackupDriverError(BackupDriverErrorCode.AUTH, "Service account JSON is invalid");
  }
  if (parsed.token_uri !== undefined && parsed.token_uri !== tokenUrl) {
    throw new BackupDriverError(
      BackupDriverErrorCode.AUTH,
      "Service account token_uri is not the Google token endpoint"
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri
  };
}

export function buildServiceAccountAssertion(
  key: ServiceAccountKey,
  scope: string,
  audience: string,
  nowSec: number
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: audience,
      iat: nowSec,
      exp: nowSec + 3600
    })
  );
  const signingInput = `${header}.${claims}`;
  try {
    const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
    return `${signingInput}.${b64url(signature)}`;
  } catch {
    throw new BackupDriverError(
      BackupDriverErrorCode.AUTH,
      "Service account private key could not be used"
    );
  }
}

const TOKEN_SAFETY_MARGIN_MS = 60_000;

export function createGoogleTokenProvider(
  config: GDriveConfig,
  secrets: GDriveSecrets<string>
): GoogleTokenProvider {
  const endpoints = getGoogleEndpoints();
  const secretList = [
    secrets.clientSecret,
    secrets.refreshToken,
    secrets.serviceAccountJson
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const buildForm = (): URLSearchParams => {
    if (config.authMethod === "oauth") {
      if (!config.clientId || !secrets.clientSecret || !secrets.refreshToken) {
        throw new BackupDriverError(
          BackupDriverErrorCode.AUTH,
          "Google Drive is not connected; connect the destination again"
        );
      }
      return new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: secrets.refreshToken
      });
    }
    if (config.authMethod === "service_account") {
      if (!secrets.serviceAccountJson) {
        throw new BackupDriverError(BackupDriverErrorCode.AUTH, "Service account JSON is missing");
      }
      const key = parseServiceAccount(secrets.serviceAccountJson, endpoints.tokenUrl);
      const assertion = buildServiceAccountAssertion(
        key,
        GOOGLE_SCOPE_DRIVE,
        endpoints.tokenUrl,
        Math.floor(Date.now() / 1000)
      );
      return new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      });
    }
    throw new BackupDriverError(BackupDriverErrorCode.AUTH, "Unknown Google auth method");
  };

  const fetchToken = async (signal?: AbortSignal): Promise<string> => {
    const form = buildForm();
    const res = await rawRequest(endpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal
    });
    const raw = await readBody(res.stream);
    let data: any = {};
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      /* not JSON */
    }
    if (res.status === 200 && typeof data.access_token === "string") {
      const expiresIn = Number(data.expires_in);
      const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000;
      cached = { token: data.access_token, expiresAt: Date.now() + ttl - TOKEN_SAFETY_MARGIN_MS };
      return data.access_token;
    }
    if (res.status === 429 || res.status >= 500) {
      throw new BackupDriverError(
        BackupDriverErrorCode.TRANSIENT,
        `Google token endpoint unavailable (HTTP ${res.status})`
      );
    }
    const code = typeof data.error === "string" ? data.error.replace(/[^a-z_]/g, "") : "";
    if (code === "invalid_grant") {
      throw new BackupDriverError(
        BackupDriverErrorCode.AUTH,
        "Google authorization is invalid, revoked or expired; reconnect the destination"
      );
    }
    throw new BackupDriverError(
      BackupDriverErrorCode.AUTH,
      sanitizeBackupError(
        `Google rejected the credentials (HTTP ${res.status}${code ? " " + code : ""})`,
        secretList
      )
    );
  };

  return {
    async getToken(signal) {
      if (cached && cached.expiresAt > Date.now()) return cached.token;
      if (!inflight) {
        // Single-flight: concurrent callers share one request. Not tied to one caller's signal.
        inflight = fetchToken().finally(() => {
          inflight = undefined;
        });
      }
      if (!signal) return inflight;
      if (signal.aborted) throw abortedError();
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(abortedError());
        signal.addEventListener("abort", onAbort, { once: true });
        inflight!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
    invalidate() {
      cached = undefined;
    },
    secrets() {
      return secretList;
    }
  };
}
