import { createHash, randomUUID } from "node:crypto";
import Storage from "../common/storage/sys_storage";

const CATEGORY = "ConsoleShortcut";
const MAX_SHORTCUTS = 20;
const NON_PRINTING = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export interface ConsoleShortcutInput {
  name: string;
  command: string;
}

interface ConsoleShortcut extends ConsoleShortcutInput {
  id: string;
}

class ShortcutList {
  shortcuts: ConsoleShortcut[] = [];
}

export function parseShortcuts(value: unknown): ConsoleShortcutInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHORTCUTS) return null;
  const parsed: ConsoleShortcutInput[] = [];
  for (const shortcut of value) {
    if (!shortcut || typeof shortcut !== "object") return null;
    const { name, command } = shortcut;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 40 ||
      NON_PRINTING.test(name) ||
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 200 ||
      NON_PRINTING.test(command)
    )
      return null;
    parsed.push({ name: name.trim(), command: command.trim() });
  }
  return parsed;
}

export function isShortcutId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

function storageKey(daemonId: string, instanceUuid: string) {
  return createHash("sha256")
    .update(JSON.stringify([daemonId, instanceUuid]))
    .digest("hex");
}

export async function readConsoleShortcuts(
  daemonId: string,
  instanceUuid: string
): Promise<ConsoleShortcut[]> {
  const record: ShortcutList | null = await Storage.getStorage().load(
    CATEGORY,
    ShortcutList,
    storageKey(daemonId, instanceUuid)
  );
  if (!record) return [];
  const shortcuts = parseShortcuts(record.shortcuts);
  if (!shortcuts || !record.shortcuts.every(({ id }) => isShortcutId(id)))
    throw new Error("Invalid stored console shortcuts");
  return shortcuts.map((shortcut, index) => ({ ...shortcut, id: record.shortcuts[index].id }));
}

export async function saveConsoleShortcuts(
  daemonId: string,
  instanceUuid: string,
  input: ConsoleShortcutInput[]
): Promise<ConsoleShortcut[]> {
  const shortcuts = input.map((shortcut) => ({ ...shortcut, id: randomUUID() }));
  await Storage.getStorage().store(CATEGORY, storageKey(daemonId, instanceUuid), { shortcuts });
  return shortcuts;
}
