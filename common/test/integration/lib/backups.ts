import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { BackupJobStatus, BackupPlan, BackupRecord } from "../../../src/backup";
import { adm, createInstance, di, ensureUser, requestPanel, waitFor, world } from ".";
import type { CallOpts, RawRes } from "./http";

export const localBackups = () => path.join(world.workDir, "daemon/data/Backups");
export const backupStaging = () => path.join(world.workDir, "daemon/data/BackupStaging");
export const instanceDir = (uuid: string) =>
  path.join(world.workDir, "daemon/data/InstanceData", uuid);

export const backupApi = (
  method: CallOpts["method"],
  route: string,
  options: Pick<CallOpts, "body" | "query"> = {}
) => requestPanel({ method, path: `/backup/${route}`, ...adm(), ...options });

export function success<T>(response: RawRes): T {
  // Report statuses only. Some successful responses carry credentials or download tickets.
  // Error responses carry only a translated message, so show it to make failures diagnosable.
  const detail = response.status === 200 ? "" : ` data=${JSON.stringify(response.data)}`;
  expect([response.httpStatus, response.status], `unexpected status${detail}`).toEqual([200, 200]);
  return response.data;
}

export async function createBackupAdmin() {
  const uuid = await ensureUser("admin", world.key, 0);
  success(
    await requestPanel({
      method: "PUT",
      path: "/auth",
      key: world.key,
      body: { uuid, config: { permission: 10 } }
    })
  );
}

export function s3Destination(endpoint: string) {
  return {
    type: "s3",
    name: "Integration S3",
    config: {
      endpoint,
      region: "us-east-1",
      bucket: "mcsm-backup-test",
      prefix: "integration",
      accessKeyId: "INTEGRATIONACCESS",
      pathStyle: true,
      allowPrivateNetwork: true
    },
    secrets: { secretAccessKey: "integration-fixture-secret" }
  };
}

export async function createBackupPlan(endpoint: string, minecraftSaveHook = false) {
  const { id: s3Id } = success<{ id: string }>(
    await backupApi("POST", "destinations", {
      body: s3Destination(endpoint)
    })
  );
  const uuid = await createInstance("Backup integration", {
    terminalOption: { haveColor: false, pty: false, ptyWindowCol: 164, ptyWindowRow: 40 }
  });
  const ref = { daemonId: di(), uuid };
  const plan = success<BackupPlan>(
    await backupApi("POST", "plans", {
      body: {
        ...ref,
        name: "Integration backup",
        preset: "whole-directory",
        retention: 2,
        destinationIds: ["local", s3Id],
        minecraftSaveHook,
        enabled: true
      }
    })
  );

  const records = async () =>
    success<BackupRecord[]>(await backupApi("GET", "records", { query: ref }));
  // GET /jobs returns { running?, queued[] } (BackupStatusRes), not an array.
  const jobs = async (): Promise<BackupJobStatus[]> => {
    const res = success<{ running?: BackupJobStatus; queued?: BackupJobStatus[] }>(
      await backupApi("GET", "jobs", { query: ref })
    );
    return [...(res.running ? [res.running] : []), ...(res.queued ?? [])];
  };
  const waitForJob = (id: string) =>
    waitFor(async () => !(await jobs()).some((job) => job.backupId === id), {
      timeout: 150_000,
      interval: 250,
      msg: `backup job ${id} to finish`
    });
  const run = async (planId = plan.id) => {
    const { backupId } = success<{ backupId: string }>(
      await backupApi("POST", "run", {
        body: { ...ref, planId }
      })
    );
    await waitForJob(backupId);
    const record = (await records()).find((entry) => entry.id === backupId);
    expect(record, `record for ${backupId}`).toBeDefined();
    return record!;
  };
  return { ref, plan, s3Id, cwd: instanceDir(uuid), records, waitForJob, run };
}

export async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
