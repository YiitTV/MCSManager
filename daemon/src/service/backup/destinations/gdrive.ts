// Google Drive destination driver: plain REST (resumable upload), no Google SDK.
import crypto from "crypto";
import fs from "fs";
import { Writable } from "stream";
import { pipeline } from "stream/promises";
import {
  BACKUP_PART_SIZES,
  BackupObjectContext,
  BackupDriverCallOptions,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupGetRequest,
  BackupHeadResult,
  BackupPutRequest,
  BackupPutResult,
  BackupTestResult,
  buildReadableBackupFileName,
  DestinationDriver,
  GDriveDestination,
  sanitizeBackupError,
  sanitizeBackupInstanceName
} from "mcsmanager-common";
import {
  createGoogleTokenProvider,
  getGoogleEndpoints,
  getRetryDelayMs,
  GoogleTokenProvider,
  RawRequestOptions,
  RawResponse,
  rawRequest,
  readBody
} from "./gdrive_auth";

const ROOT_FOLDER_NAME = "MCSManager";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const INSTANCE_UUID_PROPERTY = "mcsmInstanceUuid";
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CHUNK_RETRIES = 3;
const SHARED = "supportsAllDrives=true";
const pendingFolderLookups = new Map<string, Promise<string>>();

/** Escape a value for use inside a single-quoted Drive `q` string literal. */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted"));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mapHttpError(status: number, bodyText: string, secrets: string[]): BackupDriverError {
  let reason = "";
  try {
    const parsed = JSON.parse(bodyText);
    const r = parsed?.error?.errors?.[0]?.reason ?? parsed?.error?.status;
    if (typeof r === "string") reason = r.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60);
  } catch {
    /* not JSON */
  }
  const msg = (text: string) =>
    sanitizeBackupError(`${text} (HTTP ${status}${reason ? " " + reason : ""})`, secrets);
  const E = BackupDriverErrorCode;
  if (status === 401)
    return new BackupDriverError(E.AUTH, msg("Google Drive authentication failed"));
  if (status === 403) {
    if (
      /^(storageQuotaExceeded|quotaExceeded|teamDriveFileLimitExceeded|driveFileLimitExceeded)$/.test(
        reason
      )
    ) {
      return new BackupDriverError(E.QUOTA, msg("Google Drive storage quota exceeded"));
    }
    if (/^(rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded)$/i.test(reason)) {
      return new BackupDriverError(E.TRANSIENT, msg("Google Drive rate limit"));
    }
    return new BackupDriverError(E.AUTH, msg("Google Drive permission denied"));
  }
  if (status === 404)
    return new BackupDriverError(E.NOT_FOUND, msg("Google Drive object not found"));
  if (status === 429 || status >= 500) {
    return new BackupDriverError(E.TRANSIENT, msg("Google Drive temporarily unavailable"));
  }
  return new BackupDriverError(E.FAILED, msg("Google Drive request failed"));
}

interface UploadSource {
  size: number;
  /** Fill `buf` from `offset`; resolve bytes read. */
  read(offset: number, buf: Buffer, length: number): Promise<number>;
}

