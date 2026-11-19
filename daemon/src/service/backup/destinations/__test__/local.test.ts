import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupDriverErrorCode, LocalDestination } from "mcsmanager-common";
import { createLocalDriver, resolveLocalCopyPath } from "../local";

let base: string;
let dest: LocalDestination<string>;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "bk-local-"));
  dest = {
    id: "local",
    type: "local",
    name: "Local",
    createdAt: 0,
    updatedAt: 0,
    config: { directory: path.join(base, "dest"), maxTotalBytes: 1e9 },
    secrets: {}
  } as any;
});
afterEach(() => fs.remove(base));

const obj = { instanceUuid: "inst1", planId: "plan1", backupId: "bk1" };

describe("local driver", () => {
  it("puts, heads, gets and removes by recorded id", async () => {
    const src = path.join(base, "s.zip");
    await fs.writeFile(src, "hello");
    const d = createLocalDriver(dest);
    const res = await d.put({ filePath: src, sizeBytes: 5, sha256: "x", object: obj });
    expect(res).toEqual({ remoteId: "plan1_bk1.zip", sizeBytes: 5 });
    expect(await d.head(res.remoteId)).toEqual({ exists: true, sizeBytes: 5 });
    const out = path.join(base, "out.zip");
    await d.get({ remoteId: res.remoteId, destPath: out });
    expect(await fs.readFile(out, "utf8")).toBe("hello");
    await d.remove(res.remoteId);
    expect(await d.head(res.remoteId)).toEqual({ exists: false });
    await d.remove(res.remoteId); // idempotent
    expect((await fs.readdir(dest.config.directory)).filter((n) => n.endsWith(".part"))).toEqual(
      []
    );
  });

  it("refuses ids that are not plain file names", async () => {
    const d = createLocalDriver(dest);
    for (const bad of ["../x.zip", "/etc/passwd", "a/b.zip", "x.txt", "a\\b.zip", ""]) {
      await expect(d.remove(bad)).rejects.toMatchObject({ code: BackupDriverErrorCode.FAILED });
    }
    expect(() => resolveLocalCopyPath("/d", "..%2f.zip")).toThrow();
  });

  it("never deletes files that are not named by recorded ids", async () => {
    await fs.outputFile(path.join(dest.config.directory, "unknown.txt"), "keep");
    const d = createLocalDriver(dest);
    await d.remove("plan1_other.zip");
    expect(await fs.pathExists(path.join(dest.config.directory, "unknown.txt"))).toBe(true);
  });

  it("test() writes and removes a marker and reports free space", async () => {
    const r = await createLocalDriver(dest).test();
    expect(r.ok).toBe(true);
    expect(r.freeBytes).toBeGreaterThan(0);
    expect(await fs.readdir(dest.config.directory)).toEqual([]);
  });

  it("aborted put leaves no partial file", async () => {
    const src = path.join(base, "s.zip");
    await fs.writeFile(src, "hello");
    const ac = new AbortController();
    ac.abort();
    await expect(
      createLocalDriver(dest).put({
        filePath: src,
        sizeBytes: 5,
        sha256: "x",
        object: obj,
        signal: ac.signal
      })
    ).rejects.toMatchObject({ code: BackupDriverErrorCode.ABORTED });
    expect(await fs.pathExists(dest.config.directory)).toBe(false);
  });
});
