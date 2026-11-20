import { stripVTControlCharacters } from "node:util";
import { isMinecraftPlayerName, minecraftCommand, VELOCITY_TYPE } from "mcsmanager-common";
import type Instance from "../entity/instance/instance";

const ROSTER_INTERVAL_MS = 30_000;
const REPLY_TIMEOUT_MS = 3_000;
const MAX_REPLY_LENGTH = 32 * 1024;
const MAX_NAMES = 1024;

function playerNames(text: string) {
  return text ? text.split(/,\s*/u).filter(isMinecraftPlayerName) : [];
}

export function createRosterParser(velocity: boolean) {
  const names = new Set<string>();

  return (line: string): string[] | undefined => {
    const message = stripVTControlCharacters(line)
      .replace(/§[0-9a-fk-orx]/giu, "")
      .trim()
      .replace(/^\[\d{2}:\d{2}:\d{2}\](?:\s+\[[^\]]+\])+:\s*/u, "")
      .replace(/^\[\d{2}:\d{2}:\d{2}(?: [^\]]+)?\]:\s*/u, "")
      .replace(/^\[RCON\]\s*/u, "");
    if (!velocity) {
      const reply = /^There are (\d+)(?: of a max of |\/)\d+ players online:\s*(.*)$/u.exec(
        message
      );
      if (!reply) return;
      const players = playerNames(reply[2]);
      if (players.length === Number(reply[1]) && players.length <= MAX_NAMES) return players;
      return;
    }

    const row = /^\[([^\]]+)\]\s+\((\d+)\):\s*(.+)$/u.exec(message);
    if (row) {
      const players = playerNames(row[3]);
      if (players.length === Number(row[2])) {
        for (const name of players) {
          if (names.size < MAX_NAMES) names.add(name);
        }
      }
      return;
    }
    const total =
      /^(\d+) players? (?:is|are) currently connected to the proxy\.$/u.exec(message) ??
      /^There are (\d+) player\(s\) online\.$/u.exec(message);
    if (total && names.size === Number(total[1])) return [...names];
  };
}

function readRoster(instance: Instance, velocity: boolean): Promise<string[] | null> {
  return new Promise((resolve) => {
    const parseLine = createRosterParser(velocity);
    let pending = "";
    let received = 0;

    function finish(names: string[] | null) {
      clearTimeout(deadline);
      instance.off("data", onData);
      instance.off("exit", onExit);
      resolve(names);
    }

    function onExit() {
      finish(null);
    }

    function onData(chunk: unknown) {
      if (typeof chunk !== "string") return;
      received += chunk.length;
      if (received > MAX_REPLY_LENGTH) return finish(null);
      const lines = (pending + chunk).split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const names = parseLine(line);
        if (names) return finish(names);
      }
    }

    const deadline = setTimeout(onExit, REPLY_TIMEOUT_MS);
    instance.on("data", onData);
    instance.once("exit", onExit);
    void instance
      .execPreset(
        "command",
        velocity ? "glist all" : minecraftCommand(instance.config.type, "list")
      )
      .catch(onExit);
  });
}

const rosterCache = new WeakMap<
  Instance,
  { process: Instance["process"]; type: string; time: number; reply: Promise<string[] | null> }
>();

export function getPlayerRoster(instance: Instance) {
  const time = performance.now();
  const cached = rosterCache.get(instance);
  const { process, config } = instance;
  if (
    cached &&
    cached.process === process &&
    cached.type === config.type &&
    time - cached.time < ROSTER_INTERVAL_MS
  ) {
    return cached.reply;
  }

  const reply = readRoster(instance, config.type === VELOCITY_TYPE);
  rosterCache.set(instance, { process, type: config.type, time, reply });
  return reply;
}
