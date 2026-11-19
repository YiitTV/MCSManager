import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import StreamZip from "node-stream-zip";
import { pipeline } from "stream/promises";
import { BACKUP_ARCHIVE, BackupErrorCode } from "mcsmanager-common";
import { BackupError, throwIfAborted } from "./errors";
import { defaultStatfs, freeBytes, StatfsFn } from "./disk_check";
import { isPhysicallyInside } from "./safe_path";

export interface ValidatedEntry {
  name: string;
  /** Normalised relative path with `/` separators (no trailing slash). */
  rel: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
}

export interface RestoreOptions {
  archivePath: string;
  instanceDir: string;
  /** Used for the rollback directory name. */
  restoreId: string;
  expectedSha256: string;
  /** Max total uncompressed size (config maxZipFileSize in bytes). */
  maxUncompressedBytes: number;
  signal?: AbortSignal;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  statfs?: StatfsFn;
  /** Called with absolute top-level paths after a successful extraction (ownership sync). */
  afterExtract?: (topLevelPaths: string[]) => Promise<void>;
  /** Called for non-fatal notes (skipped symlinks). */
  onWarning?: (warning: string) => void;
}

function illegal(message: string): never {
  throw new BackupError(BackupErrorCode.ILLEGAL_ARCHIVE, message);
}

/** Lowercase hex SHA-256 of a file, streamed. */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(
    fs.createReadStream(file),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    },
    async function (source) {
      for await (const _ of source) void _;
    },
    { signal }
  );
  return hash.digest("hex");
}

/** Validate an entry name; returns the normalised relative path or throws ILLEGAL_ARCHIVE. */
export function validateEntryName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 4096)
    illegal("Illegal entry name");
  if (name.includes("\0")) illegal("Illegal entry name");
  const unified = name.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) illegal("Absolute entry name");
  const segments = unified.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) illegal("Entry escapes the instance directory");
  if (segments.length === 0) illegal("Empty entry name");
  if (segments[0].startsWith(BACKUP_ARCHIVE.ROLLBACK_DIR_PREFIX)) illegal("Reserved entry name");
  return segments.join("/");
}

/** A symlink inside an archive is only acceptable if relative and staying inside the tree. */
export function validateSymlinkTarget(entryRel: string, target: string): void {
  if (target.includes("\0") || target.length === 0 || target.length > 4096)
    illegal("Illegal symlink");
  const unified = target.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) illegal("Symlink points outside");
  // Walk the target from the entry's directory; depth must never go negative.
  let depth = entryRel.split("/").length - 1;
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth--;
      if (depth < 0) illegal("Symlink points outside");
    } else depth++;
  }
}

/** Read and validate every entry BEFORE anything is written. */
export async function validateArchive(
  zip: InstanceType<typeof StreamZip.async>,
  maxUncompressedBytes: number
): Promise<{ entries: ValidatedEntry[]; totalBytes: number }> {
  const raw = Object.values(await zip.entries());
  const entries: ValidatedEntry[] = [];
  let totalBytes = 0;
  for (const e of raw) {
    const rel = validateEntryName(e.name);
    const unixType = (e.attr >>> 16) & 0xf000;
    const isSymlink = unixType === 0xa000;
    if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000 && !isSymlink) {
      illegal("Unsupported entry type");
    }
    if (isSymlink) {
      if (e.size > 4096) illegal("Illegal symlink");
      const target = (await zip.entryData(e.name)).toString("utf8");
      validateSymlinkTarget(rel, target);
    }
    totalBytes += e.isDirectory ? 0 : e.size;
    if (totalBytes > maxUncompressedBytes) illegal("Archive is too large");
    entries.push({
      name: e.name,
      rel,
      isDirectory: e.isDirectory,
      isSymlink,
      size: e.size,
      mode: (e.attr >>> 16) & 0o777
    });
  }
  return { entries, totalBytes };
}

/**
 * Restore an archive into the (stopped) instance directory.
 * 1. verify sha256, 2. validate every entry/symlink (nothing written yet), 3. move the existing
 * top-level paths into a rollback dir, 4. extract (files and directories only, never symlinks),
 * 5. drop the rollback dir, or put everything back on failure.
 */
