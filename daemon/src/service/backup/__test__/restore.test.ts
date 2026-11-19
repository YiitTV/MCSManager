import crypto from "crypto";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupErrorCode } from "mcsmanager-common";
import { createArchive } from "../archiver";
import { restoreArchive, validateEntryName, validateSymlinkTarget } from "../restore";

let base: string;
let inst: string;
let work: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "bk-restore-"));
  inst = path.join(base, "inst");
  work = path.join(base, "work");
  await fs.ensureDir(inst);
  await fs.ensureDir(work);
});
afterEach(() => fs.remove(base));

const statfsOk = async () => ({ bavail: 1e12, bsize: 1 });

async function sha(file: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Hand-written stored zip so entry names are NOT sanitised (archiver would clean them). */
async function craft(
  entries: { name: string; data?: string; symlink?: string }[]
): Promise<{ file: string; sha: string }> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.symlink ?? e.data ?? "x");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(10, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.symlink !== undefined ? 0o120777 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const file = path.join(work, "evil.zip");
  await fs.writeFile(file, Buffer.concat([...locals, cd, end]));
  return { file, sha: await sha(file) };
}

function opts(archive: { file: string; sha: string }, extra = {}) {
  return {
    archivePath: archive.file,
    instanceDir: inst,
    restoreId: "r1",
    expectedSha256: archive.sha,
    maxUncompressedBytes: 1e9,
    statfs: statfsOk,
    ...extra
  };
}

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    for (const n of await fs.readdir(d)) {
      const p = path.join(d, n);
      const st = await fs.lstat(p);
      out.push(path.relative(dir, p) + (st.isFile() ? `:${await fs.readFile(p, "utf8")}` : ""));
      if (st.isDirectory()) await rec(p);
    }
  }
  await rec(dir);
  return out.sort();
}

