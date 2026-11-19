import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { startS3Mock } from "../fixtures/s3_mock";
import {
  backupStaging,
  createBackupAdmin,
  createBackupPlan,
  localBackups,
  sha256File
} from "../lib/backups";
import { sleep, world } from "../lib";

const MIB = 1024 * 1024;

async function writeLargeFile(file: string) {
  const block = randomBytes(MIB);
  const output = await fs.open(file, "w");
  try {
    for (let i = 0; i < 1024; i++) {
      let offset = 0;
      while (offset < block.length) {
        const { bytesWritten } = await output.write(block, offset, block.length - offset);
        offset += bytesWritten;
      }
    }
  } finally {
    await output.close();
  }
}

it("streams a 1 GiB tree to local and multipart S3 with bounded daemon RSS", async () => {
  await createBackupAdmin();
  const mock = await startS3Mock(path.join(world.workDir, "s3-memory"));
  try {
    const backup = await createBackupPlan(mock.endpoint);
    const data = path.join(backup.cwd, "memory-test.bin");
    try {
      await fs.mkdir(backup.cwd, { recursive: true });
      await writeLargeFile(data);
      expect((await fs.stat(data)).size).toBe(1024 * MIB);
      const pid = world.daemonPid;
      expect(pid).toBeGreaterThan(0);
      const rss = () => {
        const kib = Number(
          execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()
        );
        if (!Number.isFinite(kib) || kib <= 0) throw new Error("Daemon RSS unavailable");
        return kib / 1024;
      };
      const baseline = rss();
      const samples: number[] = [];
      let samplingError: unknown;
      const timer = setInterval(() => {
        try {
          samples.push(rss());
        } catch (error) {
          samplingError = error;
        }
      }, 500);
      const record = await backup.run().finally(() => clearInterval(timer));
      if (samplingError) throw samplingError;
      const peak = Math.max(baseline, ...samples, rss());
      expect(samples.length).toBeGreaterThan(1);

      // V8 and the native allocator can retain reusable memory after streaming.
      // Keep sampling the idle daemon for at most 20 s and require recovery within 100 MiB.
      let settled = rss();
      for (let i = 0; i < 40 && settled - baseline >= 100; i++) {
        await sleep(500);
        settled = rss();
      }
      console.info(
        `Daemon RSS MiB baseline=${baseline.toFixed(1)} peak=${peak.toFixed(1)} ` +
          `settled=${settled.toFixed(1)} growth=${(peak - baseline).toFixed(1)} samples=${
            samples.length
          }`
      );
      expect(peak - baseline).toBeLessThan(300);
      expect(settled - baseline).toBeLessThan(100);

      expect(record.copies.local.status).toBe("ok");
      expect(record.copies[backup.s3Id].status).toBe("ok");
      expect(
        mock.requests.filter((r) => r.method === "PUT" && r.query.includes("partNumber=")).length
      ).toBeGreaterThan(1);
      expect(mock.uploads.size).toBe(0);
      expect(mock.objects.size).toBe(1);
      expect(await fs.readdir(backupStaging())).toEqual([]);
      const local = path.join(localBackups(), record.copies.local.remoteId!);
      const remote = mock.objects.get(record.copies[backup.s3Id].remoteId!)!;
      expect(await sha256File(local)).toBe(record.sha256);
      expect(await sha256File(remote)).toBe(record.sha256);
    } finally {
      await fs.rm(data, { force: true });
    }
  } finally {
    await mock.close();
  }
}, 180_000);
