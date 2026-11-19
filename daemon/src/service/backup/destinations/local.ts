import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import { pipeline } from "stream/promises";
import {
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
  LocalDestination,
  sanitizeBackupError
} from "mcsmanager-common";
import { defaultStatfs, freeBytes } from "../disk_check";

const LEGACY_REMOTE_ID_RE = /^[A-Za-z0-9_-]{1,129}\.zip$/;
const READABLE_REMOTE_ID_RE =
  /^[\p{L}\p{Nd}_. -]{1,60}_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_[A-Za-z0-9_-]{1,6}\.zip$/u;
const DEVICE_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]) *\./i;

function fail(code: BackupDriverErrorCode, message: string): never {
  throw new BackupDriverError(code, message);
}

function mapFsError(err: any): BackupDriverError {
  if (err instanceof BackupDriverError) return err;
  const code = err?.code;
  if (code === "EEXIST") {
    return new BackupDriverError(BackupDriverErrorCode.FAILED, "Backup file already exists");
  }
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new BackupDriverError(BackupDriverErrorCode.QUOTA, "No space left on the destination");
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new BackupDriverError(
      BackupDriverErrorCode.AUTH,
      "Permission denied on the destination"
    );
  }
  if (code === "ENOENT") {
    return new BackupDriverError(
      BackupDriverErrorCode.NOT_FOUND,
      "File not found on the destination"
    );
  }
  return new BackupDriverError(BackupDriverErrorCode.FAILED, sanitizeBackupError(err));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) fail(BackupDriverErrorCode.ABORTED, "Operation aborted");
}

/** Absolute path of a local copy; throws for ids that are not plain `<name>.zip` file names. */
export function resolveLocalCopyPath(directory: string, remoteId: string): string {
  if (
    typeof remoteId !== "string" ||
    Buffer.byteLength(remoteId) > 255 ||
    DEVICE_NAME_RE.test(remoteId) ||
    !(LEGACY_REMOTE_ID_RE.test(remoteId) || READABLE_REMOTE_ID_RE.test(remoteId))
  ) {
    fail(BackupDriverErrorCode.FAILED, "Invalid local backup id");
  }
  return path.join(path.resolve(directory), remoteId);
}

export function createLocalDriver(destination: LocalDestination<string>): DestinationDriver {
  const directory = path.resolve(destination.config.directory);

  async function copyWithProgress(
    src: string,
    dest: string,
    onProgress: ((done: number, total: number) => void) | undefined,
    total: number,
    signal?: AbortSignal
  ) {
    let done = 0;
    const read = fs.createReadStream(src);
    read.on("data", (c) => {
      done += c.length;
      onProgress?.(done, total);
    });
    await pipeline(read, fs.createWriteStream(dest, { mode: 0o600 }), { signal });
  }

  return {
    type: "local",

    async test(options?: BackupDriverCallOptions): Promise<BackupTestResult> {
      try {
        throwIfAborted(options?.signal);
        await fs.ensureDir(directory);
        const marker = path.join(directory, `.mcsm_test_${crypto.randomBytes(6).toString("hex")}`);
        await fs.writeFile(marker, "ok");
        await fs.remove(marker);
        return { ok: true, freeBytes: await freeBytes(directory, defaultStatfs) };
      } catch (err) {
        return { ok: false, error: mapFsError(err).message };
      }
    },

    async put(request: BackupPutRequest): Promise<BackupPutResult> {
      throwIfAborted(request.signal);
      const name = buildReadableBackupFileName(request.object);
      const finalPath = resolveLocalCopyPath(directory, name);
      const tmpPath = path.join(directory, `.mcsm_${crypto.randomUUID()}.part`);
      try {
        await fs.ensureDir(directory);
        try {
          // Same volume: a hard link is instant and costs no extra space.
          await fs.link(request.filePath, tmpPath);
          request.onProgress?.(request.sizeBytes, request.sizeBytes);
        } catch {
          await copyWithProgress(
            request.filePath,
            tmpPath,
            request.onProgress,
            request.sizeBytes,
            request.signal
          );
        }
        throwIfAborted(request.signal);
        const { size } = await fs.stat(tmpPath);
        try {
          // Publish without replacing an older backup with the same short suffix.
          await fs.link(tmpPath, finalPath);
        } catch (err: any) {
          if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(err?.code)) throw err;
          await fs.copyFile(tmpPath, finalPath, fs.constants.COPYFILE_EXCL);
        }
        return { remoteId: name, sizeBytes: size };
      } catch (err: any) {
        if (request.signal?.aborted || err?.name === "AbortError") {
          throw new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted");
        }
        throw mapFsError(err);
      } finally {
        await fs.remove(tmpPath).catch(() => undefined);
      }
    },

    async head(remoteId: string): Promise<BackupHeadResult> {
      const p = resolveLocalCopyPath(directory, remoteId);
      try {
        const st = await fs.lstat(p);
        if (!st.isFile()) return { exists: false };
        return { exists: true, sizeBytes: st.size };
      } catch (err: any) {
        if (err?.code === "ENOENT") return { exists: false };
        throw mapFsError(err);
      }
    },

    async get(request: BackupGetRequest): Promise<void> {
      throwIfAborted(request.signal);
      const src = resolveLocalCopyPath(directory, request.remoteId);
      try {
        const st = await fs.lstat(src);
        if (!st.isFile())
          fail(BackupDriverErrorCode.NOT_FOUND, "File not found on the destination");
        await fs.ensureDir(path.dirname(request.destPath));
        await copyWithProgress(src, request.destPath, request.onProgress, st.size, request.signal);
      } catch (err: any) {
        await fs.remove(request.destPath).catch(() => undefined);
        if (request.signal?.aborted || err?.name === "AbortError") {
          throw new BackupDriverError(BackupDriverErrorCode.ABORTED, "Operation aborted");
        }
        throw mapFsError(err);
      }
    },

    async remove(remoteId: string): Promise<void> {
      const p = resolveLocalCopyPath(directory, remoteId);
      try {
        await fs.unlink(p);
      } catch (err: any) {
        if (err?.code === "ENOENT") return;
        throw mapFsError(err);
      }
    }
  };
}