describe("restoreArchive", () => {
  it("round-trips an archive made by createArchive and keeps unrelated files", async () => {
    await fs.outputFile(path.join(inst, "world/level.dat"), "v1");
    await fs.outputFile(path.join(inst, "world/region/r.mca"), "r1");
    await fs.outputFile(path.join(inst, "server.properties"), "keep");
    const out = path.join(work, "b.zip.tmp");
    const a = await createArchive({ rootDir: inst, include: ["world"], exclude: [], outPath: out });
    await fs.outputFile(path.join(inst, "world/level.dat"), "CHANGED");
    await fs.outputFile(path.join(inst, "world/extra.txt"), "new");
    const res = await restoreArchive(opts({ file: out, sha: a.sha256 }));
    expect(res.restored).toEqual(["world"]);
    expect(await fs.readFile(path.join(inst, "world/level.dat"), "utf8")).toBe("v1");
    expect(await fs.pathExists(path.join(inst, "world/extra.txt"))).toBe(false);
    expect(await fs.readFile(path.join(inst, "server.properties"), "utf8")).toBe("keep");
    expect((await fs.readdir(inst)).some((n) => n.startsWith(".mcsm_restore_rollback_"))).toBe(
      false
    );
  });

  it("refuses a checksum mismatch before touching anything", async () => {
    await fs.outputFile(path.join(inst, "world/a"), "orig");
    const evil = await craft([{ name: "world/a", data: "bad" }]);
    const before = await snapshot(inst);
    await expect(restoreArchive(opts({ ...evil, sha: "0".repeat(64) }))).rejects.toMatchObject({
      code: BackupErrorCode.CHECKSUM_MISMATCH
    });
    expect(await snapshot(inst)).toEqual(before);
  });

  for (const [label, name] of [
    ["parent traversal", "../../etc/cron.d/x"],
    ["nested traversal", "world/../../x"],
    ["absolute", "/etc/cron.d/x"],
    ["windows drive", "C:/x"],
    ["backslash traversal", "world\\..\\..\\x"]
  ] as const) {
    it(`refuses ${label} entries with nothing written`, async () => {
      await fs.outputFile(path.join(inst, "world/a"), "orig");
      const evil = await craft([
        { name: "world/ok.txt", data: "ok" },
        { name, data: "pwn" }
      ]);
      const before = await snapshot(inst);
      await expect(restoreArchive(opts(evil))).rejects.toMatchObject({
        code: BackupErrorCode.ILLEGAL_ARCHIVE
      });
      expect(await snapshot(inst)).toEqual(before);
      expect(await fs.pathExists(path.join(base, "etc"))).toBe(false);
      expect(await fs.pathExists(path.join(base, "x"))).toBe(false);
    });
  }

  it("refuses symlinks that point outside, nothing written", async () => {
    await fs.outputFile(path.join(inst, "world/a"), "orig");
    for (const target of ["/etc", "../../outside", "a/../../../x"]) {
      const evil = await craft([
        { name: "world/ok.txt", data: "ok" },
        { name: "world/link", symlink: target }
      ]);
      const before = await snapshot(inst);
      await expect(restoreArchive(opts(evil))).rejects.toMatchObject({
        code: BackupErrorCode.ILLEGAL_ARCHIVE
      });
      expect(await snapshot(inst)).toEqual(before);
    }
  });

  it("never creates harmless symlinks either (skipped with a warning)", async () => {
    const evil = await craft([
      { name: "world/ok.txt", data: "ok" },
      { name: "world/link", symlink: "ok.txt" }
    ]);
    const warnings: string[] = [];
    await restoreArchive(opts(evil, { onWarning: (w: string) => warnings.push(w) }));
    expect(await fs.pathExists(path.join(inst, "world/ok.txt"))).toBe(true);
    expect(await fs.pathExists(path.join(inst, "world/link"))).toBe(false);
    expect(warnings[0]).toMatch(/^restore_symlink_skipped/);
  });

  it("refuses when the archive is larger than allowed or disk is too small", async () => {
    const evil = await craft([{ name: "world/big", data: "x".repeat(1000) }]);
    await expect(restoreArchive(opts(evil, { maxUncompressedBytes: 10 }))).rejects.toMatchObject({
      code: BackupErrorCode.ILLEGAL_ARCHIVE
    });
    await expect(
      restoreArchive(opts(evil, { statfs: async () => ({ bavail: 5, bsize: 1 }) }))
    ).rejects.toMatchObject({ code: BackupErrorCode.DISK_SPACE });
  });

  it("rolls back previous files when extraction fails halfway", async () => {
    await fs.outputFile(path.join(inst, "world/level.dat"), "orig");
    await fs.outputFile(path.join(inst, "other/o.txt"), "o");
    const good = await craft([
      { name: "world/a.txt", data: "a" },
      { name: "world/b.txt", data: "b" },
      { name: "newdir/c.txt", data: "c" }
    ]);
    const before = await snapshot(inst);
    let calls = 0;
    await expect(
      restoreArchive(
        opts(good, {
          afterExtract: async () => {
            calls++;
            throw new Error("ownership failed");
          }
        })
      )
    ).rejects.toThrow("ownership failed");
    expect(calls).toBe(1);
    expect(await snapshot(inst)).toEqual(before);
  });

  it("cancel mid-restore restores the previous state", async () => {
    await fs.outputFile(path.join(inst, "world/level.dat"), "orig");
    const files = Array.from({ length: 200 }, (_, i) => ({ name: `world/f${i}.txt`, data: "x" }));
    const good = await craft(files);
    const before = await snapshot(inst);
    const ac = new AbortController();
    let n = 0;
    await expect(
      restoreArchive(
        opts(good, {
          signal: ac.signal,
          onProgress: () => {
            if (++n === 70) ac.abort();
          }
        })
      )
    ).rejects.toMatchObject({ code: BackupErrorCode.CANCELLED });
    expect(await snapshot(inst)).toEqual(before);
  });
});

describe("entry validators", () => {
  it("accepts normal names and rejects tricks", () => {
    expect(validateEntryName("world/./a//b")).toBe("world/a/b");
    expect(validateEntryName("dir/")).toBe("dir");
    for (const bad of ["", "..", "a/../..", "/a", "C:\\a", "a\0b", ".mcsm_restore_rollback_x/a"]) {
      expect(() => validateEntryName(bad)).toThrow();
    }
  });
  it("symlink depth logic", () => {
    expect(() => validateSymlinkTarget("a/b/link", "../c")).not.toThrow();
    expect(() => validateSymlinkTarget("a/link", "../../c")).toThrow();
    expect(() => validateSymlinkTarget("link", "..")).toThrow();
    expect(() => validateSymlinkTarget("link", "x/..")).not.toThrow();
  });
});
