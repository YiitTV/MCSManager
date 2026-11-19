import fs from "fs-extra";
import path from "path";
import {
  BackupErrorCode,
  checkBackupIncludePath,
  normalizeBackupIncludePath
} from "mcsmanager-common";
import { resolvePhysicalPath } from "../../tools/path_link_check";
import { BackupError } from "./errors";

/** True if `target` physically resolves inside `root` (same primitive FileManager uses). */
export function isPhysicallyInside(root: string, target: string): boolean {
  const realRoot = resolvePhysicalPath(path.resolve(root));
  const realTarget = resolvePhysicalPath(path.resolve(target));
  if (!realRoot || !realTarget) return false;
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

/**
 * Resolve an instance-relative include path to an absolute path, refusing anything illegal or
 * physically outside the instance directory (symlinked parents included).
 */
export function resolveIncludePath(rootDir: string, include: string): string {
  if (checkBackupIncludePath(include) !== null) {
    throw new BackupError(BackupErrorCode.ILLEGAL_PATH, "Illegal include path");
  }
  const rel = normalizeBackupIncludePath(include);
  const abs = path.resolve(rootDir, rel === "." ? "" : rel);
  if (!isPhysicallyInside(rootDir, abs)) {
    throw new BackupError(BackupErrorCode.ILLEGAL_PATH, "Illegal include path");
  }
  return abs;
}

export async function pathExistsNoFollow(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}
