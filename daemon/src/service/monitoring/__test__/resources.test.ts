import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IInstanceProcess } from "../../../entity/instance/interface";
import type Instance from "../../../entity/instance/instance";
import { hasSparkDirectory, readResources } from "../resources";

vi.mock("pidusage", () => ({ default: vi.fn(async () => ({ memory: 345, cpu: 120 })) }));
vi.mock("../../../entity/commands/task/docker_stats", () => ({
  default: { getMonitoringStats: () => ({ ramBytes: 400, cpuPercent: 65 }) }
}));

let cwd: string;
const running = { pid: process.pid } as IInstanceProcess;

function config(startCommand: string, memory: number, processType = "general", enableRcon = false) {
  return {
    config: { startCommand, docker: { memory }, type: "minecraft/java", processType, enableRcon },
    absoluteCwdPath: () => cwd
  } as Instance;
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-monitoring-"));
});
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("resource collection", () => {
  it("reads RSS and per-core CPU and resolves command, script, config, then host limits", async () => {
    const script = path.join(cwd, "start.sh");
    await fs.writeFile(script, "#!/bin/sh\nexec java -Xmx2G -jar server.jar # -Xmx4G\n");
    expect(await readResources(config("java -Xmx1G -jar server.jar", 512), running)).toMatchObject({
      ramBytes: 345,
      cpuPercent: 120,
      memoryLimitBytes: 1024 ** 3
    });
    expect((await readResources(config("bash start.sh", 512), running)).memoryLimitBytes).toBe(
      2 * 1024 ** 3
    );
    await fs.unlink(script);
    expect((await readResources(config("bash start.sh", 512), running)).memoryLimitBytes).toBe(
      512 * 1024 ** 2
    );
    expect((await readResources(config("bash start.sh", 0), running)).memoryLimitBytes).toBe(
      os.totalmem()
    );
  });

  it("reuses Docker stats and requires a supported console and a local spark directory", async () => {
    await fs.mkdir(path.join(cwd, "plugins", "spark"), { recursive: true });
    expect(
      await readResources(config("java -jar server.jar", 512, "docker"), running)
    ).toMatchObject({
      ramBytes: 400,
      cpuPercent: 65,
      spark: true
    });
    expect((await readResources(config("/bin/bash", 512, "docker"), running)).spark).toBe(false);
    expect(
      (await readResources(config("java -jar server.jar", 512, "docker", true), running)).spark
    ).toBe(false);
  });

  it("skips symlinked spark directories and startup scripts", async () => {
    await fs.mkdir(path.join(cwd, "installed"));
    await fs.mkdir(path.join(cwd, "plugins"));
    await fs.symlink(path.join(cwd, "installed"), path.join(cwd, "plugins", "spark"), "dir");
    expect(await hasSparkDirectory(cwd)).toBe(false);
    await fs.rm(path.join(cwd, "plugins"), { recursive: true });
    await fs.mkdir(path.join(cwd, "installed", "spark"));
    await fs.symlink(path.join(cwd, "installed"), path.join(cwd, "plugins"), "dir");
    expect(await hasSparkDirectory(cwd)).toBe(false);
    await fs.writeFile(path.join(cwd, "actual.sh"), "java -Xmx5G -jar server.jar");
    await fs.symlink(path.join(cwd, "actual.sh"), path.join(cwd, "start.sh"), "file");
    expect((await readResources(config("bash start.sh", 512), running)).memoryLimitBytes).toBe(
      512 * 1024 ** 2
    );
  });
});
