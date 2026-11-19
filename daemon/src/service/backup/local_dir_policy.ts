import fs from "fs-extra";
import path from "path";
import { BackupErrorCode } from "mcsmanager-common";
import { resolvePhysicalPath } from "../../tools/path_link_check";
import { BackupError } from "./errors";

export interface LocalDirPolicy {
  /** Absolute working directories of every instance on this daemon. */
  instanceDirs?: () => string[];
  /** Daemon data directory; only `<dataDir>/Backups` may be used inside it. */
  dataDir?: string;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

function refuse(reason: string): never {
  throw new BackupError(BackupErrorCode.INVALID_REQUEST, `local_directory_invalid: ${reason}`);
}

/**
 * Daemon-side check of a `local` destination directory: absolute, existing (or creatable),
 * a directory, writable, and not inside an instance directory or the daemon data directory
 * (except `<data>/Backups`). Symlinks are resolved first. Throws `BACKUP_INVALID_REQUEST` with
 * message `local_directory_invalid: <reason>`.
 */
export function assertLocalDirectoryAllowed(directory: string, policy: LocalDirPolicy = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) {
    refuse("not_absolute");
  }
  const resolved = resolvePhysicalPath(path.normalize(directory));
  if (!resolved) refuse("unresolvable");

  // Nearest existing ancestor must be a writable directory.
  let probe = resolved;
  for (;;) {
    try {
      const st = fs.statSync(probe);
      if (!st.isDirectory()) refuse(probe === resolved ? "not_a_directory" : "not_creatable");
      fs.accessSync(probe, fs.constants.W_OK);
      break;
    } catch (err) {
      if (err instanceof BackupError) throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") refuse("not_writable");
      const parent = path.dirname(probe);
      if (parent === probe) refuse("not_creatable");
      probe = parent;
    }
  }

  for (const dir of policy.instanceDirs?.() ?? []) {
    const real = resolvePhysicalPath(path.resolve(dir));
    if (real && isInside(real, resolved)) refuse("inside_instance_directory");
  }
  if (policy.dataDir) {
    const data = resolvePhysicalPath(path.resolve(policy.dataDir));
    if (data && isInside(data, resolved) && !isInside(path.join(data, "Backups"), resolved)) {
      refuse("inside_daemon_data");
    }
  }
}
