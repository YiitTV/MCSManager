import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMaintenanceConfig, readMaintenance } from "../minecraft_maintenance";

describe("Velocity Maintenance files", () => {
  let root: string;
  let workspace: string;
  let plugin: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mcsm-maintenance-"));
    workspace = path.join(root, "workspace");
    plugin = path.join(workspace, "plugins", "maintenance");
    await mkdir(workspace);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("distinguishes a missing plugin from a disabled plugin", async () => {
    await expect(readMaintenance(workspace)).resolves.toEqual({ status: "missing" });
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "config.yml"), "maintenance-enabled: false # default\n");
    await writeFile(
      path.join(plugin, "WhitelistedPlayers.yml"),
      "a8179ff3-c201-4a75-bdaa-9d14aca6f83f: Notch\n" +
        '069a79f4-44e9-4726-a5be-fca90e38aaf5: "Alex_1"\n' +
        "not-a-uuid: ignored\n"
    );
    await expect(readMaintenance(workspace)).resolves.toEqual({
      status: "ready",
      enabled: false,
      players: ["Alex_1", "Notch"]
    });
  });

  it("reads a boolean only and rejects external state stores", () => {
    expect(parseMaintenanceConfig("enable-maintenance: true\n")).toBe(true);
    expect(parseMaintenanceConfig('maintenance-enabled: "false"\n')).toBeUndefined();
    expect(
      parseMaintenanceConfig("maintenance-enabled: false\nredis:\n  enabled: true\n")
    ).toBeUndefined();
    expect(
      parseMaintenanceConfig("maintenance-enabled: false\nmysql:\n  use-mysql: true\n")
    ).toBeUndefined();
    expect(() => parseMaintenanceConfig("override: &x true\nmaintenance-enabled: *x\n")).toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects plugin and config symlinks", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "config.yml"), "maintenance-enabled: true\n");
    await mkdir(path.dirname(plugin));
    await symlink(outside, plugin);
    await expect(readMaintenance(workspace)).resolves.toEqual({ status: "unavailable" });
    await rm(plugin);
    await mkdir(plugin);
    await symlink(path.join(outside, "config.yml"), path.join(plugin, "config.yml"));
    await expect(readMaintenance(workspace)).rejects.toThrow("Invalid Maintenance file");
  });

  it("rejects files larger than the read limit", async () => {
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "config.yml"), "#".repeat(65_537));
    await expect(readMaintenance(workspace)).rejects.toThrow("Invalid Maintenance file");
  });
});
