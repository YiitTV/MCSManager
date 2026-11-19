import fs from "fs-extra";
import {
  BackupDriverCallOptions,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupGetRequest,
  BackupHeadResult,
  BackupPutRequest,
  BackupPutResult,
  BackupTestResult,
  BackupDestinationType,
  DestinationDriver
} from "mcsmanager-common";

/** In-memory DestinationDriver for tests. */
export class FakeDriver implements DestinationDriver {
  readonly objects = new Map<string, Buffer>();
  readonly removed: string[] = [];
  putCalls = 0;
  /** Number of leading put calls that throw a transient error. */
  transientFailures = 0;
  /** Fail every put with this code. */
  failPutWith?: BackupDriverErrorCode;
  failRemove = false;
  putDelayMs = 0;

  constructor(public readonly type: BackupDestinationType = "s3") {}

  async test(): Promise<BackupTestResult> {
    return { ok: true };
  }

  async put(req: BackupPutRequest): Promise<BackupPutResult> {
    this.putCalls++;
    if (req.signal?.aborted) throw new BackupDriverError(BackupDriverErrorCode.ABORTED, "aborted");
    if (this.putDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.putDelayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new BackupDriverError(BackupDriverErrorCode.ABORTED, "aborted"));
        });
      });
    }
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "HTTP 503");
    }
    if (this.failPutWith) throw new BackupDriverError(this.failPutWith, "failed upload");
    const key = `${req.object.instanceUuid}/${req.object.planId}/${req.object.backupId}.zip`;
    this.objects.set(key, await fs.readFile(req.filePath));
    req.onProgress?.(req.sizeBytes, req.sizeBytes);
    return { remoteId: key, sizeBytes: req.sizeBytes };
  }

  async head(remoteId: string): Promise<BackupHeadResult> {
    const o = this.objects.get(remoteId);
    return o ? { exists: true, sizeBytes: o.length } : { exists: false };
  }

  async get(req: BackupGetRequest): Promise<void> {
    const o = this.objects.get(req.remoteId);
    if (!o) throw new BackupDriverError(BackupDriverErrorCode.NOT_FOUND, "missing");
    await fs.writeFile(req.destPath, o);
  }

  async remove(remoteId: string, _o?: BackupDriverCallOptions): Promise<void> {
    if (this.failRemove) throw new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "HTTP 500");
    this.removed.push(remoteId);
    this.objects.delete(remoteId);
  }
}