export async function restoreArchive(options: RestoreOptions): Promise<{ restored: string[] }> {
  const { archivePath, instanceDir, signal } = options;
  const root = path.resolve(instanceDir);

  const actual = await sha256File(archivePath, signal);
  if (actual !== options.expectedSha256) {
    throw new BackupError(BackupErrorCode.CHECKSUM_MISMATCH, "Archive checksum does not match");
  }
  throwIfAborted(signal);

  const zip = new StreamZip.async({ file: archivePath });
  const rollbackDir = path.join(root, `${BACKUP_ARCHIVE.ROLLBACK_DIR_PREFIX}${options.restoreId}`);
  const moved: string[] = [];
  const touchedTops = new Set<string>();
  try {
    let validated;
    try {
      validated = await validateArchive(zip, options.maxUncompressedBytes);
    } catch (err) {
      if (err instanceof BackupError) throw err;
      illegal("Archive cannot be read");
    }
    const { entries, totalBytes } = validated;
    throwIfAborted(signal);

    const free = await freeBytes(root, options.statfs ?? defaultStatfs);
    if (free < totalBytes) {
      throw new BackupError(BackupErrorCode.DISK_SPACE, "Not enough free disk space to restore");
    }

    const tops = [...new Set(entries.map((e) => e.rel.split("/")[0]))];
    for (const top of tops) {
      const abs = path.join(root, top);
      if (path.dirname(abs) !== root) illegal("Illegal entry name");
    }

    // Move current contents of the restored top-level paths out of the way.
    await fs.ensureDir(rollbackDir);
    for (const top of tops) {
      const abs = path.join(root, top);
      touchedTops.add(top);
      try {
        await fs.lstat(abs);
      } catch (err: any) {
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      await fs.rename(abs, path.join(rollbackDir, top));
      moved.push(top);
    }

    // Extract. The restored top-level paths are fresh, so no symlink can sit in the way.
    const verifiedDirs = new Set<string>([root]);
    let done = 0;
    let n = 0;
    for (const e of entries) {
      if (++n % 64 === 0) {
        await new Promise((r) => setImmediate(r));
        throwIfAborted(signal);
      }
      const target = path.join(root, ...e.rel.split("/"));
      const relCheck = path.relative(root, target);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck))
        illegal("Entry escapes the instance directory");
      if (e.isSymlink) {
        options.onWarning?.(`restore_symlink_skipped: ${e.rel}`);
        continue;
      }
      if (e.isDirectory) {
        await fs.ensureDir(target);
        continue;
      }
      const parent = path.dirname(target);
      if (!verifiedDirs.has(parent)) {
        await fs.ensureDir(parent);
        if (!isPhysicallyInside(root, parent)) illegal("Entry escapes the instance directory");
        verifiedDirs.add(parent);
      }
      const st = await fs.lstat(target).catch(() => null);
      if (st && st.isSymbolicLink()) illegal("Entry escapes the instance directory");
      const stream = await zip.stream(e.name);
      await pipeline(stream, fs.createWriteStream(target, { mode: 0o644 }), { signal });
      if (e.mode) await fs.chmod(target, e.mode & 0o777).catch(() => undefined);
      done += e.size;
      options.onProgress?.(done, totalBytes);
    }
    if (options.afterExtract) await options.afterExtract(tops.map((t) => path.join(root, t)));
    await fs.remove(rollbackDir);
    return { restored: tops };
  } catch (err) {
    // Put the previous files back.
    let rollbackFailed = false;
    for (const top of touchedTops) {
      try {
        const abs = path.join(root, top);
        if (moved.includes(top)) {
          await fs.remove(abs);
          await fs.rename(path.join(rollbackDir, top), abs);
        } else if (await fs.pathExists(abs)) {
          await fs.remove(abs);
        }
      } catch {
        rollbackFailed = true;
      }
    }
    if (!rollbackFailed) await fs.remove(rollbackDir).catch(() => undefined);
    if (signal?.aborted) throw new BackupError(BackupErrorCode.CANCELLED, "Restore cancelled");
    if (rollbackFailed && err instanceof Error) {
      err.message += " (rollback incomplete, previous files kept in the rollback directory)";
    }
    throw err;
  } finally {
    await zip.close().catch(() => undefined);
  }
}
