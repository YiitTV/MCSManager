// S3-compatible destination driver: minimal SigV4 client over node:http(s), no AWS SDK.
// Design D4 / D7 of the instance-backups change.
import { randomUUID } from "crypto";
import { promises as dns } from "dns";
import fs from "fs";
import http, { IncomingMessage } from "http";
import https from "https";
import { isIP } from "net";
import { pipeline } from "stream/promises";
import {
  BACKUP_PART_SIZES,
  BackupDriverCallOptions,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupGetRequest,
  BackupHeadResult,
  BackupObjectContext,
  BackupPutRequest,
  BackupPutResult,
  BackupTestResult,
  buildBackupObjectName,
  chooseS3PartSize,
  DestinationDriver,
  S3Destination,
  sanitizeBackupError
} from "mcsmanager-common";
import { resolveSafeUrl } from "../../../utils/url";
import logger from "../../log";
import {
  canonicalQueryString,
  EMPTY_PAYLOAD_SHA256,
  encodeS3Path,
  formatAmzDate,
  sha256Hex,
  signRequest
} from "./s3_sigv4";

const MAX_BODY_BYTES = 1024 * 1024;
const REMOTE_ID_TAIL = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.zip$/;

/** Internal knobs; production code uses the defaults (tests override them). */
export interface S3DriverOptions {
  /** Multipart part size override (tests only). Default: `chooseS3PartSize(size)`. */
  partSize?: number;
  /** Delays between attempts of one request; attempts = length + 1. Default 1 s, 4 s. */
  retryDelaysMs?: number[];
  /** Socket idle timeout per request. Default 60 s. */
  idleTimeoutMs?: number;
  /** DNS resolver for the allowPrivateNetwork path (tests only). */
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

interface Target {
  address: string;
  family: 4 | 6;
}

interface RequestSpec {
  op: string;
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  /** Full object key (without bucket); undefined = bucket root. */
  key?: string;
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
}

/** Link-local / metadata / unspecified addresses are refused even with allowPrivateNetwork. */
function isForbiddenAddress(address: string): boolean {
  let a = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (isIP(a) === 4) {
    const [first, second] = a.split(".").map(Number);
    return first === 0 || (first === 169 && second === 254);
  }
  return a === "::" || /^fe[89ab]/.test(a) || a.startsWith("fd00:ec2:");
}

function abortedError(): BackupDriverError {
  return new BackupDriverError(BackupDriverErrorCode.ABORTED, "S3 operation aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function xmlValue(xml: string, tag: string, pattern: string): string | undefined {
  const m = new RegExp(`<${tag}>(${pattern})</${tag}>`).exec(xml.slice(0, MAX_BODY_BYTES));
  return m ? m[1] : undefined;
}

export function createS3Driver(destination: S3Destination<string>): DestinationDriver {
  return createS3DriverWithOptions(destination, {});
}

export function createS3DriverWithOptions(
  destination: S3Destination<string>,
  options: S3DriverOptions
): DestinationDriver {
  return new S3Driver(destination, options);
}

class S3Driver implements DestinationDriver {
  readonly type = "s3" as const;
  private readonly retryDelays: number[];
  private readonly idleTimeout: number;

  constructor(
    private readonly destination: S3Destination<string>,
    private readonly options: S3DriverOptions
  ) {
    this.retryDelays = options.retryDelaysMs ?? [1000, 4000];
    this.idleTimeout = options.idleTimeoutMs ?? 60_000;
  }

  // ---------------------------------------------------------------- key handling

  private get secrets(): string[] {
    return [this.destination.secrets?.secretAccessKey ?? "", this.destination.config.accessKeyId];
  }

  private prefix(): string {
    const raw = (this.destination.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (raw === "") return "";
    // eslint-disable-next-line no-control-regex
    if (
      raw.split("/").some((s) => s === ".." || s === "." || s === "") ||
      /[\u0000-\u001f]/.test(raw)
    )
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "S3 prefix is invalid");
    return raw + "/";
  }

  private keyFor(object: BackupObjectContext): string {
    let name: string;
    try {
      name = buildBackupObjectName(object);
    } catch {
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Invalid backup object id");
    }
    return this.prefix() + name;
  }

  /** `remoteId` is an S3 key we produced; refuse anything else so a forged id cannot reach other keys. */
  private checkRemoteId(remoteId: string): string {
    const prefix = this.prefix();
    if (
      typeof remoteId !== "string" ||
      !remoteId.startsWith(prefix) ||
      !REMOTE_ID_TAIL.test(remoteId.slice(prefix.length))
    ) {
      throw new BackupDriverError(BackupDriverErrorCode.NOT_FOUND, "Invalid remote object id");
    }
    return remoteId;
  }

  // ---------------------------------------------------------------- transport

  private endpointUrl(): URL {
    const c = this.destination.config;
    let url: URL;
    try {
      url = new URL(c.endpoint);
    } catch {
      throw new BackupDriverError(
        BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED,
        "S3 endpoint is invalid"
      );
    }
    const okProto =
      url.protocol === "https:" || (c.allowPrivateNetwork && url.protocol === "http:");
    if (!okProto || url.username || url.password || url.search || url.hash) {
      throw new BackupDriverError(
        BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED,
        "S3 endpoint is not allowed"
      );
    }
    return url;
  }

  private async resolveTarget(url: URL, hostname: string): Promise<Target> {
    const c = this.destination.config;
    try {
      if (!c.allowPrivateNetwork) {
        const t = await resolveSafeUrl(`${url.protocol}//${hostname}`);
        return { address: t.address, family: t.family };
      }
      const literal = hostname.replace(/^\[|\]$/g, "");
      const list = isIP(literal)
        ? [{ address: literal, family: isIP(literal) }]
        : await (this.options.dnsLookup
            ? this.options.dnsLookup(hostname)
            : dns.lookup(hostname, { all: true, verbatim: true }));
      if (list.length === 0 || list.some((a) => isForbiddenAddress(a.address))) {
        throw new Error("forbidden address");
      }
      return { address: list[0].address, family: list[0].family === 6 ? 6 : 4 };
    } catch {
      throw new BackupDriverError(
        BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED,
        "S3 endpoint is not allowed"
      );
    }
  }

  /** Sign and send one request; resolves with the response (body not yet read). */
  private async open(spec: RequestSpec): Promise<IncomingMessage> {
    const c = this.destination.config;
    const secret = this.destination.secrets?.secretAccessKey;
    if (!secret) {
      throw new BackupDriverError(BackupDriverErrorCode.AUTH, "S3 secret access key is not set");
    }
    if (spec.signal?.aborted) throw abortedError();
    const url = this.endpointUrl();
    const basePath = url.pathname.replace(/\/+$/, "");
    const hostname = c.pathStyle ? url.hostname : `${c.bucket}.${url.hostname}`;
    const hostHeader = url.port ? `${hostname}:${url.port}` : hostname;
    const keyPart = spec.key !== undefined ? "/" + encodeS3Path(spec.key) : "/";
    const canonicalUri = (c.pathStyle ? `${basePath}/${c.bucket}` : basePath) + keyPart;
    const target = await this.resolveTarget(url, hostname);

    const payload = spec.body ?? Buffer.alloc(0);
    const payloadHash = spec.body ? sha256Hex(spec.body) : EMPTY_PAYLOAD_SHA256;
    const amzDate = formatAmzDate(new Date());
    const headers: Record<string, string> = {
      ...(spec.headers ?? {}),
      host: hostHeader,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    const signed = signRequest({
      method: spec.method,
      canonicalUri,
      query: spec.query,
      headers,
      payloadHash,
      accessKeyId: c.accessKeyId,
      secretAccessKey: secret,
      region: c.region,
      amzDate
    });
    headers.authorization = signed.authorization;
    if (spec.body || spec.method === "PUT" || spec.method === "POST") {
      headers["content-length"] = String(payload.length);
    }
    const qs = canonicalQueryString(spec.query ?? []);
    const mod = url.protocol === "https:" ? https : http;

    return new Promise<IncomingMessage>((resolve, reject) => {
      const lookup = ((_h: string, opts: any, cb: any) => {
        if (opts && opts.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      }) as any;
      const req = mod.request({
        method: spec.method,
        host: hostname.replace(/^\[|\]$/g, ""),
        port: url.port ? Number(url.port) : undefined,
        path: canonicalUri + (qs ? "?" + qs : ""),
        headers,
        lookup,
        agent: false,
        servername: isIP(hostname) ? undefined : hostname
      } as any);
      const onAbort = () => req.destroy(abortedError());
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => spec.signal?.removeEventListener("abort", onAbort);
      req.setTimeout(this.idleTimeout, () =>
        req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      );
      req.on("error", (err) => {
        cleanup();
        reject(this.mapNetworkError(err, spec));
      });
      req.on("response", (res) => {
        res.on("close", cleanup);
        resolve(res);
      });
      req.end(spec.body);
    });
  }

  private mapNetworkError(err: any, spec: RequestSpec): BackupDriverError {
    if (err instanceof BackupDriverError) return err;
    if (spec.signal?.aborted) return abortedError();
    const code = typeof err?.code === "string" ? err.code.replace(/[^A-Z0-9_]/g, "") : "UNKNOWN";
    const tls = /^(CERT_|DEPTH_ZERO|UNABLE_TO_|ERR_TLS|SELF_SIGNED|ERR_SSL)/.test(code);
    return new BackupDriverError(
      tls ? BackupDriverErrorCode.FAILED : BackupDriverErrorCode.TRANSIENT,
      `S3 ${spec.op} network error (${code})`
    );
  }

  private async readBody(res: IncomingMessage, spec: RequestSpec): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        else res.destroy();
      }
    } catch (err) {
      if (size <= MAX_BODY_BYTES) throw this.mapNetworkError(err, spec);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private statusError(op: string, status: number, body: string): BackupDriverError {
    const code = xmlValue(body, "Code", "[A-Za-z0-9]{1,64}");
    let kind = BackupDriverErrorCode.FAILED;
    if (
      status === 401 ||
      status === 403 ||
      [
        "InvalidAccessKeyId",
        "SignatureDoesNotMatch",
        "AccessDenied",
        "ExpiredToken",
        "InvalidToken"
      ].includes(code ?? "")
    ) {
      kind = BackupDriverErrorCode.AUTH;
    } else if (
      ["QuotaExceeded", "StorageQuotaExceeded", "EntityTooLarge", "AccountProblem"].includes(
        code ?? ""
      ) ||
      status === 507
    ) {
      kind = BackupDriverErrorCode.QUOTA;
    } else if (
      status === 429 ||
      status >= 500 ||
      ["SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable"].includes(code ?? "")
    ) {
      kind = BackupDriverErrorCode.TRANSIENT;
    } else if (
      status === 404 ||
      ["NoSuchBucket", "NoSuchKey", "NoSuchUpload"].includes(code ?? "")
    ) {
      kind = BackupDriverErrorCode.NOT_FOUND;
    }
    const msg = sanitizeBackupError(
      `S3 ${op} failed (HTTP ${status}${code ? " " + code : ""})`,
      this.secrets
    );
    return new BackupDriverError(kind, msg);
  }

  /** One buffered request with retries; resolves with status/headers/body for accepted statuses. */
  private async call(
    spec: RequestSpec,
    okStatuses: number[]
  ): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.open(spec);
        const body = await this.readBody(res, spec);
        const status = res.statusCode ?? 0;
        if (!okStatuses.includes(status)) throw this.statusError(spec.op, status, body);
        if (status === 200 && /<Error>/.test(body.slice(0, MAX_BODY_BYTES))) {
          throw this.statusError(spec.op, 500, body);
        }
        return { status, headers: res.headers, body };
      } catch (err) {
        const e = this.sanitized(err, spec);
        if (!e.retryable || attempt >= this.retryDelays.length) throw e;
        logger.warn(`S3 ${spec.op} attempt ${attempt + 1} failed (${e.code}), retrying`);
        await sleep(this.retryDelays[attempt], spec.signal);
      }
    }
  }