export function createGDriveDriver(destination: GDriveDestination<string>): DestinationDriver {
  const tokens: GoogleTokenProvider = createGoogleTokenProvider(
    destination.config,
    destination.secrets
  );
  const ep = getGoogleEndpoints();
  const apiBase = ep.apiBase;
  const uploadBase = ep.uploadBase;
  const uploadOrigin = new URL(uploadBase).origin;
  const uploadPathPrefix = new URL(uploadBase).pathname.replace(/\/drive\/v3$/, "");
  const secrets = () => tokens.secrets();

  const rootParent = (): string => {
    const id = destination.config.folderId;
    if (!id) return "root";
    if (!DRIVE_ID_RE.test(id)) {
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Configured folder id is invalid");
    }
    return id;
  };
  const checkId = (id: string): string => {
    if (typeof id !== "string" || !DRIVE_ID_RE.test(id)) {
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Invalid Google Drive file id");
    }
    return id;
  };

  /** Authorized request; retries once with a fresh token after 401. Returns non-error responses. */
  async function authed(
    url: string,
    options: RawRequestOptions,
    acceptStatus: (s: number) => boolean = (s) => s < 400
  ): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await tokens.getToken(options.signal);
      const res = await rawRequest(url, {
        ...options,
        headers: { ...(options.headers ?? {}), Authorization: `Bearer ${token}` }
      });
      if (acceptStatus(res.status)) return res;
      const body = (await readBody(res.stream, 64 * 1024)).toString("utf8");
      if (res.status === 401 && attempt === 0) {
        tokens.invalidate();
        continue;
      }
      throw mapHttpError(res.status, body, secrets());
    }
  }

  async function json(url: string, options: RawRequestOptions, accept?: (s: number) => boolean) {
    const res = await authed(url, options, accept);
    const raw = await readBody(res.stream);
    if (raw.length === 0) return { res, data: undefined as any };
    try {
      return { res, data: JSON.parse(raw.toString("utf8")) };
    } catch {
      throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "Invalid response from Google");
    }
  }

  async function findFolder(
    parentId: string,
    filter: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const q =
      `${filter} and '${escapeDriveQueryLiteral(parentId)}' in parents` +
      ` and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken,files(id)",
      pageSize: "1",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });
    do {
      const { data } = await json(`${apiBase}/files?${params}`, { method: "GET", signal });
      if (data?.files?.length) return checkId(data.files[0].id);
      if (!data?.nextPageToken) return undefined;
      params.set("pageToken", data.nextPageToken);
    } while (true);
  }

  function findFolderByName(parentId: string, name: string, signal?: AbortSignal) {
    return findFolder(parentId, `name = '${escapeDriveQueryLiteral(name)}'`, signal);
  }

  async function createFolder(
    parentId: string,
    name: string,
    signal?: AbortSignal,
    appProperties?: Record<string, string>
  ): Promise<string> {
    const { data } = await json(`${apiBase}/files?${SHARED}&fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
      signal
    });
    return checkId(data?.id);
  }

  async function ensureBackupFolder(
    signal?: AbortSignal,
    object?: BackupObjectContext
  ): Promise<string> {
    const parent = rootParent();
    const safeName = object && sanitizeBackupInstanceName(object.instanceName, object.instanceUuid);
    const key = `${apiBase}/${parent}`;
    // Jobs in the same daemon can upload concurrently through separate driver instances.
    const previous = pendingFolderLookups.get(key);
    const lookup = (async () => {
      await previous?.catch(() => undefined);
      const root =
        (await findFolderByName(parent, ROOT_FOLDER_NAME, signal)) ??
        (await createFolder(parent, ROOT_FOLDER_NAME, signal));
      if (!object || !safeName) return root;

      const { instanceUuid } = object;
      const filter = `appProperties has { key='${INSTANCE_UUID_PROPERTY}' and value='${escapeDriveQueryLiteral(instanceUuid)}' }`;
      const existing = await findFolder(root, filter, signal);
      if (existing) return existing;

      let name = safeName;
      if (await findFolderByName(root, name, signal)) {
        name = `${safeName} (${instanceUuid.slice(0, 8)})`;
        if (await findFolderByName(root, name, signal)) name = `${safeName} (${instanceUuid})`;
      }
      return createFolder(root, name, signal, { [INSTANCE_UUID_PROPERTY]: instanceUuid });
    })();
    pendingFolderLookups.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (pendingFolderLookups.get(key) === lookup) pendingFolderLookups.delete(key);
    }
  }

  function validateSessionUri(location: unknown): string {
    if (typeof location !== "string") {
      throw new BackupDriverError(
        BackupDriverErrorCode.FAILED,
        "Google returned no upload session"
      );
    }
    let u: URL;
    try {
      u = new URL(location);
    } catch {
      throw new BackupDriverError(
        BackupDriverErrorCode.FAILED,
        "Google returned an invalid upload session"
      );
    }
    if (
      u.origin !== uploadOrigin ||
      u.username ||
      u.password ||
      !u.pathname.startsWith(uploadPathPrefix + "/")
    ) {
      throw new BackupDriverError(
        BackupDriverErrorCode.FAILED,
        "Google returned an upload session on an unexpected host"
      );
    }
    return u.toString();
  }

  async function cancelSession(session: string): Promise<void> {
    try {
      const res = await authed(session, { method: "DELETE" }, () => true);
      res.stream.resume();
    } catch {
      /* best effort */
    }
  }

  async function uploadResumable(
    parentId: string,
    name: string,
    source: UploadSource,
    appProperties: Record<string, string>,
    options: BackupDriverCallOptions & { onProgress?: (done: number, total: number) => void }
  ): Promise<{ id: string; size: number }> {
    const { signal } = options;
    const total = source.size;
    const init = await authed(`${uploadBase}/files?uploadType=resumable&${SHARED}&fields=id,size`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": total
      },
      body: JSON.stringify({ name, parents: [parentId], appProperties }),
      signal
    });
    init.stream.resume();
    const session = validateSessionUri(init.headers.location);

    const chunkSize = Math.min(BACKUP_PART_SIZES.GDRIVE_CHUNK, Math.max(total, 1));
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    let failures = 0;
    let completed: { id: string; size: number } | undefined;

    const parseDone = async (res: RawResponse) => {
      const raw = await readBody(res.stream);
      let data: any;
      try {
        data = JSON.parse(raw.toString("utf8"));
      } catch {
        data = undefined;
      }
      if (!data || !DRIVE_ID_RE.test(String(data.id))) {
        throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "Invalid upload response");
      }
      return { id: String(data.id), size: data.size !== undefined ? Number(data.size) : total };
    };
    const rangeToOffset = (range: unknown): number => {
      const m = typeof range === "string" ? /^bytes=0-(\d+)$/.exec(range) : null;
      return m ? Number(m[1]) + 1 : 0;
    };
    const statusQuery = async (): Promise<void> => {
      const res = await authed(
        session,
        {
          method: "PUT",
          headers: { "Content-Range": `bytes */${total}`, "Content-Length": 0 },
          signal
        },
        (s) => s === 308 || s === 200 || s === 201
      );
      if (res.status === 308) {
        res.stream.resume();
        offset = rangeToOffset(res.headers.range);
      } else {
        completed = await parseDone(res);
      }
    };

    try {
      if (total === 0) {
        const res = await authed(
          session,
          {
            method: "PUT",
            headers: { "Content-Range": "bytes */0" },
            body: Buffer.alloc(0),
            signal
          },
          (s) => s === 200 || s === 201
        );
        completed = await parseDone(res);
      }
      while (!completed) {
        const len = Math.min(chunkSize, total - offset);
        try {
          const n = await source.read(offset, buf, len);
          if (n !== len) {
            throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Staging file read failed");
          }
          const res = await authed(
            session,
            {
              method: "PUT",
              headers: { "Content-Range": `bytes ${offset}-${offset + len - 1}/${total}` },
              body: buf.subarray(0, len),
              signal
            },
            (s) => s === 308 || s === 200 || s === 201
          );
          if (res.status === 308) {
            res.stream.resume();
            const prev = offset;
            offset = rangeToOffset(res.headers.range);
            if (offset <= prev) {
              throw new BackupDriverError(
                BackupDriverErrorCode.TRANSIENT,
                "Upload made no progress"
              );
            }
            options.onProgress?.(Math.min(offset, total), total);
          } else {
            completed = await parseDone(res);
            options.onProgress?.(total, total);
          }
          failures = 0;
        } catch (err) {
          if (
            !(err instanceof BackupDriverError) ||
            !err.retryable ||
            ++failures > MAX_CHUNK_RETRIES
          ) {
            throw err;
          }
          await sleep(getRetryDelayMs(failures - 1), signal);
          try {
            await statusQuery();
          } catch (qerr) {
            if (!(qerr instanceof BackupDriverError) || !qerr.retryable) throw qerr;
          }
        }
      }
    } catch (err) {
      await cancelSession(session);
      throw err;
    }
    return completed;
  }

  async function downloadTo(
    id: string,
    sink: Writable,
    signal?: AbortSignal,
    onBytes?: (n: number, total: number) => void
  ) {
    checkId(id);
    const res = await authed(`${apiBase}/files/${id}?alt=media&${SHARED}`, {
      method: "GET",
      signal
    });
    const expected = Number(res.headers["content-length"]);
    let received = 0;
    res.stream.on("data", (c: Buffer) => {
      received += c.length;
      onBytes?.(received, Number.isFinite(expected) ? expected : 0);
    });
    try {
      await pipeline(res.stream, sink, { signal });
    } catch (err) {
      if (signal?.aborted) {
        throw new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted");
      }
      if (err instanceof BackupDriverError) throw err;
      throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "Download from Google failed");
    }
    if (Number.isFinite(expected) && received !== expected) {
      throw new BackupDriverError(
        BackupDriverErrorCode.TRANSIENT,
        "Download from Google was truncated"
      );
    }
  }

  async function removeById(id: string, signal?: AbortSignal): Promise<void> {
    checkId(id);
    const res = await authed(
      `${apiBase}/files/${id}?${SHARED}`,
      { method: "DELETE", signal },
      (s) => s < 400 || s === 404
    );
    res.stream.resume();
  }

  async function headById(
    id: string,
    signal?: AbortSignal
  ): Promise<BackupHeadResult & { id?: string }> {
    checkId(id);
    const res = await authed(
      `${apiBase}/files/${id}?fields=id,size,trashed&${SHARED}`,
      { method: "GET", signal },
      (s) => s < 400 || s === 404
    );
    const raw = await readBody(res.stream);
    if (res.status === 404) return { exists: false };
    let data: any;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "Invalid response from Google");
    }
    if (data.trashed) return { exists: false };
    return { exists: true, sizeBytes: Number(data.size) };
  }

  function fileSource(handle: fs.promises.FileHandle, size: number): UploadSource {
    return {
      size,
      async read(offset, buf, length) {
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return got;
      }
    };
  }

  function wrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      if (err instanceof BackupDriverError) throw err;
      throw new BackupDriverError(
        BackupDriverErrorCode.FAILED,
        sanitizeBackupError(err, secrets())
      );
    });
  }

  return {
    type: "gdrive",

    async test(options): Promise<BackupTestResult> {
      try {
        const signal = options?.signal;
        const parent = await ensureBackupFolder(signal);
        const marker = Buffer.from(crypto.randomBytes(16).toString("hex"));
        const name = `.mcsm_test_${crypto.randomBytes(6).toString("hex")}`;
        const { id } = await uploadResumable(
          parent,
          name,
          {
            size: marker.length,
            read: async (offset, buf, length) => marker.copy(buf, 0, offset, offset + length)
          },
          {},
          { signal }
        );
        try {
          const head = await headById(id, signal);
          if (!head.exists || head.sizeBytes !== marker.length) {
            throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Marker file check failed");
          }
          const parts: Buffer[] = [];
          await downloadTo(
            id,
            new Writable({
              write(chunk, _enc, cb) {
                parts.push(chunk);
                cb();
              }
            }),
            signal
          );
          if (!Buffer.concat(parts).equals(marker)) {
            throw new BackupDriverError(
              BackupDriverErrorCode.FAILED,
              "Marker file content mismatch"
            );
          }
        } finally {
          await removeById(id).catch(() => undefined);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: sanitizeBackupError(err, secrets()) };
      }
    },

    put(request: BackupPutRequest): Promise<BackupPutResult> {
      return wrap(async () => {
        const fileName = buildReadableBackupFileName(request.object);
        const parent = await ensureBackupFolder(request.signal, request.object);
        const handle = await fs.promises.open(request.filePath, "r");
        try {
          const st = await handle.stat();
          if (st.size !== request.sizeBytes) {
            throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Staging file size mismatch");
          }
          const result = await uploadResumable(
            parent,
            fileName,
            fileSource(handle, request.sizeBytes),
            { sha256: request.sha256, backupId: request.object.backupId },
            { signal: request.signal, onProgress: request.onProgress }
          );
          return { remoteId: result.id, sizeBytes: request.sizeBytes };
        } finally {
          await handle.close().catch(() => undefined);
        }
      });
    },

    head(remoteId, options) {
      return wrap(() =>
        headById(remoteId, options?.signal).then((r) => ({
          exists: r.exists,
          sizeBytes: r.sizeBytes
        }))
      );
    },

    get(request: BackupGetRequest) {
      return wrap(async () => {
        const out = fs.createWriteStream(request.destPath);
        try {
          await downloadTo(request.remoteId, out, request.signal, (n, t) =>
            request.onProgress?.(n, t)
          );
        } catch (err) {
          out.destroy();
          await fs.promises.rm(request.destPath, { force: true }).catch(() => undefined);
          throw err;
        }
      });
    },

    remove(remoteId, options) {
      return wrap(() => removeById(remoteId, options?.signal));
    }
  };
}
