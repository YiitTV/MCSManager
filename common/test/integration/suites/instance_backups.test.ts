import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import StreamZip from "node-stream-zip";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_PROTOCOL,
  BACKUP_SECRET_MASK,
  BackupErrorCode,
  type BackupFinishedPayload,
  type BackupRecord
} from "../../../src/backup";
import { startS3Mock } from "../fixtures/s3_mock";
import {
  backupApi,
  createBackupAdmin,
  createBackupPlan,
  localBackups,
  s3Destination,
  sha256File,
  success
} from "../lib/backups";
import { adm, daemonBase, requestPanel, RUNNING, STOPPED, waitFor, world } from "../lib";

const tree = {
  "world/level.dat": "overworld data",
  "world_nether/region/r.0.0.mca": "nether data",
  "plugins/example/config.yml": "enabled: true"
};

describe("instance backups through real panel and daemon", () => {
  let mock: Awaited<ReturnType<typeof startS3Mock>>;
  let backup: Awaited<ReturnType<typeof createBackupPlan>>;
  let newest: BackupRecord;
  let observer: Socket | undefined;
  const finished: BackupFinishedPayload[] = [];
  const restores: { jobId: string; ok: boolean; errorCode?: BackupErrorCode }[] = [];

  const localFile = (record: BackupRecord) =>
    path.join(localBackups(), record.copies.local.remoteId!);
  const s3Key = (record: BackupRecord) =>
    `integration/${backup.ref.uuid}/${backup.plan.id}/${record.id}.zip`;
  const instance = (route: string) =>
    requestPanel({
      method: "GET",
      path: route,
      ...adm(),
      query: backup.ref
    });
  const waitStatus = (status: number) =>
    waitFor(
      async () => {
        const detail = success<{ status: number }>(await instance("/instance"));
        expect(detail.status).toBe(status);
        return true;
      },
      { timeout: 30_000, msg: `waiting for instance status ${status}` }
    );
  const restore = (record: BackupRecord) =>
    backupApi("POST", "restore", {
      body: { ...backup.ref, recordId: record.id }
    });
  async function restoreStopped(record: BackupRecord) {
    await waitStatus(STOPPED);
    const { jobId } = success<{ jobId: string }>(await restore(record));
    const result = await waitFor(() => restores.find((event) => event.jobId === jobId), {
      msg: `waiting for restore job ${jobId} result`
    });
    await backup.waitForJob(jobId);
    return result;
  }
  async function assertTree() {
    for (const [file, contents] of Object.entries(tree)) {
      expect(await fs.readFile(path.join(backup.cwd, file), "utf8")).toBe(contents);
    }
  }

  beforeAll(async () => {
    await createBackupAdmin();
    mock = await startS3Mock(path.join(world.workDir, "s3-backups"));
    backup = await createBackupPlan(mock.endpoint, true);

    // Observe daemon completion messages as an authenticated panel would.
    const { key } = JSON.parse(
      await fs.readFile(path.join(world.workDir, "daemon/data/Config/global.json"), "utf8")
    );
    observer = io(world.daemonHttpUrl, { transports: ["websocket"], reconnection: false });
    let authenticated = false;
    observer.once("connect", () => observer?.emit("auth", { data: key }));
    observer.once("auth", (packet) => {
      authenticated = packet.data === true;
    });
    observer.on(BACKUP_PROTOCOL.FINISHED, (packet) => finished.push(packet.data));
    observer.on("backup/restore_finished", (packet) => restores.push(packet.data));
    await waitFor(() => authenticated, { timeout: 10_000, msg: "backup observer authenticated" });
    for (const [file, contents] of Object.entries({ ...tree, "logs/server.log": "excluded" })) {
      const target = path.join(backup.cwd, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }
    const outside = path.join(world.workDir, "outside-backup.txt");
    await fs.writeFile(outside, "outside instance");
    await fs.symlink(outside, path.join(backup.cwd, "world/outside-link"));
  });

  afterAll(async () => {
    observer?.close();
    await mock?.close();
  });

  it("tests the S3 destination with signed PUT, HEAD and DELETE", async () => {
    const start = mock.requests.length;
    const result = success<{ ok: boolean }>(
      await backupApi("POST", "destinations/test", {
        body: { daemonId: backup.ref.daemonId, destination: s3Destination(mock.endpoint) }
      })
    );
    expect(result.ok).toBe(true);
    expect(mock.requests.slice(start).map(({ method, status }) => [method, status])).toEqual([
      ["PUT", 200],
      ["HEAD", 200],
      ["DELETE", 204]
    ]);
    expect(mock.objects.size).toBe(0);
  });

  it("keeps the newest two of four backups per destination and archives only eligible files", async () => {
    const runs: BackupRecord[] = [];
    for (let i = 0; i < 4; i++) {
      const record = await backup.run();
      expect(record.copies.local.status).toBe("ok");
      expect(record.copies[backup.s3Id].status).toBe("ok");
      expect(record.copies[backup.s3Id].remoteId).toBe(s3Key(record));
      runs.push(record);
    }
    newest = runs[3];
    const kept = runs.slice(-2);
    const records = await backup.records();
    for (const id of ["local", backup.s3Id]) {
      expect(
        records
          .filter((record) => record.copies[id]?.status === "ok")
          .map((r) => r.id)
          .sort()
      ).toEqual(kept.map((r) => r.id).sort());
    }
    expect([...mock.objects.keys()].sort()).toEqual(kept.map(s3Key).sort());
    expect(
      (await fs.readdir(localBackups())).filter((name) => name.endsWith(".zip")).sort()
    ).toEqual(kept.map((r) => path.basename(localFile(r))).sort());

    for (const record of kept) {
      const archive = localFile(record);
      expect(await sha256File(archive)).toBe(record.sha256);
      expect(await sha256File(mock.objects.get(s3Key(record))!)).toBe(record.sha256);
      const zip = new StreamZip.async({ file: archive });
      try {
        const allEntries = Object.values(await zip.entries());
        expect(allEntries.some(({ name }) => name === "logs" || name.startsWith("logs/"))).toBe(
          false
        );
        const entries = allEntries.filter((entry) => !entry.isDirectory);
        expect(entries.map((entry) => entry.name).sort()).toEqual(Object.keys(tree).sort());
        for (const [name, contents] of Object.entries(tree)) {
          expect((await zip.entryData(name)).toString()).toBe(contents);
        }
      } finally {
        await zip.close();
      }
    }
  });

  it("records partial failure after S3 500 retries and preserves both older S3 copies", async () => {
    const keys = [...mock.objects.keys()].sort();
    const start = mock.requests.length;
    // Keep the outage active through both the driver's and the job runner's retries.
    mock.failNext(100, 500);
    try {
      const record = await backup.run();
      expect(record.copies.local.status).toBe("ok");
      expect(record.copies[backup.s3Id].status).toBe("failed");
      expect(record.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/^destination_failed:/)])
      );
      const event = await waitFor(() => finished.find((entry) => entry.record.id === record.id));
      const events = finished.filter((entry) => entry.record.id === record.id);
      expect(events).toHaveLength(1);
      expect(event).toMatchObject({ record });
      expect(event?.errorCode).toBeUndefined();
      const attempts = mock.requests.slice(start);
      expect(attempts.length).toBeGreaterThan(1);
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({ method: "PUT", key: s3Key(record), status: 500 });
      }
      expect([...mock.objects.keys()].sort()).toEqual(keys);
      const records = await backup.records();
      expect(
        records
          .filter((r) => r.copies.local?.status === "ok")
          .map((r) => r.id)
          .sort()
      ).toEqual([newest.id, record.id].sort());
      expect(
        records
          .filter((r) => r.copies[backup.s3Id]?.status === "ok")
          .map((r) => r.copies[backup.s3Id].remoteId)
          .sort()
      ).toEqual(keys);
    } finally {
      mock.failNext(0, 500);
    }
  }, 100_000);

  it("reports total failure when the only destination refuses the upload", async () => {
    const plan = success<{ id: string }>(
      await backupApi("POST", "plans", {
        body: { ...backup.plan, name: "S3-only failure", destinationIds: [backup.s3Id] }
      })
    );
    const keys = [...mock.objects.keys()].sort();
    mock.failNext(1, 403);
    try {
      const record = await backup.run(plan.id);
      expect(Object.keys(record.copies)).toEqual([backup.s3Id]);
      expect(record.copies[backup.s3Id].status).toBe("failed");
      const event = await waitFor(() => finished.find((entry) => entry.record.id === record.id));
      expect(event).toMatchObject({
        errorCode: BackupErrorCode.ALL_DESTINATIONS_FAILED,
        errorSummary: expect.stringContaining("HTTP 403")
      });
      expect([...mock.objects.keys()].sort()).toEqual(keys);
    } finally {
      mock.failNext(0, 403);
    }
  });

  it("downloads the local archive with a single-use ticket and matching SHA-256", async () => {
    const ticket = success<{ addr: string; password: string; fileName: string; sizeBytes: number }>(
      await backupApi("POST", "download", { body: { ...backup.ref, recordId: newest.id } })
    );
    expect(ticket.addr).toBeTruthy();
    expect(ticket.fileName).toBe(path.basename(localFile(newest)));
    expect(ticket.sizeBytes).toBe(newest.sizeBytes);
    const addr = daemonBase(ticket.addr);
    const url = `${addr}/download/${ticket.password}/${encodeURIComponent(ticket.fileName)}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(newest.sizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(newest.sha256);
    const replay = await fetch(url);
    await replay.body?.cancel();
    expect(replay.ok).toBe(false);
  });

  it("runs the Minecraft save commands in order and refuses restore while running", async () => {
    await fs.copyFile(
      path.join(__dirname, "../fixtures/backup_server.mjs"),
      path.join(backup.cwd, "test.mjs")
    );
    success(await instance("/protected_instance/open"));
    try {
      await waitStatus(RUNNING);
      const output = async () => success<string>(await instance("/protected_instance/outputlog"));
      await waitFor(async () => (await output()).includes("READY"), {
        timeout: 15_000,
        msg: "waiting for Minecraft fixture readiness"
      });
      const refused = await restore(newest);
      expect([refused.httpStatus, refused.status]).toEqual([409, 409]);
      const record = await backup.run();
      expect(record.copies.local.status).toBe("ok");
      expect(record.warnings.filter((warning) => warning.startsWith("save_"))).toEqual([]);
      const lines = await waitFor(
        async () => {
          const text = await output();
          return text.includes("COMMAND:save-on") && text.match(/COMMAND:save-[^\r\n]+/g);
        },
        { timeout: 15_000, msg: "waiting for Minecraft save-on" }
      );
      expect(lines).toEqual(["COMMAND:save-off", "COMMAND:save-all flush", "COMMAND:save-on"]);
      newest = record;
    } finally {
      success(await instance("/protected_instance/stop"));
      await waitStatus(STOPPED);
    }
  });

  it("restores modified and deleted files on a stopped instance", async () => {
    await fs.writeFile(path.join(backup.cwd, "world/level.dat"), "modified");
    await fs.rm(path.join(backup.cwd, "world_nether/region/r.0.0.mca"));
    await fs.writeFile(path.join(backup.cwd, "logs/server.log"), "unarchived change");
    expect(await restoreStopped(newest)).toMatchObject({ ok: true });
    await assertTree();
    expect(await fs.readFile(path.join(backup.cwd, "logs/server.log"), "utf8")).toBe(
      "unarchived change"
    );
    await expect(fs.lstat(path.join(backup.cwd, "world/outside-link"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await fs.readFile(path.join(world.workDir, "outside-backup.txt"), "utf8")).toBe(
      "outside instance"
    );
  });

  it("restores from S3 when the local archive is absent", async () => {
    const archive = localFile(newest);
    const parked = `${archive}.parked`;
    const start = mock.requests.length;
    await fs.rename(archive, parked);
    try {
      await fs.writeFile(path.join(backup.cwd, "world/level.dat"), "modified again");
      expect(await restoreStopped(newest)).toMatchObject({ ok: true });
      await assertTree();
      expect(mock.requests.slice(start)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "GET", key: s3Key(newest), status: 200 })
        ])
      );
    } finally {
      await fs.rename(parked, archive);
    }
  });

  it("rejects a corrupted archive before touching the live files", async () => {
    const archive = localFile(newest);
    const original = await fs.readFile(archive);
    const corrupt = Buffer.from(original);
    corrupt[0] ^= 0xff;
    await fs.writeFile(archive, corrupt);
    const sentinel = path.join(backup.cwd, "world/level.dat");
    await fs.writeFile(sentinel, "must survive failed restore");
    try {
      const result = await restoreStopped(newest);
      expect(result).toMatchObject({ ok: false, errorCode: BackupErrorCode.CHECKSUM_MISMATCH });
      expect(await fs.readFile(sentinel, "utf8")).toBe("must survive failed restore");
      for (const [file, contents] of Object.entries(tree).slice(1)) {
        expect(await fs.readFile(path.join(backup.cwd, file), "utf8")).toBe(contents);
      }
    } finally {
      await fs.writeFile(archive, original);
    }
  });

  it("validates Drive configuration and consumes OAuth state on consent denial", async () => {
    const body = {
      type: "gdrive",
      name: "Integration Drive",
      config: {
        authMethod: "oauth",
        clientId: "test.apps.googleusercontent.com",
        redirectBaseUrl: "https://panel.example.test"
      },
      secrets: { clientSecret: "drive-fixture-secret" }
    };
    const invalid = await backupApi("POST", "destinations", {
      body: { ...body, config: { ...body.config, redirectBaseUrl: "not-a-url" } }
    });
    expect(invalid.httpStatus).toBe(400);
    const dest = success<{ id: string; secrets: { clientSecret: string } }>(
      await backupApi("POST", "destinations", { body })
    );
    expect(dest.secrets.clientSecret === BACKUP_SECRET_MASK).toBe(true);
    const { url } = success<{ url: string }>(
      await backupApi("GET", "gdrive/connect", {
        query: { destinationId: dest.id }
      })
    );
    const consent = new URL(url);
    expect(consent.hostname).toBe("accounts.google.com");
    expect(consent.searchParams.get("redirect_uri")).toBe(
      "https://panel.example.test/api/backup/gdrive/callback"
    );
    const state = consent.searchParams.get("state")!;
    expect(/^[a-f0-9]{32}$/.test(state)).toBe(true);

    // Replay without a code stays local even if state consumption regresses.
    const callback = (query: Record<string, string>) => {
      const params = new URLSearchParams(query);
      return fetch(`${world.panelUrl}/api/backup/gdrive/callback?${params}`, {
        headers: { Cookie: adm().cookie },
        redirect: "manual"
      });
    };
    for (const [query, reason] of [
      [{ state, error: "access_denied" }, "OAUTH_DENIED"],
      [{ state }, "OAUTH_STATE_INVALID"]
    ] as const) {
      const response = await callback(query);
      await response.body?.cancel();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(`reason=${reason}`);
    }
  });
});