  private sanitized(err: unknown, spec: RequestSpec): BackupDriverError {
    if (err instanceof BackupDriverError) return err;
    if (spec.signal?.aborted) return abortedError();
    return new BackupDriverError(
      BackupDriverErrorCode.FAILED,
      sanitizeBackupError(err, this.secrets)
    );
  }

  // ---------------------------------------------------------------- driver API

  async test(options?: BackupDriverCallOptions): Promise<BackupTestResult> {
    try {
      const key = `${this.prefix()}.mcsm-test-${randomUUID()}`;
      const body = Buffer.from("mcsmanager backup connectivity test");
      await this.call(
        { op: "PutObject", method: "PUT", key, body, signal: options?.signal },
        [200]
      );
      try {
        const head = await this.headKey(key, options?.signal);
        if (!head.exists) {
          throw new BackupDriverError(
            BackupDriverErrorCode.FAILED,
            "S3 test object was not stored"
          );
        }
      } finally {
        await this.removeKey(key).catch(() => undefined);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeBackupError(err, this.secrets) };
    }
  }

  async put(request: BackupPutRequest): Promise<BackupPutResult> {
    const key = this.keyFor(request.object);
    const size = request.sizeBytes;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Invalid file size");
    }
    const partSize = this.options.partSize ?? chooseS3PartSize(size);
    if (Math.ceil(size / partSize) > BACKUP_PART_SIZES.S3_MAX_PARTS) {
      throw new BackupDriverError(BackupDriverErrorCode.QUOTA, "File too large for S3 multipart");
    }
    const fh = await fs.promises.open(request.filePath, "r").catch((err) => {
      throw new BackupDriverError(
        BackupDriverErrorCode.FAILED,
        sanitizeBackupError(`Cannot open staging file: ${err?.code ?? "error"}`)
      );
    });
    try {
      const st = await fh.stat();
      if (st.size !== size) {
        throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Staging file size mismatch");
      }
      const meta: Record<string, string> = /^[0-9a-f]{64}$/.test(request.sha256)
        ? { "x-amz-meta-sha256": request.sha256 }
        : {};
      if (size <= partSize) {
        const body = Buffer.allocUnsafe(size);
        await this.readFully(fh, body, 0, size);
        await this.call(
          { op: "PutObject", method: "PUT", key, body, headers: meta, signal: request.signal },
          [200]
        );
        request.onProgress?.(size, size);
      } else {
        await this.multipart(fh, key, size, partSize, meta, request);
      }
      return { remoteId: key, sizeBytes: size };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private async readFully(fh: fs.promises.FileHandle, buf: Buffer, pos: number, len: number) {
    let done = 0;
    while (done < len) {
      const { bytesRead } = await fh.read(buf, done, len - done, pos + done);
      if (bytesRead === 0) {
        throw new BackupDriverError(
          BackupDriverErrorCode.FAILED,
          "Staging file changed during upload"
        );
      }
      done += bytesRead;
    }
  }

  private async multipart(
    fh: fs.promises.FileHandle,
    key: string,
    size: number,
    partSize: number,
    meta: Record<string, string>,
    request: BackupPutRequest
  ) {
    const signal = request.signal;
    const created = await this.call(
      {
        op: "CreateMultipartUpload",
        method: "POST",
        key,
        query: [["uploads", ""]],
        headers: meta,
        signal
      },
      [200]
    );
    const uploadId = xmlValue(created.body, "UploadId", "[A-Za-z0-9._~+/=%-]{1,1024}");
    if (!uploadId) {
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "S3 returned no upload id");
    }
    try {
      const buffer = Buffer.allocUnsafe(partSize); // the one reused part buffer
      const etags: string[] = [];
      let offset = 0;
      for (let n = 1; offset < size; n++) {
        const len = Math.min(partSize, size - offset);
        await this.readFully(fh, buffer, offset, len);
        const body = buffer.subarray(0, len);
        const res = await this.call(
          {
            op: "UploadPart",
            method: "PUT",
            key,
            query: [
              ["partNumber", String(n)],
              ["uploadId", uploadId]
            ],
            body,
            signal
          },
          [200]
        );
        const etag = String(res.headers.etag ?? "");
        if (!/^"?[A-Za-z0-9-]{1,128}"?$/.test(etag)) {
          throw new BackupDriverError(BackupDriverErrorCode.FAILED, "S3 returned no part ETag");
        }
        etags.push(etag);
        offset += len;
        request.onProgress?.(offset, size);
      }
      const xml =
        "<CompleteMultipartUpload>" +
        etags
          .map(
            (e, i) =>
              `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/"/g, "&quot;")}</ETag></Part>`
          )
          .join("") +
        "</CompleteMultipartUpload>";
      await this.call(
        {
          op: "CompleteMultipartUpload",
          method: "POST",
          key,
          query: [["uploadId", uploadId]],
          body: Buffer.from(xml, "utf8"),
          signal
        },
        [200]
      );
    } catch (err) {
      await this.call(
        { op: "AbortMultipartUpload", method: "DELETE", key, query: [["uploadId", uploadId]] },
        [200, 204, 404]
      ).catch((e) => logger.warn(`S3 AbortMultipartUpload failed: ${(e as Error).message}`));
      throw err;
    }
  }

