import http from "http";
import https from "https";
import { NotificationConfig } from "../entity/notification_config";
import {
  makePinnedLookup,
  OutboundResolver,
  OutboundTarget,
  OutboundUrlError,
  resolveOutboundTarget
} from "../utils/outbound_url";
import { logger } from "./log";
import {
  buildDiscordPayload,
  NotificationEvent,
  serializeEvent,
  signBody
} from "./notification_payload";

export const REQUEST_TIMEOUT_MS = 10_000;
export const RESPONSE_READ_CAP = 2048;
export const MAX_RETRY_AFTER_SEC = 120;

// Safe, stable error codes. Never include URLs, headers or bodies.
export type SendErrorCode =
  | "not_configured"
  | "timeout"
  | "dns"
  | "blocked_address"
  | "invalid_url"
  | "tls"
  | "redirect"
  | "http_4xx"
  | "http_5xx"
  | "network";

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: SendErrorCode;
  retryable: boolean;
  retryAfterSec?: number;
}

export interface SendOptions {
  resolver?: OutboundResolver;
  timeoutMs?: number;
  now?: () => number;
}

export function classifyNetworkError(err: any): SendErrorCode {
  const code = String(err?.code ?? "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("CERT_") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "ERR_SSL_WRONG_VERSION_NUMBER"
  )
    return "tls";
  return "network";
}

interface RawResponse {
  status?: number;
  retryAfterSec?: number;
  error?: SendErrorCode;
}

// One POST to the pinned address. Never follows redirects, total timeout, reads at most 2 KB.
function postPinned(
  target: OutboundTarget,
  headers: Record<string, string | number>,
  body: Buffer,
  timeoutMs: number
): Promise<RawResponse> {
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: RawResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
      resolve(result);
    };

    const isHttps = target.url.protocol === "https:";
    try {
      req = (isHttps ? https : http).request(
        {
          host: target.hostname,
          port: target.port,
          path: target.url.pathname + target.url.search,
          method: "POST",
          headers: { ...headers, "Content-Length": body.length },
          // Connect to the exact validated address; TLS SNI/cert checks keep using the hostname.
          lookup: makePinnedLookup(target.address, target.family) as any,
          agent: false
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const ra = Number(res.headers["retry-after"]);
          const retryAfterSec = Number.isFinite(ra) && ra >= 0 ? Math.floor(ra) : undefined;
          let read = 0;
          const done = () => finish({ status, retryAfterSec });
          res.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read >= RESPONSE_READ_CAP) done();
          });
          res.on("end", done);
          res.on("close", done);
          res.on("error", done);
        }
      );
    } catch (err) {
      finish({ error: classifyNetworkError(err) });
      return;
    }
    timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    req.on("error", (err) => finish({ error: classifyNetworkError(err) }));
    req.end(body);
  });
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "unknown";
  }
}

function toResult(raw: RawResponse): SendResult {
  if (raw.error) {
    return { ok: false, error: raw.error, retryable: raw.error === "timeout" || raw.error === "dns" || raw.error === "network" };
  }
  const status = raw.status ?? 0;
  if (status >= 200 && status < 300) return { ok: true, status, retryable: false };
  if (status >= 300 && status < 400) return { ok: false, status, error: "redirect", retryable: false };
  if (status >= 500)
    return { ok: false, status, error: "http_5xx", retryable: true, retryAfterSec: raw.retryAfterSec };
  const retryable = status === 408 || status === 429;
  return {
    ok: false,
    status,
    error: status >= 400 ? "http_4xx" : "network",
    retryable,
    retryAfterSec: retryable ? raw.retryAfterSec : undefined
  };
}

/**
 * One delivery attempt. Re-validates and re-resolves the URL, builds a fresh signature, posts to
 * the pinned address. Logs only sink type, host and an error code.
 */
export async function sendEvent(
  event: NotificationEvent,
  config: NotificationConfig,
  options: SendOptions = {}
): Promise<SendResult> {
  const sinkType = config.sinkType;
  if (!config.url || (sinkType === "bot_http" && !config.secret)) {
    return { ok: false, error: "not_configured", retryable: false };
  }

  let target: OutboundTarget;
  try {
    target = await resolveOutboundTarget(
      config.url,
      { sinkType, allowPrivate: sinkType === "bot_http" && config.allowPrivateAddress },
      options.resolver
    );
  } catch (err) {
    const code = err instanceof OutboundUrlError ? err.code : "invalid_url";
    const error: SendErrorCode =
      code === "dns" ? "dns" : code === "blocked_address" ? "blocked_address" : "invalid_url";
    logger.warn(`Notification not sent: sink=${sinkType} host=${safeHost(config.url)} code=${error}`);
    return { ok: false, error, retryable: error === "dns" };
  }

  let body: Buffer;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Minefield-Panel-Notifier/1"
  };
  if (sinkType === "bot_http") {
    body = serializeEvent(event);
    const ts = String(Math.floor((options.now ? options.now() : Date.now()) / 1000));
    headers["X-Minefield-Timestamp"] = ts;
    headers["X-Minefield-Signature"] = signBody(config.secret, ts, body);
  } else {
    body = Buffer.from(JSON.stringify(buildDiscordPayload(event)), "utf8");
  }

  const raw = await postPinned(target, headers, body, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const result = toResult(raw);
  if (!result.ok) {
    logger.warn(
      `Notification delivery failed: sink=${sinkType} host=${target.hostname} code=${result.error}` +
        (result.status ? ` status=${result.status}` : "")
    );
  }
  return result;
}
