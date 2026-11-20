export const VELOCITY_TYPE = "minecraft/java/velocity";
const NAMESPACED_SERVER_TYPES = new Set([
  "minecraft/java/bukkit",
  "minecraft/java/spigot",
  "minecraft/java/paper",
  "minecraft/java/purpur",
  "minecraft/java/folia",
  "minecraft/java/leaves",
  "minecraft/java/pufferfish",
  "minecraft/java/mohist"
]);

const VANILLA_COMMAND_SERVER_TYPES = new Set([
  "minecraft/java",
  "minecraft/java/forge",
  "minecraft/java/neoforge",
  "minecraft/java/fabric"
]);

export function isMinecraftGameServer(type: string) {
  return NAMESPACED_SERVER_TYPES.has(type) || VANILLA_COMMAND_SERVER_TYPES.has(type);
}

export function minecraftCommand(type: string, command: string) {
  return NAMESPACED_SERVER_TYPES.has(type) ? `minecraft:${command}` : command;
}

export function isMinecraftPlayerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 16 &&
    !/[^A-Za-z0-9_]/u.test(value)
  );
}

const PLAYER_COMMANDS = {
  kick: "kick",
  ban: "ban",
  pardon: "pardon",
  op: "op",
  deop: "deop",
  whitelistAdd: "whitelist add",
  whitelistRemove: "whitelist remove",
  tell: "tell"
} as const;

export type PlayerAction = keyof typeof PLAYER_COMMANDS;
export interface PlayerOperation {
  action: PlayerAction;
  player: string;
  text?: string;
}

export type MaintenanceOperation =
  | { action: "toggle"; enabled: boolean }
  | { action: "add" | "remove"; player: string };

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function parsePlayerOperation(input: unknown): PlayerOperation | undefined {
  const { action, player, text } = asRecord(input);
  if (
    typeof action !== "string" ||
    !Object.prototype.hasOwnProperty.call(PLAYER_COMMANDS, action) ||
    !isMinecraftPlayerName(player)
  ) {
    return;
  }
  const key = action as PlayerAction;
  const acceptsText = key === "kick" || key === "ban" || key === "tell";
  if (text === undefined) return key === "tell" ? undefined : { action: key, player };
  if (!acceptsText || typeof text !== "string" || text.length > 1024) return;

  const clean = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, 160)
    .trimEnd();
  // Exclude selectors and terminal/shell metacharacters from the console argument.
  if ((key === "tell" && !clean) || (clean && !/^[\p{L}\p{M}\p{N} .,?'’:_-]+$/u.test(clean))) {
    return;
  }
  return { action: key, player, text: clean || undefined };
}

export function playerConsoleCommand(type: string, operation: PlayerOperation) {
  const { action, player, text } = operation;
  return [minecraftCommand(type, PLAYER_COMMANDS[action]), player, text].filter(Boolean).join(" ");
}

export function parseMaintenanceOperation(input: unknown): MaintenanceOperation | undefined {
  const { action, enabled, player } = asRecord(input);
  if (action === "toggle" && typeof enabled === "boolean") return { action, enabled };
  if ((action === "add" || action === "remove") && isMinecraftPlayerName(player))
    return { action, player };
}

export function maintenanceConsoleCommand(operation: MaintenanceOperation) {
  if (operation.action === "toggle") return `maintenance ${operation.enabled ? "on" : "off"}`;
  return `maintenance ${operation.action} ${operation.player}`;
}
