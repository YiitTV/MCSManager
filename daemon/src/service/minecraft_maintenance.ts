import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isMinecraftPlayerName } from "mcsmanager-common";
import YAML from "yaml";

const MAX_FILE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

type MaintenanceState =
  | { status: "missing" | "unavailable" }
  | { status: "ready"; enabled: boolean; players: string[] | null };

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readPluginFile(file: string) {
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    throw new Error("Invalid Maintenance file");
  }
  if ((await realpath(file)) !== file) {
    throw new Error("Maintenance files must stay within the instance workspace");
  }

  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      (await realpath(file)) !== file ||
      (process.platform === "linux" && (await realpath(`/proc/self/fd/${handle.fd}`)) !== file)
    ) {
      throw new Error("Maintenance file changed during open");
    }
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error("Maintenance file exceeds size limit");
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

function parsePluginYaml(text: string, schema: "core" | "failsafe" = "core") {
  try {
    return YAML.parse(text, { maxAliasCount: 0, schema });
  } catch {
    throw new Error("Invalid Maintenance YAML");
  }
}

export function parseMaintenanceConfig(text: string): boolean | undefined {
  const config = parsePluginYaml(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  if (
    config["use-mysql"] === true ||
    config.mysql?.["use-mysql"] === true ||
    config.mysql?.enabled === true ||
    config["use-redis"] === true ||
    config.redis?.enabled === true
  )
    return;
  const enabled = config["maintenance-enabled"] ?? config["enable-maintenance"];
  return typeof enabled === "boolean" ? enabled : undefined;
}

function parseAllowlist(text: string) {
  const players = parsePluginYaml(text, "failsafe");
  if (players == null) return [];
  if (typeof players !== "object" || Array.isArray(players)) return null;
  const names = Object.entries(players).flatMap(([key, value]) =>
    UUID.test(key) && isMinecraftPlayerName(value) ? [value] : []
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export async function readMaintenance(workspace: string): Promise<MaintenanceState> {
  const root = await realpath(workspace);
  const plugins = path.join(root, "plugins");
  const directory = path.join(plugins, "maintenance");
  try {
    if (!(await lstat(plugins)).isDirectory() || !(await lstat(directory)).isDirectory()) {
      return { status: "unavailable" };
    }
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    throw error;
  }

  const config = await readPluginFile(path.join(directory, "config.yml")).catch((error) => {
    if (!isMissing(error)) throw error;
    return "";
  });
  const enabled = parseMaintenanceConfig(config);
  if (enabled === undefined) return { status: "unavailable" };
  const whitelist = path.join(directory, "WhitelistedPlayers.yml");
  const players = await readPluginFile(whitelist).then(parseAllowlist, (error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  return { status: "ready", enabled, players };
}
