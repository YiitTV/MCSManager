// Minimal AWS Signature Version 4 signer (header-based auth) using only node:crypto.
//
// Payload choice: the S3 driver always signs the real SHA-256 of the payload
// (x-amz-content-sha256 = hex digest) instead of UNSIGNED-PAYLOAD. Hashing a part that is already
// held in memory is cheap, it works over plain http (private endpoints) and with S3-compatible
// stores that reject UNSIGNED-PAYLOAD. `UNSIGNED_PAYLOAD` is exported for callers that want it.
import { createHash, createHmac } from "crypto";

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding as required by SigV4 (unreserved chars kept, uppercase hex). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) || (ch === "/" && !encodeSlash)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Encode an object key / path: each segment encoded once (S3 never double-encodes), `/` kept. */
export function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((segment) => uriEncode(segment, true))
    .join("/");
}

/** Canonical query string: names and values encoded, sorted by encoded name then value. */
export function canonicalQueryString(query: Array<[string, string]> | Record<string, string>) {
  const pairs = Array.isArray(query) ? query : Object.entries(query);
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as [string, string])
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** `20130524T000000Z` */
export function formatAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SigV4Input {
  method: string;
  /** Already percent-encoded absolute path (use `encodeS3Path`). */
  canonicalUri: string;
  query?: Array<[string, string]> | Record<string, string>;
  /** Every header to sign (must include host and x-amz-date; x-amz-content-sha256 for S3). */
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** `YYYYMMDDTHHMMSSZ`, must equal the x-amz-date header. */
  amzDate: string;
}

export interface SigV4Result {
  authorization: string;
  signedHeaders: string;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

export function signRequest(input: SigV4Input): SigV4Result {
  const service = input.service ?? "s3";
  const dateStamp = input.amzDate.slice(0, 8);
  const headerEntries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerEntries.map(([k]) => k).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    canonicalQueryString(input.query ?? []),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join(
    "\n"
  );
  const key = deriveSigningKey(input.secretAccessKey, dateStamp, input.region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    signature,
    canonicalRequest,
    stringToSign
  };
}
