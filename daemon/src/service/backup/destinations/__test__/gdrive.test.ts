import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_PART_SIZES,
  BackupDriverErrorCode,
  DestinationDriver,
  GDriveDestination
} from "mcsmanager-common";
import { __setGoogleEndpointsForTests } from "../gdrive_auth";
import { createGDriveDriver, escapeDriveQueryLiteral } from "../gdrive";
import { FakeGoogle } from "./gdrive_fake_server";

const fake = new FakeGoogle();
let tmp: string;
const MIB = 1024 * 1024;
const object = { instanceUuid: "inst1234", planId: "plan1", backupId: "bk1" };

function destination(over: Partial<GDriveDestination["config"]> = {}): GDriveDestination<string> {
  return {
    id: "d1",
    name: "drive",
    type: "gdrive",
    createdAt: 0,
    updatedAt: 0,
    config: { authMethod: "oauth", clientId: "cid", ...over },
    secrets: { clientSecret: "CLIENT-SECRET-abc", refreshToken: "REFRESH-abc" }
  };
}
const driver = (over = {}): DestinationDriver => createGDriveDriver(destination(over));

function makeFile(size: number): { file: string; buf: Buffer; sha: string } {
  const buf = crypto.randomBytes(size);
  const file = path.join(tmp, `f${size}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, buf);
  return { file, buf, sha: crypto.createHash("sha256").update(buf).digest("hex") };
}
const putReq = (f: { file: string; buf: Buffer; sha: string }, extra = {}) => ({
  filePath: f.file,
  sizeBytes: f.buf.length,
  sha256: f.sha,
  object,
  ...extra
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-test-"));
  await fake.start();
});
afterAll(async () => {
  __setGoogleEndpointsForTests(null);
  await fake.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  __setGoogleEndpointsForTests(fake.endpoints(), () => 1);
  fake.files.clear();
  fake.sessions.clear();
  fake.requests = [];
  fake.tokenMode = "ok";
  fake.failChunkBefore.clear();
  fake.failChunkAfter.clear();
  fake.chunkPuts = 0;
  fake.chunkRanges = [];
  fake.statusQueries = 0;
  fake.locationOverride = undefined;
  fake.discardUploads = false;
  fake.deleted = [];
  fake.rejectNextWith = undefined;
});

describe("gdrive driver put/head/get/remove", () => {
  it("uploads in 8 MiB chunks via 308s, creates folders, returns the file id", async () => {
    const f = makeFile(20 * MIB + 123);
    const progress: number[] = [];
    const res = await driver().put(putReq(f, { onProgress: (d: number) => progress.push(d) }));
    expect(fake.chunkRanges).toEqual([
      `0-${8 * MIB - 1}`,
      `${8 * MIB}-${16 * MIB - 1}`,
      `${16 * MIB}-${20 * MIB + 122}`
    ]);
    expect(BACKUP_PART_SIZES.GDRIVE_CHUNK % (256 * 1024)).toBe(0);
    const stored = fake.files.get(res.remoteId)!;
    expect(stored.data.equals(f.buf)).toBe(true);
    expect(stored.name).toBe("plan1_bk1.zip");
    expect(stored.appProperties?.sha256).toBe(f.sha);
    expect(res.sizeBytes).toBe(f.buf.length);
    expect(progress[progress.length - 1]).toBe(f.buf.length);
    // folder chain MCSManager/<instanceUuid> under root
    const folders = [...fake.files.values()].filter((x) => x.mimeType);
    expect(folders.map((x) => x.name).sort()).toEqual(["MCSManager", "inst1234"]);
    expect(stored.parents).toEqual([folders.find((x) => x.name === "inst1234")!.id]);
    expect(folders.find((x) => x.name === "MCSManager")!.parents).toEqual(["root"]);
  });

  it("reuses existing folders and honours the configured parent folder", async () => {
    const f = makeFile(1000);
    await driver({ folderId: "PARENT_1" }).put(putReq(f));
    await driver({ folderId: "PARENT_1" }).put(putReq(f));
    const folders = [...fake.files.values()].filter((x) => x.mimeType);
    expect(folders).toHaveLength(2);
    expect(folders.find((x) => x.name === "MCSManager")!.parents).toEqual(["PARENT_1"]);
  });

  it("resumes at the right offset after a transient failure (chunk not stored)", async () => {
    const f = makeFile(20 * MIB);
    fake.failChunkBefore.add(2);
    const res = await driver().put(putReq(f));
    expect(fake.statusQueries).toBe(1);
    expect(fake.chunkRanges).toEqual([
      `0-${8 * MIB - 1}`,
      `${8 * MIB}-${16 * MIB - 1}`,
      `${8 * MIB}-${16 * MIB - 1}`,
      `${16 * MIB}-${20 * MIB - 1}`
    ]);
    expect(fake.files.get(res.remoteId)!.data.equals(f.buf)).toBe(true);
  });

  it("resumes after a failure where the server did store the chunk", async () => {
    const f = makeFile(20 * MIB);
    fake.failChunkAfter.add(2);
    const res = await driver().put(putReq(f));
    expect(fake.chunkRanges).toEqual([
      `0-${8 * MIB - 1}`,
      `${8 * MIB}-${16 * MIB - 1}`,
      `${16 * MIB}-${20 * MIB - 1}`
    ]);
    expect(fake.files.get(res.remoteId)!.data.equals(f.buf)).toBe(true);
  });

  it("gives up with TRANSIENT after repeated failures and cancels the session", async () => {
    const f = makeFile(MIB);
    for (let i = 1; i <= 10; i++) fake.failChunkBefore.add(i);
    const err = await driver()
      .put(putReq(f))
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.TRANSIENT);
    expect(
      fake.requests.some((r) => r.method === "DELETE" && r.url.includes("/upload/session/"))
    ).toBe(true);
    expect([...fake.files.values()].filter((x) => !x.mimeType)).toHaveLength(0);
  });

  it("uploads an empty file", async () => {
    const f = makeFile(0);
    const res = await driver().put(putReq(f));
    expect(fake.files.get(res.remoteId)!.size).toBe(0);
  });

  it("rejects an upload session URI on a foreign host and never sends data there", async () => {
    const f = makeFile(1000);
    fake.locationOverride = "https://evil.example.com/upload/session/x";
    const err = await driver()
      .put(putReq(f))
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.FAILED);
    expect(err.message).not.toContain("evil.example.com");
    expect(fake.chunkPuts).toBe(0);
    fake.locationOverride = "http://127.0.0.1:1/upload/session/x";
    expect(
      (
        await driver()
          .put(putReq(f))
          .catch((e) => e)
      ).code
    ).toBe(BackupDriverErrorCode.FAILED);
  });

  it("head reports size, missing and trashed objects", async () => {
    const f = makeFile(4321);
    const d = driver();
    const { remoteId } = await d.put(putReq(f));
    expect(await d.head(remoteId)).toEqual({ exists: true, sizeBytes: 4321 });
    expect((await d.head("doesNotExist1")).exists).toBe(false);
    fake.files.get(remoteId)!.trashed = true;
    expect((await d.head(remoteId)).exists).toBe(false);
  });

  it("get writes the exact bytes and removes the partial file on failure", async () => {
    const f = makeFile(3 * MIB + 7);
    const d = driver();
    const { remoteId } = await d.put(putReq(f));
    const dest = path.join(tmp, "restored.zip");
    const seen: number[] = [];
    await d.get({ remoteId, destPath: dest, onProgress: (n) => seen.push(n) });
    expect(fs.readFileSync(dest).equals(f.buf)).toBe(true);
    expect(seen[seen.length - 1]).toBe(f.buf.length);
    const bad = path.join(tmp, "missing.zip");
    const err = await d.get({ remoteId: "nope12345", destPath: bad }).catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.NOT_FOUND);
    expect(fs.existsSync(bad)).toBe(false);
  });

  it("remove is idempotent and only deletes the given id", async () => {
    const f = makeFile(100);
    const d = driver();
    const a = await d.put(putReq(f));
    const b = await d.put({ ...putReq(f), object: { ...object, backupId: "bk2" } });
    fake.deleted = [];
    await d.remove(a.remoteId);
    await d.remove(a.remoteId);
    expect(fake.deleted).toEqual([a.remoteId, a.remoteId]);
    expect(fake.files.has(b.remoteId)).toBe(true);
    expect(
      fake.requests.filter((r) => r.method === "DELETE" && r.url.includes("/drive/v3/files/"))
        .length
    ).toBe(2);
  });

  it("rejects ids that could alter the request path", async () => {
    const d = driver();
    for (const id of ["../x", "a/b", "a?b=1", ""]) {
      expect((await d.remove(id).catch((e) => e)).code).toBe(BackupDriverErrorCode.FAILED);
      await expect(d.head(id)).rejects.toBeTruthy();
    }
    expect(fake.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("refreshes the token once after a 401 and continues", async () => {
    const f = makeFile(100);
    const d = driver();
    const { remoteId } = await d.put(putReq(f));
    fake.validToken = "something-else"; // server revoked the token
    fake.tokenCalls = 0;
    expect((await d.head(remoteId)).exists).toBe(true);
    expect(fake.tokenCalls).toBe(1);
  });
});

describe("gdrive driver errors and queries", () => {
  it("escapes quotes and backslashes in query literals", () => {
    expect(escapeDriveQueryLiteral(`a'b\\c`)).toBe(`a\\'b\\\\c`);
  });

  it("never puts unescaped input into q", async () => {
    // folderId is validated, so a hostile one cannot reach the query at all
    const err = await driver({ folderId: "x' or name contains '" })
      .put(putReq(makeFile(10)))
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.FAILED);
    expect(fake.requests.filter((r) => r.url.startsWith("/drive/v3/files?"))).toHaveLength(0);
    // instance ids that are not safe ids are refused
    const bad = await driver()
      .put(putReq(makeFile(10), { object: { ...object, instanceUuid: "a'b" } }))
      .catch((e) => e);
    expect(bad.code).toBe(BackupDriverErrorCode.FAILED);
  });

  it.each([
    [403, "storageQuotaExceeded", BackupDriverErrorCode.QUOTA],
    [403, "quotaExceeded", BackupDriverErrorCode.QUOTA],
    [403, "rateLimitExceeded", BackupDriverErrorCode.TRANSIENT],
    [403, "userRateLimitExceeded", BackupDriverErrorCode.TRANSIENT],
    [403, "forbidden", BackupDriverErrorCode.AUTH],
    [404, "notFound", BackupDriverErrorCode.NOT_FOUND],
    [429, "rateLimitExceeded", BackupDriverErrorCode.TRANSIENT],
    [500, "backendError", BackupDriverErrorCode.TRANSIENT],
    [503, "backendError", BackupDriverErrorCode.TRANSIENT]
  ])("maps HTTP %i %s", async (status, reason, code) => {
    const d = driver();
    const { remoteId } = await d.put(putReq(makeFile(10)));
    fake.rejectNextWith = { status, reason, method: "GET" };
    const err = await d.head(remoteId).then(
      (r) => r,
      (e) => e
    );
    if (status === 404) {
      expect(err).toEqual({ exists: false });
    } else {
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(code === BackupDriverErrorCode.TRANSIENT);
    }
  });

  it("maps a quota error during upload to QUOTA", async () => {
    fake.rejectNextWith = { status: 403, reason: "storageQuotaExceeded", method: "POST" };
    // first POST is the folder lookup? lookups are GET, so the first POST is folder create
    const err = await driver()
      .put(putReq(makeFile(10)))
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.QUOTA);
  });

  it("maps invalid_grant to AUTH on any call and leaks no secrets or URLs", async () => {
    fake.tokenMode = "invalid_grant";
    const err = await driver()
      .put(putReq(makeFile(10)))
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.AUTH);
    const test = await driver().test();
    expect(test.ok).toBe(false);
    for (const text of [err.message, test.error!]) {
      expect(text).not.toContain("REFRESH-abc");
      expect(text).not.toContain("CLIENT-SECRET-abc");
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  it("network errors are TRANSIENT without URLs", async () => {
    __setGoogleEndpointsForTests({
      tokenUrl: "http://127.0.0.1:1/token",
      apiBase: "http://127.0.0.1:1/drive/v3",
      uploadBase: "http://127.0.0.1:1/upload/drive/v3"
    });
    const err = await driver()
      .head("abc123")
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.TRANSIENT);
    expect(err.message).not.toContain("127.0.0.1");
  });

  it("abort signal yields ABORTED", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await driver()
      .head("abc123", { signal: ac.signal })
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.ABORTED);
  });
});

describe("gdrive driver test()", () => {
  it("creates, reads and deletes a marker file", async () => {
    const r = await driver().test();
    expect(r).toEqual({ ok: true });
    expect([...fake.files.values()].filter((f) => !f.mimeType)).toHaveLength(0);
    expect(fake.deleted).toHaveLength(1);
  });

  it("reports sanitized failures without throwing", async () => {
    fake.rejectNextWith = { status: 403, reason: "forbidden", method: "GET" };
    const r = await driver().test();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/i);
  });
});

describe("gdrive driver memory", () => {
  it("keeps memory far below the file size during a 64 MiB upload", async () => {
    const file = path.join(tmp, "big.zip");
    const fd = fs.openSync(file, "w");
    const block = crypto.randomBytes(MIB);
    for (let i = 0; i < 64; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    fake.discardUploads = true;
    if (global.gc) global.gc();
    const base = process.memoryUsage();
    let peak = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.arrayBuffers + m.heapUsed - base.arrayBuffers - base.heapUsed);
    }, 5);
    try {
      await driver().put({
        filePath: file,
        sizeBytes: 64 * MIB,
        sha256: "0".repeat(64),
        object
      });
    } finally {
      clearInterval(timer);
    }
    // one 8 MiB reuse buffer + the in-process fake server's chunk copies; never the whole 64 MiB
    expect(peak).toBeLessThan(48 * MIB);
  }, 60000);
});
