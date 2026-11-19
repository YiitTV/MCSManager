import { createHash, createHmac, randomBytes } from "crypto";
import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BackupDriverError,
  BackupDriverErrorCode,
  BackupObjectContext,
  S3Destination
} from "mcsmanager-common";
import { createS3Driver, createS3DriverWithOptions } from "../s3";

const AK = "AKIATESTACCESSKEY1234";
const SK = "TestSecretKey/abcdefghijklmnopqrstuvwxyz0123456789";
const BUCKET = "bkt";
const REGION = "eu-test-1";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  sigOk: boolean;
  bodyLen: number;
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

/** Independent SigV4 verification written separately from s3_sigv4.ts. */
function verifySig(req: http.IncomingMessage, payloadHash: string): boolean {
  const auth = String(req.headers.authorization ?? "");
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth
    );
  if (!m) return false;
  const [, ak, day, region, signedHeaders, sig] = m;
  if (ak !== AK || region !== REGION) return false;
  const u = new URL(req.url!, "http://x");
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] + "=" + a[1] < b[0] + "=" + b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const heads = signedHeaders
    .split(";")
    .map((h) => `${h}:${String(req.headers[h] ?? "").trim()}\n`)
    .join("");
  if (req.headers["x-amz-content-sha256"] !== payloadHash) return false;
  const canon = [req.method, u.pathname, query, heads, signedHeaders, payloadHash].join("\n");
  const amz = String(req.headers["x-amz-date"]);
  const sts = [
    "AWS4-HMAC-SHA256",
    amz,
    `${day}/${region}/s3/aws4_request`,
    createHash("sha256").update(canon).digest("hex")
  ].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + SK, day), region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(sts).digest("hex") === sig;
}

class MockS3 {
  server!: http.Server;
  port = 0;
  objects = new Map<string, Buffer>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  calls: Call[] = [];
  failParts = 0; // number of UploadPart requests to answer with 503
  killGetOnce = false;
  denyAll = false;
  sizesSeen: number[] = [];
  nextId = 1;

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let len = 0;
      req.on("data", (c: Buffer) => {
        hash.update(c);
        len += c.length;
        if (this.keepBodies) chunks.push(c);
      });
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks), hash.digest("hex"), len));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  keepBodies = true;
  stop() {
    this.server.closeAllConnections?.();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  xmlErr(res: http.ServerResponse, status: number, code: string) {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`);
  }
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    hash: string,
    len: number
  ) {
    const u = new URL(req.url!, "http://x");
    const sigOk = verifySig(req, hash);
    this.calls.push({
      method: req.method!,
      path: u.pathname,
      query: u.searchParams,
      sigOk,
      bodyLen: len
    });
    if (this.denyAll || !String(req.headers.authorization).includes(AK)) {
      return this.xmlErr(res, 403, "InvalidAccessKeyId");
    }
    if (!sigOk) return this.xmlErr(res, 403, "SignatureDoesNotMatch");
    const prefix = `/${BUCKET}/`;
    if (!u.pathname.startsWith(prefix)) return this.xmlErr(res, 404, "NoSuchBucket");
    const key = decodeURIComponent(u.pathname.slice(prefix.length));
    const q = u.searchParams;
    if (req.method === "POST" && q.has("uploads")) {
      const id = `up-${this.nextId++}`;
      this.uploads.set(id, { key, parts: new Map() });
      res.end(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
      );
    } else if (req.method === "PUT" && q.has("partNumber")) {
      if (this.failParts > 0) {
        this.failParts--;
        return this.xmlErr(res, 503, "SlowDown");
      }
      const up = this.uploads.get(q.get("uploadId")!);
      if (!up) return this.xmlErr(res, 404, "NoSuchUpload");
      up.parts.set(Number(q.get("partNumber")), body);
      this.sizesSeen.push(len);
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      res.end();
    } else if (req.method === "POST" && q.has("uploadId")) {
      const up = this.uploads.get(q.get("uploadId")!);
      if (!up) return this.xmlErr(res, 404, "NoSuchUpload");
      const nums = [...up.parts.keys()].sort((a, b) => a - b);
      this.objects.set(up.key, Buffer.concat(nums.map((n) => up.parts.get(n)!)));
      this.uploads.delete(q.get("uploadId")!);
      res.end("<CompleteMultipartUploadResult><ETag>x</ETag></CompleteMultipartUploadResult>");
    } else if (req.method === "DELETE" && q.has("uploadId")) {
      this.uploads.delete(q.get("uploadId")!);
      res.writeHead(204).end();
    } else if (req.method === "PUT") {
      this.objects.set(key, body);
      res.writeHead(200, { etag: '"e"' }).end();
    } else if (req.method === "HEAD") {
      const o = this.objects.get(key);
      if (!o) return res.writeHead(404).end();
      res.writeHead(200, { "content-length": o.length }).end();
    } else if (req.method === "GET") {
      const o = this.objects.get(key);
      if (!o) return this.xmlErr(res, 404, "NoSuchKey");
      const r = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
      const start = r ? Number(r[1]) : 0;
      const slice = o.subarray(start);
      res.writeHead(r ? 206 : 200, {
        "content-length": slice.length,
        ...(r ? { "content-range": `bytes ${start}-${o.length - 1}/${o.length}` } : {})
      });
      if (this.killGetOnce && !r) {
        this.killGetOnce = false;
        res.write(slice.subarray(0, Math.floor(slice.length / 2)));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end(slice);
    } else if (req.method === "DELETE") {
      this.objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(400).end();
    }
  }
}

const object: BackupObjectContext = { instanceUuid: "inst1", planId: "plan1", backupId: "bk1" };
let mock: MockS3;
let dir: string;

function dest(over: Partial<S3Destination["config"]> = {}, secret = SK): S3Destination<string> {
  return {
    id: "d1",
    name: "n",
    type: "s3",
    createdAt: 0,
    updatedAt: 0,
    config: {
      endpoint: `http://127.0.0.1:${mock.port}`,
      region: REGION,
      bucket: BUCKET,
      prefix: "pre",
      pathStyle: true,
      allowPrivateNetwork: true,
      accessKeyId: AK,
      ...over
    },
    secrets: { secretAccessKey: secret }
  };
}
const fast = { retryDelaysMs: [1, 1], partSize: 1024 };

