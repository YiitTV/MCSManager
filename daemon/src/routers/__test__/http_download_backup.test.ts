import fs from "fs-extra";
import http from "http";
import Koa from "koa";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({ root: "", instDir: "" }));

vi.mock("../../service/log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});
vi.mock("../../entity/config", () => ({
  globalConfiguration: {
    config: {
      downloadSpeedRate: 0,
      uploadSpeedRate: 0,
      maxZipFileSize: 1,
      key: "k",
      language: "en_us"
    }
  },
  globalEnv: {}
}));
vi.mock("../../service/system_instance", () => ({
  default: {
    getInstance: (uuid: string) =>
      uuid === "inst1" ? { absoluteCwdPath: () => sandbox.instDir, config: {} } : undefined
  }
}));
vi.mock("../../service/upload_manager", () => ({ default: {} }));

import {
  backupDownloadTickets,
  BackupDownloadTickets
} from "../../service/backup/download_tickets";
import { missionPassport } from "../../service/mission_passport";
import httpRouter from "../http_router";

let server: http.Server;
let base = "";

function mission(key: string, fileName: string, instanceUuid = "inst1") {
  const now = Date.now();
  missionPassport.registerMission(key, {
    name: "download",
    parameter: { fileName, instanceUuid },
    start: now,
    end: now + 3600_000
  });
}
const get = (key: string, name: string) => fetch(`${base}/download/${key}/${name}`);

beforeAll(async () => {
  sandbox.root = await fs.mkdtemp(path.join(os.tmpdir(), "bk-http-"));
  sandbox.instDir = path.join(sandbox.root, "inst");
  await fs.outputFile(path.join(sandbox.instDir, "normal.txt"), "normal-content");
  await fs.outputFile(path.join(sandbox.root, "backups/p_b.zip"), "ARCHIVE-BYTES");
  await fs.outputFile(path.join(sandbox.root, "secret.txt"), "secret");
  const app = new Koa();
  app.use(httpRouter.routes());
  server = http.createServer(app.callback());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.close();
  await fs.remove(sandbox.root);
});

describe("download route with backup tickets", () => {
  it("serves the archive for a valid ticket exactly once", async () => {
    const { ticket } = backupDownloadTickets.issue(
      "inst1",
      path.join(sandbox.root, "backups/p_b.zip"),
      "p_b.zip"
    );
    mission("pass1", ticket);
    const ok = await get("pass1", "p_b.zip");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ARCHIVE-BYTES");
    // ticket and passport are burned
    mission("pass2", ticket);
    const again = await get("pass2", "p_b.zip");
    expect(again.status).not.toBe(200);
    expect(await again.text()).not.toContain("ARCHIVE-BYTES");
    const replay = await get("pass1", "p_b.zip");
    expect(replay.status).not.toBe(200);
  });

  it("refuses forged tickets and never resolves them as paths", async () => {
    mission("pass3", "../../secret.txt");
    const r = await get("pass3", "x");
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain("secret");
    mission("pass4", "0".repeat(48));
    const f = await get("pass4", "x");
    expect(f.status).not.toBe(200);
  });

  it("refuses an expired ticket", async () => {
    let now = 1000;
    const local = new BackupDownloadTickets(() => now, 60_000);
    const { ticket } = local.issue("inst1", path.join(sandbox.root, "backups/p_b.zip"), "p_b.zip");
    now += 60_001;
    expect(local.lookup(ticket, "inst1").state).toBe("expired");
    // via the shared store: issue with a past expiry by using a short-lived store instance
    const shared = backupDownloadTickets as any;
    const { ticket: t2 } = shared.issue(
      "inst1",
      path.join(sandbox.root, "backups/p_b.zip"),
      "p_b.zip"
    );
    shared.tickets.get(t2).expiresAt = Date.now() - 1;
    mission("pass5", t2);
    const r = await get("pass5", "p_b.zip");
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain("ARCHIVE-BYTES");
  });

  it("refuses a ticket used with a passport of another instance", async () => {
    const { ticket } = backupDownloadTickets.issue(
      "inst1",
      path.join(sandbox.root, "backups/p_b.zip"),
      "p_b.zip"
    );
    mission("pass6", ticket, "ghost");
    expect((await get("pass6", "p_b.zip")).status).not.toBe(200);
    // still valid for its own instance
    mission("pass7", ticket);
    expect((await get("pass7", "p_b.zip")).status).toBe(200);
  });

  it("leaves normal instance file downloads unchanged", async () => {
    mission("pass8", "normal.txt");
    const r = await get("pass8", "normal.txt");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("normal-content");
    mission("pass9", "../secret.txt");
    const bad = await get("pass9", "secret.txt");
    expect(bad.status).not.toBe(200);
    expect(await bad.text()).not.toContain("secret");
  });
});
