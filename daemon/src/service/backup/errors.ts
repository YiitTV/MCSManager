import { BackupErrorCode, sanitizeBackupError } from "mcsmanager-common";

/** Error carrying a machine readable backup code. `message` is already sanitized. */
export class BackupError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = "BackupError";
  }

  /** Wire form used by protocol.responseError: `<CODE>: <message>` (panel parses the prefix). */
  override toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** Map any thrown value to a code + sanitized text (never leaks secrets or URLs). */
export function toBackupFailure(
  error: unknown,
  secretValues: readonly string[] = []
): { code: BackupErrorCode; text: string } {
  if (error instanceof BackupError) {
    return { code: error.code, text: sanitizeBackupError(error, secretValues) };
  }
  return { code: BackupErrorCode.INTERNAL, text: sanitizeBackupError(error, secretValues) };
}

/** Convert the reason of an aborted signal to a BackupError (CANCELLED unless a reason is set). */
export function abortError(signal?: AbortSignal): BackupError {
  const reason = signal?.reason;
  if (reason instanceof BackupError) return reason;
  return new BackupError(BackupErrorCode.CANCELLED, "Backup cancelled");
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}