function makeFile(name: string, size: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, randomBytes(size));
  return p;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  mock = new MockS3();
  await mock.start();
});
afterAll(() => mock.stop());
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3test-"));
  mock.objects.clear();
  mock.uploads.clear();
  mock.calls = [];
  mock.sizesSeen = [];
  mock.failParts = 0;
  mock.denyAll = false;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("S3 driver", () => {
  it("multipart happy path with signed requests and exact key", async () => {
    const file = makeFile("a.zip", 2500); // 3 parts of 1024
    const data = fs.readFileSync(file);
    const driver = createS3DriverWithOptions(dest(), fast);
    const progress: number[] = [];
    const r = await driver.put({
      filePath: file,
      sizeBytes: data.length,
      sha256: sha(data),
      object,
      onProgress: (d) => progress.push(d)
    });
    expect(r.remoteId).toBe("pre/inst1/plan1/bk1.zip");
    expect(mock.objects.get(r.remoteId)!.equals(data)).toBe(true);
    expect(mock.sizesSeen).toEqual([1024, 1024, 452]);
    expect(progress).toEqual([1024, 2048, 2500]);
    expect(mock.calls.map((c) => c.method)).toEqual(["POST", "PUT", "PUT", "PUT", "POST"]);
    expect(mock.calls.every((c) => c.sigOk)).toBe(true);
    expect((await driver.head(r.remoteId)).sizeBytes).toBe(2500);
  });

  it("single PUT for small files and virtual-hosted-free path style signing", async () => {
    const file = makeFile("s.zip", 100);
    const driver = createS3DriverWithOptions(dest(), fast);
    const r = await driver.put({ filePath: file, sizeBytes: 100, sha256: "x", object });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sigOk).toBe(true);
    expect(mock.objects.get(r.remoteId)!.length).toBe(100);
  });

  it("retries a failed part (503) and still completes", async () => {
    const file = makeFile("r.zip", 2100);
    mock.failParts = 2;
    const driver = createS3DriverWithOptions(dest(), fast);
    const r = await driver.put({ filePath: file, sizeBytes: 2100, sha256: "x", object });
    expect(mock.objects.get(r.remoteId)!.equals(fs.readFileSync(file))).toBe(true);
    expect(mock.calls.filter((c) => c.query.has("partNumber")).length).toBe(5);
  });

  it("aborts the multipart upload when a part keeps failing", async () => {
    const file = makeFile("f.zip", 3000);
    mock.failParts = 100;
    const driver = createS3DriverWithOptions(dest(), fast);
    const err = await driver
      .put({ filePath: file, sizeBytes: 3000, sha256: "x", object })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BackupDriverError);
    expect(err.code).toBe(BackupDriverErrorCode.TRANSIENT);
    expect(mock.calls.some((c) => c.method === "DELETE" && c.query.has("uploadId"))).toBe(true);
    expect(mock.uploads.size).toBe(0);
    expect(mock.objects.size).toBe(0);
  });

  it("abort signal triggers AbortMultipartUpload", async () => {
    const file = makeFile("g.zip", 4000);
    const ac = new AbortController();
    const driver = createS3DriverWithOptions(dest(), fast);
    const p = driver.put({
      filePath: file,
      sizeBytes: 4000,
      sha256: "x",
      object,
      signal: ac.signal,
      onProgress: () => ac.abort()
    });
    const err = await p.catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.ABORTED);
    expect(mock.calls.some((c) => c.method === "DELETE" && c.query.has("uploadId"))).toBe(true);
    expect(mock.uploads.size).toBe(0);
  });

  it("maps auth failures and never leaks secrets or signatures", async () => {
    const driver = createS3DriverWithOptions(dest({ accessKeyId: "AKIAWRONG" }), fast);
    const file = makeFile("h.zip", 10);
    const err = await driver
      .put({ filePath: file, sizeBytes: 10, sha256: "x", object })
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.AUTH);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(SK);
    expect(err.message).not.toMatch(/AWS4|Signature=|http:\/\//);
    const bad = createS3DriverWithOptions(dest({}, "wrong-secret-value"), fast);
    const t = await bad.test();
    expect(t.ok).toBe(false);
    expect(t.error).not.toContain("wrong-secret-value");
    expect(t.error).toContain("SignatureDoesNotMatch");
  });

  it("maps NoSuchBucket to NOT_FOUND", async () => {
    const driver = createS3DriverWithOptions(dest({ bucket: "other" }), fast);
    const t = await driver.test();
    expect(t.ok).toBe(false);
    const file = makeFile("n.zip", 10);
    const err = await driver
      .put({ filePath: file, sizeBytes: 10, sha256: "x", object })
      .catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.NOT_FOUND);
  });

  it("remove is idempotent; head reports missing", async () => {
    const driver = createS3DriverWithOptions(dest(), fast);
    const id = "pre/inst1/plan1/none.zip";
    await driver.remove(id);
    await driver.remove(id);
    expect(await driver.head(id)).toEqual({ exists: false });
  });

  it("refuses forged remote ids", async () => {
    const driver = createS3DriverWithOptions(dest(), fast);
    for (const id of [
      "../x",
      "other/a/b/c.zip",
      "pre/../../x.zip",
      "pre/a/b/c.txt",
      "pre/a/b.zip"
    ]) {
      await expect(driver.remove(id)).rejects.toMatchObject({
        code: BackupDriverErrorCode.NOT_FOUND
      });
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("get streams exact bytes and resumes after a mid-stream disconnect", async () => {
    const data = randomBytes(300_000);
    mock.objects.set("pre/inst1/plan1/bk1.zip", data);
    const driver = createS3DriverWithOptions(dest(), fast);
    const out = path.join(dir, "out.zip");
    await driver.get({ remoteId: "pre/inst1/plan1/bk1.zip", destPath: out });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
    mock.killGetOnce = true;
    const out2 = path.join(dir, "out2.zip");
    await driver.get({ remoteId: "pre/inst1/plan1/bk1.zip", destPath: out2 });
    expect(fs.readFileSync(out2).equals(data)).toBe(true);
    expect(mock.calls.every((c) => c.sigOk)).toBe(true);
  });

  it("get of a missing object fails NOT_FOUND and leaves no file", async () => {
    const driver = createS3DriverWithOptions(dest(), fast);
    const out = path.join(dir, "no.zip");
    await expect(
      driver.get({ remoteId: "pre/inst1/plan1/zz.zip", destPath: out })
    ).rejects.toMatchObject({
      code: BackupDriverErrorCode.NOT_FOUND
    });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("test() writes, heads and deletes a marker", async () => {
    const driver = createS3DriverWithOptions(dest(), fast);
    expect(await driver.test()).toEqual({ ok: true });
    expect(mock.calls.map((c) => c.method)).toEqual(["PUT", "HEAD", "DELETE"]);
    expect(mock.objects.size).toBe(0);
  });

  it("key is built only from validated ids", async () => {
    const driver = createS3DriverWithOptions(dest(), fast);
    const file = makeFile("k.zip", 10);
    await expect(
      driver.put({
        filePath: file,
        sizeBytes: 10,
        sha256: "x",
        object: { ...object, planId: "../../etc" }
      })
    ).rejects.toBeInstanceOf(BackupDriverError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("S3 SSRF rules", () => {
  it("refuses private/loopback/http endpoints by default", async () => {
    for (const endpoint of [
      `http://127.0.0.1:${mock.port}`,
      `https://127.0.0.1:${mock.port}`,
      `https://localhost:${mock.port}`,
      `http://example.com`
    ]) {
      const driver = createS3DriverWithOptions(
        dest({ endpoint, allowPrivateNetwork: false }),
        fast
      );
      const t = await driver.test();
      expect(t.ok).toBe(false);
      const file = makeFile("p.zip", 10);
      await expect(
        driver.put({ filePath: file, sizeBytes: 10, sha256: "x", object })
      ).rejects.toMatchObject({ code: BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED });
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses metadata addresses and credentials even with allowPrivateNetwork", async () => {
    const file = makeFile("m.zip", 10);
    for (const endpoint of [
      "http://169.254.169.254",
      "http://[fd00:ec2::254]",
      "http://0.0.0.0",
      `http://user:pw@127.0.0.1:${mock.port}`
    ]) {
      const driver = createS3DriverWithOptions(dest({ endpoint }), fast);
      await expect(
        driver.put({ filePath: file, sizeBytes: 10, sha256: "x", object })
      ).rejects.toMatchObject({ code: BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED });
    }
  });

  it("pins the validated address (no second DNS resolution) and rejects rebinding to metadata", async () => {
    let n = 0;
    const driver = createS3DriverWithOptions(
      dest({ endpoint: `http://s3.pinned.invalid:${mock.port}` }),
      {
        ...fast,
        dnsLookup: async () => {
          n++;
          return [{ address: "127.0.0.1", family: 4 }];
        }
      }
    );
    const file = makeFile("pin.zip", 10);
    await driver.put({ filePath: file, sizeBytes: 10, sha256: "x", object });
    // s3.pinned.invalid never resolves in real DNS; success proves the pinned address was used.
    expect(n).toBe(1);
    const rebind = createS3DriverWithOptions(
      dest({ endpoint: `http://s3.pinned.invalid:${mock.port}` }),
      {
        ...fast,
        dnsLookup: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "169.254.169.254", family: 4 }
        ]
      }
    );
    await expect(
      rebind.put({ filePath: file, sizeBytes: 10, sha256: "x", object })
    ).rejects.toMatchObject({ code: BackupDriverErrorCode.ENDPOINT_NOT_ALLOWED });
  });
});

describe("S3 driver memory", () => {
  it("uploads 64 MiB with production part size without buffering the file", async () => {
    const m2 = new MockS3();
    m2.keepBodies = false;
    await m2.start();
    const size = 64 * 1024 * 1024;
    const file = path.join(dir, "big.zip");
    const fd = fs.openSync(file, "w");
    const block = randomBytes(1024 * 1024);
    for (let i = 0; i < 64; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    const d = dest({ endpoint: `http://127.0.0.1:${m2.port}` });
    const driver = createS3Driver(d);
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    try {
      await driver.put({ filePath: file, sizeBytes: size, sha256: "x", object });
    } finally {
      clearInterval(timer);
      await m2.stop();
    }
    expect(m2.sizesSeen).toHaveLength(8);
    expect(m2.sizesSeen.every((s) => s === 8 * 1024 * 1024)).toBe(true);
    expect(peak - base).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);
});
