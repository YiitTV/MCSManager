import { createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCrashEvidence } from "../evidence";

describe.skipIf(process.platform !== "linux")("crash evidence confinement", () => {
  let workspace: string;
  let instance: string;
  let reports: string;
  let plugins: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "mcsm-crash-"));
    instance = path.join(workspace, "instance");
    reports = path.join(instance, "crash-reports");
    plugins = path.join(instance, "plugins");
    await Promise.all([mkdir(reports, { recursive: true }), mkdir(plugins, { recursive: true })]);
  });

  afterEach(async () => rm(workspace, { recursive: true, force: true }));

  it("reads the newest recent report and the main class from a small JAR descriptor", async () => {
    const older = path.join(reports, "older.txt");
    await writeFile(older, "older report");
    // Wait for a distinct filesystem creation timestamp.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(reports, "newer.txt"), "newer report");
    const jar = archiver("zip");
    const stream = createWriteStream(path.join(plugins, "RegionGuard.jar"));
    const closed = new Promise<void>((resolve, reject) => {
      stream.once("close", resolve);
      stream.once("error", reject);
      jar.once("error", reject);
    });
    jar.pipe(stream);
    jar.append("name: RegionGuard\nmain: com.minefield.regions.RegionPlugin\n", {
      name: "plugin.yml"
    });
    await jar.finalize();
    await closed;

    expect(await readCrashEvidence(instance, Date.now())).toEqual({
      report: "newer report",
      plugins: [{ jar: "RegionGuard.jar", main: "com.minefield.regions.RegionPlugin" }]
    });
    expect((await readCrashEvidence(instance, Date.now() + 121_000)).report).toBe("");
  });

  it("skips linked report files, plugin files and directories", async () => {
    const outside = path.join(workspace, "private.txt");
    await writeFile(outside, "private");
    await symlink(outside, path.join(reports, "symlink.txt"));
    await link(outside, path.join(reports, "hardlink.txt"));
    await symlink(outside, path.join(plugins, "External.jar"));
    expect(await readCrashEvidence(instance, Date.now())).toEqual({ report: "", plugins: [] });

    await rm(reports, { recursive: true });
    await symlink(workspace, reports);
    expect(await readCrashEvidence(instance, Date.now())).toEqual({ report: "", plugins: [] });
  });
});
