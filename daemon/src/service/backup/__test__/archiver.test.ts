import archiver from "archiver";
import fs from "fs-extra";
import os from "os";
import path from "path";
import StreamZip from "node-stream-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupErrorCode } from "mcsmanager-common";
import { createArchive, lowerPriority, scanInstanceFiles } from "../archiver";
import { BackupError } from "../errors";

let root: string;
let work: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bk-arch-"));
  root = path.join(base, "inst");
  work = path.join(base, "work");
  await fs.ensureDir(root);
  await fs.ensureDir(work);
});
afterEach(async () => {
  await fs.remove(path.dirname(root));
});

async function names(file: string): Promise<string[]> {
  const zip = new StreamZip.async({ file });
  const entries = Object.values(await zip.entries()).map((e) => e.name);
  await zip.close();
  return entries.sort();
}

async function build(extra: Partial<Parameters<typeof createArchive>[0]> = {}) {
  const outPath = path.join(work, "a.zip.tmp");
  const res = await createArchive({
    rootDir: root,
    include: ["world"],
    exclude: [],
    outPath,
    ...extra
  });
  return { res, outPath };
}

describe("createArchive", () => {
  it("archives included files, applies excludes and hashes the output", async () => {
    await fs.outputFile(path.join(root, "world/level.dat"), "data");
    await fs.outputFile(path.join(root, "world/region/r.0.mca"), "region");
    await fs.outputFile(path.join(root, "world/session.lock"), "x");
    await fs.outputFile(path.join(root, "world/logs/a.log"), "log");
    await fs.outputFile(path.join(root, "other/file.txt"), "no");
    const { res, outPath } = await build({ exclude: ["*.lock", "world/logs"] });
    const list = await names(outPath);
    expect(list).toContain("world/level.dat");
    expect(list).toContain("world/region/r.0.mca");
    expect(list).not.toContain("world/session.lock");
    expect(list.some((n) => n.startsWith("world/logs"))).toBe(false);
    expect(list.some((n) => n.startsWith("other"))).toBe(false);
    expect(res.fileCount).toBe(2);
    const { createHash } = await import("crypto");
    const h = createHash("sha256")
      .update(await fs.readFile(outPath))
      .digest("hex");
    expect(res.sha256).toBe(h);
    expect(res.sizeBytes).toBe((await fs.stat(outPath)).size);
  });

  it("never follows symlinks out of the instance", async () => {
    const outside = path.join(path.dirname(root), "secret");
    await fs.outputFile(path.join(outside, "pw.txt"), "secret");
    await fs.outputFile(path.join(root, "world/ok.txt"), "ok");
    await fs.symlink(outside, path.join(root, "world/link"));
    await fs.symlink(path.join(outside, "pw.txt"), path.join(root, "world/pw"));
    const { outPath } = await build();
    const list = await names(outPath);
    expect(list).toEqual(["world/", "world/ok.txt"]);
  });

  it("rejects an include path whose parent symlink escapes", async () => {
    const outside = path.join(path.dirname(root), "secret");
    await fs.outputFile(path.join(outside, "x/pw.txt"), "secret");
    await fs.symlink(outside, path.join(root, "evil"));
    await expect(build({ include: ["evil/x"] })).rejects.toMatchObject({
      code: BackupErrorCode.ILLEGAL_PATH
    });
    await expect(build({ include: ["../secret"] })).rejects.toBeInstanceOf(BackupError);
    await expect(build({ include: ["/etc"] })).rejects.toBeInstanceOf(BackupError);
    expect(await fs.pathExists(path.join(work, "a.zip.tmp"))).toBe(false);
  });

  it("skips missing include paths but fails when none exists", async () => {
    await fs.outputFile(path.join(root, "world/a.txt"), "a");
    const { res } = await build({ include: ["world", "world_nether"] });
    expect(res.missing).toEqual(["world_nether"]);
    await expect(build({ include: ["nope"] })).rejects.toMatchObject({
      code: BackupErrorCode.NOTHING_TO_BACKUP
    });
    expect(await fs.pathExists(path.join(work, "a.zip.tmp"))).toBe(false);
  });

  it("supports whole directory and skips rollback dirs and skipAbsolute", async () => {
    await fs.outputFile(path.join(root, "a.txt"), "a");
    await fs.outputFile(path.join(root, ".mcsm_restore_rollback_x/b.txt"), "b");
    await fs.outputFile(path.join(root, "backups/c.zip"), "c");
    const { outPath } = await build({
      include: ["."],
      skipAbsolute: [path.join(root, "backups")]
    });
    expect((await names(outPath)).filter((n) => !n.endsWith("/"))).toEqual(["a.txt"]);
  });

  it("aborts and removes the staging file", async () => {
    for (let i = 0; i < 300; i++) await fs.outputFile(path.join(root, `world/f${i}.txt`), "x");
    const ac = new AbortController();
    let n = 0;
    const p = build({
      signal: ac.signal,
      onProgress: () => {
        if (++n === 50) ac.abort();
      }
    });
    await expect(p).rejects.toMatchObject({ code: BackupErrorCode.CANCELLED });
    expect(await fs.pathExists(path.join(work, "a.zip.tmp"))).toBe(false);
  });

  it("removes the staging file when cancelled during finalization", async () => {
    await fs.outputFile(path.join(root, "world/level.dat"), "data");
    const controller = new AbortController();
    const create = archiver.create;
    const spy = vi.spyOn(archiver, "create").mockImplementationOnce((...args) => {
      const archive = create(...args);
      archive.finalize = () => {
        controller.abort();
        return new Promise<void>(() => {});
      };
      return archive;
    });
    try {
      await expect(build({ signal: controller.signal })).rejects.toMatchObject({
        code: BackupErrorCode.CANCELLED
      });
      expect(await fs.pathExists(path.join(work, "a.zip.tmp"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not buffer large files (sparse file)", async () => {
    const big = path.join(root, "world/big.bin");
    await fs.ensureDir(path.dirname(big));
    const fh = await fs.open(big, "w");
    await fs.ftruncate(fh, 400 * 1024 * 1024);
    await fs.close(fh);
    const scan = await scanInstanceFiles({ rootDir: root, include: ["world"], exclude: [] });
    expect(scan.totalBytes).toBe(400 * 1024 * 1024);
    global.gc?.();
    let peak = 0;
    const base = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss - base);
    }, 20);
    const { res } = await build();
    clearInterval(timer);
    expect(res.fileCount).toBe(1);
    expect(peak).toBeLessThan(200 * 1024 * 1024);
  }, 60000);
});

describe("scanInstanceFiles", () => {
  it("sums sizes and honours excludes", async () => {
    await fs.outputFile(path.join(root, "world/a"), "12345");
    await fs.outputFile(path.join(root, "world/b.tmp"), "123");
    const r = await scanInstanceFiles({
      rootDir: root,
      include: ["world", "gone"],
      exclude: ["*.tmp"]
    });
    expect(r).toEqual({ totalBytes: 5, fileCount: 1, missing: ["gone"] });
  });
});

describe("lowerPriority", () => {
  it("sets and restores priority via the api", () => {
    const calls: number[] = [];
    const api = {
      getPriority: () => 0,
      setPriority: (_pid: number, p: number) => void calls.push(p)
    } as any;
    const restore = lowerPriority(10, api);
    restore();
    expect(calls).toEqual([10, 0]);
  });
  it("never throws when the api fails", () => {
    const api = {
      getPriority: () => 0,
      setPriority: () => {
        throw new Error("EPERM");
      }
    } as any;
    expect(() => lowerPriority(10, api)()).not.toThrow();
  });
});
