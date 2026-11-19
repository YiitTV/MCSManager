import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLocalDirectoryAllowed } from "../local_dir_policy";

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "bk-policy-"));
  await fs.ensureDir(path.join(base, "inst"));
  await fs.ensureDir(path.join(base, "data"));
});
afterEach(() => fs.remove(base));

const policy = () => ({
  instanceDirs: () => [path.join(base, "inst")],
  dataDir: path.join(base, "data")
});

describe("assertLocalDirectoryAllowed", () => {
  it("accepts existing and creatable directories", () => {
    assertLocalDirectoryAllowed(path.join(base, "backups"), policy());
    assertLocalDirectoryAllowed(path.join(base, "deep/new/dir"), policy());
    assertLocalDirectoryAllowed(path.join(base, "data/Backups"), policy());
    assertLocalDirectoryAllowed(path.join(base, "data/Backups/sub"), policy());
  });

  it("refuses relative paths, files and unwritable parents", async () => {
    expect(() => assertLocalDirectoryAllowed("relative/dir", policy())).toThrow(/not_absolute/);
    await fs.outputFile(path.join(base, "file.txt"), "x");
    expect(() => assertLocalDirectoryAllowed(path.join(base, "file.txt"), policy())).toThrow(
      /not_a_directory/
    );
    expect(() => assertLocalDirectoryAllowed(path.join(base, "file.txt/sub"), policy())).toThrow(
      /not_creatable/
    );
  });

  it("refuses the instance directory, its children and symlinks into it", async () => {
    expect(() => assertLocalDirectoryAllowed(path.join(base, "inst"), policy())).toThrow(
      /inside_instance_directory/
    );
    expect(() => assertLocalDirectoryAllowed(path.join(base, "inst/backups"), policy())).toThrow(
      /inside_instance_directory/
    );
    await fs.symlink(path.join(base, "inst"), path.join(base, "link"));
    expect(() => assertLocalDirectoryAllowed(path.join(base, "link/b"), policy())).toThrow(
      /inside_instance_directory/
    );
  });

  it("refuses the rest of the daemon data directory", () => {
    expect(() => assertLocalDirectoryAllowed(path.join(base, "data"), policy())).toThrow(
      /inside_daemon_data/
    );
    expect(() => assertLocalDirectoryAllowed(path.join(base, "data/Config"), policy())).toThrow(
      /inside_daemon_data/
    );
  });

  it("is reported as BACKUP_INVALID_REQUEST", () => {
    try {
      assertLocalDirectoryAllowed("nope", policy());
    } catch (e: any) {
      expect(e.toString()).toMatch(/^BACKUP_INVALID_REQUEST: local_directory_invalid/);
    }
  });
});
