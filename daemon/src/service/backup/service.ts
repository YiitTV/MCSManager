import fs from "fs-extra";
import path from "path";
import Instance from "../../entity/instance/instance";
import { globalConfiguration } from "../../entity/config";
import { StorageSubsystem } from "mcsmanager-common";
import {
  resolveInstanceFileOwnership,
  syncPathOwnershipWithinRoot
} from "../../tools/file_ownership";
import { broadcast, hasAuthenticatedPanel } from "../authenticated_sockets";
import logger from "../log";
import InstanceSubsystem from "../system_instance";
import { createDestinationDriver } from "./driver_factory";
import { BackupJobRunner, RunnerInstance } from "./job_runner";
import { BackupQueue } from "./queue";
import { backupIndexStore } from "./stores";

function adaptInstance(instance: Instance): RunnerInstance {
  return {
    get name() {
      return instance.config.nickname;
    },
    absoluteCwdPath: () => instance.absoluteCwdPath(),
    isStopped: () => instance.status() === Instance.STATUS_STOP,
    isRunning: () => instance.status() === Instance.STATUS_RUNNING,
    sendCommand: (command: string) => instance.execPreset("command", command),
    onOutput: (listener) => {
      instance.on("data", listener);
      return () => void instance.off("data", listener);
    }
  };
}

/** chown every restored path (docker `runAs` instances), staying inside the instance directory. */
async function syncRestoredOwnership(instanceUuid: string, tops: string[]) {
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  if (!instance) return;
  const ownership = await resolveInstanceFileOwnership(instance);
  if (!ownership) return;
  const root = instance.absoluteCwdPath();
  const stack = [...tops];
  while (stack.length > 0) {
    const p = stack.pop()!;
    try {
      await syncPathOwnershipWithinRoot(root, p, ownership);
      const st = await fs.lstat(p);
      if (st.isDirectory()) {
        for (const n of await fs.readdir(p)) stack.push(path.join(p, n));
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
}

let runner: BackupJobRunner | undefined;

/** Lazily built singleton wired to the real instance system, storage and sockets. */
export function getBackupRunner(): BackupJobRunner {
  if (!runner) {
    runner = new BackupJobRunner({
      getInstance: (uuid) => {
        const instance = InstanceSubsystem.getInstance(uuid);
        return instance?.config ? adaptInstance(instance) : undefined;
      },
      store: backupIndexStore,
      queue: new BackupQueue(),
      driverFactory: createDestinationDriver,
      stagingDir: path.join(StorageSubsystem.DATA_PATH, "BackupStaging"),
      broadcast,
      hasPanel: hasAuthenticatedPanel,
      instanceDirs: () =>
        InstanceSubsystem.getInstances()
          .filter((i) => i.config?.cwd)
          .map((i) => i.absoluteCwdPath()),
      dataDir: StorageSubsystem.DATA_PATH,
      maxUncompressedBytes: () => globalConfiguration.config.maxZipFileSize * 1024 * 1024 * 1024,
      afterRestoreExtract: syncRestoredOwnership
    });
  }
  return runner;
}

/** Startup hook: clean staging and fail jobs interrupted by a restart. */
export function initBackupService() {
  getBackupRunner()
    .recover()
    .catch((err) => logger.error(`Backup service recovery failed: ${String(err)}`));
}