  private async headKey(key: string, signal?: AbortSignal): Promise<BackupHeadResult> {
    const spec: RequestSpec = { op: "HeadObject", method: "HEAD", key, signal };
    try {
      const res = await this.call(spec, [200]);
      const len = Number(res.headers["content-length"]);
      return { exists: true, sizeBytes: Number.isFinite(len) ? len : undefined };
    } catch (err) {
      if (err instanceof BackupDriverError && err.code === BackupDriverErrorCode.NOT_FOUND) {
        // HEAD has no body, so NoSuchBucket is indistinguishable from a missing key.
        return { exists: false };
      }
      throw err;
    }
  }

  async head(remoteId: string, options?: BackupDriverCallOptions): Promise<BackupHeadResult> {
    return this.headKey(this.checkRemoteId(remoteId), options?.signal);
  }

  private async removeKey(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.call({ op: "DeleteObject", method: "DELETE", key, signal }, [200, 204, 404]);
    } catch (err) {
      if (err instanceof BackupDriverError && err.code === BackupDriverErrorCode.NOT_FOUND) return;
      throw err;
    }
  }

  async remove(remoteId: string, options?: BackupDriverCallOptions): Promise<void> {
    await this.removeKey(this.checkRemoteId(remoteId), options?.signal);
  }

  async get(request: BackupGetRequest): Promise<void> {
    const key = this.checkRemoteId(request.remoteId);
    const signal = request.signal;
    let written = 0;
    let total = -1;
    try {
      for (let attempt = 0; ; attempt++) {
        const spec: RequestSpec = {
          op: "GetObject",
          method: "GET",
          key,
          headers: written > 0 ? { range: `bytes=${written}-` } : {},
          signal
        };
        try {
          const res = await this.open(spec);
          const status = res.statusCode ?? 0;
          if (status !== 200 && status !== 206) {
            throw this.statusError(spec.op, status, await this.readBody(res, spec));
          }
          let flags = "a";
          if (status === 200 || written === 0) {
            written = 0;
            flags = "w";
            total = Number(res.headers["content-length"] ?? -1);
          }
          const expected = total >= 0 ? total - written : -1;
          const ws = fs.createWriteStream(request.destPath, { flags });
          res.on("data", () => request.onProgress?.(written + ws.bytesWritten, total));
          const onAbort = () => res.destroy(abortedError());
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            await pipeline(res, ws);
          } finally {
            signal?.removeEventListener("abort", onAbort);
            written += ws.bytesWritten;
          }
          if (expected >= 0 && written !== total) {
            throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "S3 GetObject truncated");
          }
          request.onProgress?.(written, total < 0 ? written : total);
          return;
        } catch (err) {
          const e = signal?.aborted
            ? abortedError()
            : err instanceof BackupDriverError
              ? err
              : this.mapNetworkError({ code: (err as any)?.code ?? "ECONNRESET" }, spec);
          if (!e.retryable || attempt >= this.retryDelays.length) throw e;
          await sleep(this.retryDelays[attempt], signal);
        }
      }
    } catch (err) {
      await fs.promises.rm(request.destPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
