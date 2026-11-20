import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pidusage from "pidusage";
import { commandStringToArray } from "../../entity/commands/base/command_parser";
import DockerStatsTask from "../../entity/commands/task/docker_stats";
import type { IInstanceProcess } from "../../entity/instance/interface";
import type Instance from "../../entity/instance/instance";
import { finiteMetric, parseMaxHeap } from "./metrics";

const SCRIPT_LIMIT = 64 * 1024;

function launcherName(argument = "") {
  return path.posix.basename(argument.replace(/\\/g, "/")).toLowerCase();
}

function isJava(argument: string) {
  return ["java", "java.exe", "{mcsm_java}"].includes(launcherName(argument));
}

function startKind(command: string) {
  try {
    const [executable, ...args] = commandStringToArray(command.trim());
    if (!executable) return;
    if (isJava(executable)) return "java";
    const launcher = launcherName(executable);
    if (
      launcher === "start.sh" ||
      (["sh", "bash", "dash"].includes(launcher) && launcherName(args[0]) === "start.sh")
    ) {
      return "script";
    }
  } catch {
    // The instance may have an older or malformed launch configuration.
  }
}

async function findJavaPid(rootPid: number) {
  const stdin = await readlink(`/proc/${rootPid}/fd/0`).catch(() => undefined);
  let pid = rootPid;
  // A normal launch script runs one foreground child. Cap the walk and avoid scanning the host.
  for (let depth = 0; depth < 5; depth++) {
    if (isJava(await readlink(`/proc/${pid}/exe`).catch(() => ""))) {
      if (
        pid === rootPid ||
        (stdin && stdin === (await readlink(`/proc/${pid}/fd/0`).catch(() => "")))
      ) {
        return pid;
      }
      return;
    }
    const file = await open(`/proc/${pid}/task/${pid}/children`, "r").catch(() => undefined);
    if (!file) return;
    try {
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const children = buffer.toString("ascii", 0, bytesRead);
      if (bytesRead === buffer.length || !/^\d{1,10}\s*$/.test(children)) return;
      pid = Number(children);
    } catch {
      return;
    } finally {
      await file.close();
    }
  }
}

async function readMaxHeapFromScript(cwd: string) {
  const scriptPath = path.join(cwd, "start.sh");
  // O_NONBLOCK protects against a file being replaced with a FIFO while opening.
  const original = await lstat(scriptPath).catch(() => undefined);
  if (!original?.isFile()) return;
  const file = await open(
    scriptPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  ).catch(() => undefined);
  if (!file) return;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.dev !== original.dev ||
      stat.ino !== original.ino ||
      stat.size > SCRIPT_LIMIT
    ) {
      return;
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return parseMaxHeap(buffer.toString("utf8", 0, bytesRead).replace(/(?:^|[ \t])#[^\n]*/gm, ""));
  } catch {
    // The script can change while the daemon is sampling. Use the configured limit in that case.
    return;
  } finally {
    await file.close();
  }
}

export async function hasSparkDirectory(cwd: string) {
  const plugins = path.join(cwd, "plugins");
  if (process.platform === "linux") {
    const directory = await open(
      plugins,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    ).catch(() => undefined);
    if (!directory) return false;
    try {
      // Resolve the child from the opened directory even if plugins is renamed.
      const spark = await lstat(`/proc/self/fd/${directory.fd}/spark`).catch(() => undefined);
      return Boolean(spark?.isDirectory());
    } finally {
      await directory.close();
    }
  }

  const parent = await lstat(plugins).catch(() => undefined);
  if (!parent?.isDirectory()) return false;
  const spark = await lstat(path.join(plugins, "spark")).catch(() => undefined);
  return Boolean(spark?.isDirectory());
}

export async function readResources(instance: Instance, running: IInstanceProcess) {
  const { startCommand, docker, type, processType, enableRcon } = instance.config;
  const kind = startKind(startCommand);
  const minecraft = type === "minecraft/java" || type.startsWith("minecraft/java/");
  const cwd = instance.absoluteCwdPath();
  const configuredMemory = finiteMetric((docker?.memory ?? 0) * 1024 ** 2);
  const memoryLimitBytes =
    parseMaxHeap(startCommand) ??
    (await readMaxHeapFromScript(cwd)) ??
    (configuredMemory || os.totalmem());

  let javaConsole = kind === "java" || (kind === "script" && minecraft);
  let ramBytes: number | null = null;
  let cpuPercent: number | null = null;
  if (processType === "docker") {
    const cached = DockerStatsTask.getMonitoringStats(instance, running);
    ramBytes = finiteMetric(cached?.ramBytes);
    cpuPercent = finiteMetric(cached?.cpuPercent);
  } else if (
    typeof running.pid === "number" &&
    Number.isSafeInteger(running.pid) &&
    running.pid > 0
  ) {
    const javaPid =
      kind && process.platform === "linux" ? await findJavaPid(running.pid) : undefined;
    javaConsole = process.platform === "linux" ? Boolean(javaPid) : kind === "java";
    const processStats = await pidusage(javaPid ?? running.pid).catch(() => undefined);
    ramBytes = finiteMetric(processStats?.memory);
    cpuPercent = finiteMetric(processStats?.cpu);
  } else {
    javaConsole = false;
  }
  return {
    ramBytes,
    cpuPercent,
    memoryLimitBytes,
    spark: !enableRcon && javaConsole && (await hasSparkDirectory(cwd))
  };
}
