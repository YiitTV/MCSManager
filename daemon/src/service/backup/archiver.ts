import archiver from "archiver";
import crypto from "crypto";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { pipeline, Transform, TransformCallback } from "stream";
import {
  BACKUP_ARCHIVE,
  BackupErrorCode,
  compileExcludeMatcher,
  normalizeBackupIncludePath
} from "mcsmanager-common";
import { abortError, BackupError, throwIfAborted } from "./errors";
import { pathExistsNoFollow, resolveIncludePath } from "./safe_path";

/** Yield to the event loop every this many files. */
const YIELD_EVERY = 64;
/** Max entries appended to the archiver but not yet written. */
const MAX_PENDING_ENTRIES = 32;

export interface WalkOptions {
  rootDir: string;
  include: readonly string[];
  exclude: readonly string[];
  /** Absolute directories never entered (staging dir, local destination dirs). */
  skipAbsolute?: readonly string[];
  signal?: AbortSignal;
}

export interface WalkEntry {
  kind: "file" | "dir";
  abs: string;
  /** Instance-relative path with `/` separators. */
  rel: string;
  size: number;
  stats: fs.Stats;
}

export interface WalkSummary {
  /** Include paths that did not exist. */
  missing: string[];
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Bounded iterative walker. Directories are read with `opendir` (one entry at a time), only
 * `lstat` is used, symlinks are never followed or yielded, and the loop yields every 64 files.
 */
export async function* walkInstanceFiles(
  options: WalkOptions,
  summary: WalkSummary = { missing: [] }
): AsyncGenerator<WalkEntry, WalkSummary> {
  const { rootDir, signal } = options;
  const matcher = compileExcludeMatcher(options.exclude);
  const skip = new Set((options.skipAbsolute ?? []).map((p) => path.resolve(p)));
  const seenRel = new Set<string>();
  let counter = 0;

  // Resolve every include path first so an illegal one fails before any file is read.
  const roots: { abs: string; rel: string }[] = [];
  for (const inc of options.include) {
    const abs = resolveIncludePath(rootDir, inc);
    const rel = normalizeBackupIncludePath(inc);
    roots.push({ abs, rel: rel === "." ? "" : rel });
  }

  for (const start of roots) {
    throwIfAborted(signal);
    const st = await pathExistsNoFollow(start.abs);
    if (!st) {
      summary.missing.push(start.rel === "" ? "." : start.rel);
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const stack: { abs: string; rel: string; stats: fs.Stats }[] = [
      { abs: start.abs, rel: start.rel, stats: st }
    ];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.rel !== "" && matcher(cur.rel)) continue;
      if (skip.has(path.resolve(cur.abs))) continue;
      if (cur.stats.isDirectory()) {
        if (cur.rel !== "" && !seenRel.has(cur.rel)) {
          seenRel.add(cur.rel);
          yield { kind: "dir", abs: cur.abs, rel: cur.rel, size: 0, stats: cur.stats };
        }
        let dir: fs.Dir;
        try {
          dir = await fs.promises.opendir(cur.abs);
        } catch (err: any) {
          if (err?.code === "ENOENT" || err?.code === "EACCES" || err?.code === "EPERM") continue;
          throw err;
        }
        try {
          for await (const dirent of dir) {
            if (++counter % YIELD_EVERY === 0) {
              await yieldLoop();
              throwIfAborted(signal);
            }
            if (dirent.name.startsWith(BACKUP_ARCHIVE.ROLLBACK_DIR_PREFIX)) continue;
            if (dirent.isSymbolicLink()) continue;
            const abs = path.join(cur.abs, dirent.name);
            const rel = cur.rel === "" ? dirent.name : `${cur.rel}/${dirent.name}`;
            let stats: fs.Stats;
            try {
              stats = await fs.lstat(abs);
            } catch {
              continue;
            }
            if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) continue;
            stack.push({ abs, rel, stats });
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
      } else if (cur.stats.isFile()) {
        if (seenRel.has(cur.rel)) continue;
        seenRel.add(cur.rel);
        yield { kind: "file", abs: cur.abs, rel: cur.rel, size: cur.stats.size, stats: cur.stats };
      }
    }
  }
  return summary;
}

export interface ScanResult {
  totalBytes: number;
  fileCount: number;
  missing: string[];
}

/** First pass: total size of the files that would be archived (no list kept in memory). */
export async function scanInstanceFiles(options: WalkOptions): Promise<ScanResult> {
  const summary: WalkSummary = { missing: [] };
  let totalBytes = 0;
  let fileCount = 0;
  const gen = walkInstanceFiles(options, summary);
  for await (const e of gen) {
    if (e.kind === "file") {
      totalBytes += e.size;
      fileCount++;
    }
  }
  return { totalBytes, fileCount, missing: summary.missing };
}

export interface ArchiveOptions extends WalkOptions {
  /** Staging file to write (`<backupId>.zip.tmp`). */
  outPath: string;
  /** Called with archived input bytes and the scan total. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  totalBytes?: number;
}

export interface ArchiveResult {
  sizeBytes: number;
  sha256: string;
  fileCount: number;
  missing: string[];
}

class HashCountTransform extends Transform {
  readonly hash = crypto.createHash("sha256");
  bytes = 0;
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/**
 * Stream a zip (level 1, zip64) of the selected files into `outPath`, hashing while writing.
 * Never buffers a whole file; appends are bounded by waiting for `entry` events.
 */
export async function createArchive(options: ArchiveOptions): Promise<ArchiveResult> {
  const { signal } = options;
  throwIfAborted(signal);
  // Illegal include paths fail before any file or staging file is touched.
  for (const inc of options.include) resolveIncludePath(options.rootDir, inc);
  await fs.ensureDir(path.dirname(options.outPath));

  const archive = archiver("zip", {
    zlib: { level: BACKUP_ARCHIVE.ZLIB_LEVEL },
    forceZip64: true
  });
  const hasher = new HashCountTransform();
  const out = fs.createWriteStream(options.outPath, { flags: "w", mode: 0o600 });

  let failure: Error | undefined;
  const piped = new Promise<void>((resolve, reject) => {
    pipeline(archive, hasher, out, (err) => (err ? reject(err) : resolve()));
  });
  piped.catch(() => undefined);
  archive.on("warning", (err: any) => {
    // ENOENT: a file vanished between the walk and the read; everything else is fatal.
    if (err?.code !== "ENOENT") failure = err;
  });
  const onAbort = () => {
    failure = abortError(signal);
    archive.destroy(failure);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let appended = 0;
  let entered = 0;
  let waiter: (() => void) | undefined;
  archive.on("entry", () => {
    entered++;
    if (waiter && appended - entered < MAX_PENDING_ENTRIES) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  });
  let doneBytes = 0;
  const missing: string[] = [];
  let fileCount = 0;

  try {
    const walk = walkInstanceFiles(options, { missing });
    for await (const entry of walk) {
      if (failure) break;
      if (entry.kind === "dir") {
        archive.append("", { name: entry.rel + "/", date: entry.stats.mtime, mode: 0o755 });
      } else {
        archive.file(entry.abs, { name: entry.rel, stats: entry.stats as any });
        fileCount++;
        doneBytes += entry.size;
        options.onProgress?.(doneBytes, options.totalBytes ?? 0);
      }
      appended++;
      if (appended - entered >= MAX_PENDING_ENTRIES) {
        await new Promise<void>((resolve) => {
          waiter = resolve;
          // Re-check in case the archive finished meanwhile or failed.
          setImmediate(() => {
            if (failure && waiter) {
              waiter = undefined;
              resolve();
            }
          });
        });
      }
    }
    if (failure) throw failure;
    if (fileCount === 0 && appended === 0) {
      throw new BackupError(BackupErrorCode.NOTHING_TO_BACKUP, "No include path exists");
    }
    await archive.finalize();
    await piped;
    if (failure) throw failure;
  } catch (err) {
    archive.destroy();
    await new Promise<void>((resolve) => {
      if (out.closed) return resolve();
      out.once("close", () => resolve());
      out.destroy();
    });
    await fs.remove(options.outPath).catch(() => undefined);
    if (signal?.aborted) throw abortError(signal);
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (missing.length > 0 && fileCount === 0 && appended === 0) {
    await fs.remove(options.outPath).catch(() => undefined);
    throw new BackupError(BackupErrorCode.NOTHING_TO_BACKUP, "No include path exists");
  }
  return {
    sizeBytes: hasher.bytes,
    sha256: hasher.hash.digest("hex"),
    fileCount,
    missing
  };
}

/** Lower the CPU priority of the process while a job runs. Returns a restore function. */
export function lowerPriority(
  nice = 10,
  api: Pick<typeof os, "getPriority" | "setPriority"> = os
): () => void {
  let previous: number | undefined;
  try {
    previous = api.getPriority(0);
    api.setPriority(0, Math.max(previous, nice));
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (previous !== undefined) api.setPriority(0, previous);
    } catch {
      // Raising priority back may need privileges; ignore.
    }
  };
}
