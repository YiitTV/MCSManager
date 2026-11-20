import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { PluginHint } from "./parser";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_REPORT_BYTES = 96 * 1024;
const MAX_DIRECTORY_ENTRIES = 1024;
const MAX_PLUGIN_DESCRIPTORS = 32;
const MAX_DESCRIPTOR_BYTES = 8192;

function child(dir: FileHandle, name: string) {
  return `/proc/self/fd/${dir.fd}/${name}`;
}

async function openRoot(directory: string) {
  let dir = await open("/", DIRECTORY_FLAGS);
  try {
    for (const name of path.resolve(directory).split("/").filter(Boolean)) {
      const next = await open(child(dir, name), DIRECTORY_FLAGS);
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (err) {
    await dir.close();
    throw err;
  }
}

async function entries(dir: FileHandle, accept: (entry: Dirent) => boolean) {
  const names: string[] = [];
  const listing = await opendir(child(dir, "."));
  let scanned = 0;
  for await (const entry of listing) {
    if (accept(entry)) names.push(entry.name);
    if (++scanned >= MAX_DIRECTORY_ENTRIES) break;
  }
  return names;
}

async function read(file: FileHandle, length: number, position: number) {
  const data = Buffer.alloc(length);
  const { bytesRead } = await file.read({ buffer: data, position });
  return data.subarray(0, bytesRead);
}

async function latestReport(dir: FileHandle, at: number) {
  const names = await entries(dir, (entry) => entry.isFile() && /\.(?:txt|log)$/i.test(entry.name));
  let newest: { name: string; at: number; ino: number; dev: number } | undefined;
  for (const name of names) {
    const stat = await lstat(child(dir, name)).catch(() => undefined);
    if (!stat?.isFile() || stat.nlink !== 1) continue;
    const created = Math.floor(stat.birthtimeMs || stat.mtimeMs);
    if (created >= at - 120_000 && created <= at && (!newest || created > newest.at)) {
      newest = { name, at: created, ino: stat.ino, dev: stat.dev };
    }
  }
  if (!newest) return "";
  const file = await open(child(dir, newest.name), FILE_FLAGS);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== newest.ino || stat.dev !== newest.dev)
      return "";
    return (await read(file, MAX_REPORT_BYTES, 0)).toString("utf8");
  } finally {
    await file.close();
  }
}

// Read a small root plugin.yml in an ordinary JAR. Restrict both central directory and
// inflation sizes so a malformed archive cannot turn optional attribution into bulk I/O.
async function pluginMain(file: FileHandle, size: number) {
  const end = await read(file, Math.min(size, 65_557), Math.max(0, size - 65_557));
  const footer = end.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (
    footer < 0 ||
    footer + 22 > end.length ||
    footer + 22 + end.readUInt16LE(footer + 20) !== end.length
  )
    return;
  const directorySize = end.readUInt32LE(footer + 12);
  const directoryOffset = end.readUInt32LE(footer + 16);
  if (directorySize > 256 * 1024 || directoryOffset + directorySize > size) return;

  const directory = await read(file, directorySize, directoryOffset);
  for (let offset = 0; offset + 46 <= directory.length; ) {
    if (directory.readUInt32LE(offset) !== 0x02014b50) return;
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const name = directory.toString("ascii", offset + 46, offset + 46 + nameLength);
    if (name === "plugin.yml") {
      const sizeOnDisk = directory.readUInt32LE(offset + 20);
      const unpacked = directory.readUInt32LE(offset + 24);
      const start = directory.readUInt32LE(offset + 42);
      const method = directory.readUInt16LE(offset + 10);
      if (
        sizeOnDisk > MAX_DESCRIPTOR_BYTES ||
        unpacked > MAX_DESCRIPTOR_BYTES ||
        directory.readUInt16LE(offset + 8) & 1 ||
        start + 30 > directoryOffset
      )
        return;
      const header = await read(file, 30, start);
      if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50) return;
      const position = start + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (position + sizeOnDisk > directoryOffset) return;
      const data = await read(file, sizeOnDisk, position);
      const raw =
        method === 0
          ? data
          : method === 8
          ? inflateRawSync(data, { maxOutputLength: MAX_DESCRIPTOR_BYTES })
          : undefined;
      if (raw?.length !== unpacked) return;
      return /^main:[ \t]*["']?([\w$]+(?:\.[\w$]+)+)["']?[ \t]*(?:#.*)?\r?$/m.exec(
        raw.toString()
      )?.[1];
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

async function plugins(dir: FileHandle): Promise<PluginHint[]> {
  const names = await entries(
    dir,
    (entry) => entry.isFile() && /^[\w .()+-]{1,150}\.jar$/i.test(entry.name)
  );
  const hints: PluginHint[] = [];
  for (const jar of names.sort()) {
    const file = await open(child(dir, jar), FILE_FLAGS).catch(() => undefined);
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) continue;
      const main =
        hints.length < MAX_PLUGIN_DESCRIPTORS
          ? await pluginMain(file, stat.size).catch(() => undefined)
          : undefined;
      hints.push({ jar, main });
    } finally {
      await file.close();
    }
  }
  return hints;
}

async function readChild<T>(
  root: FileHandle,
  name: string,
  fallback: T,
  collect: (dir: FileHandle) => Promise<T>
) {
  const dir = await open(child(root, name), DIRECTORY_FLAGS).catch(() => undefined);
  if (!dir) return fallback;
  try {
    return await collect(dir);
  } finally {
    await dir.close();
  }
}

export async function readCrashEvidence(directory: string, at: number) {
  const empty = { report: "", plugins: [] as PluginHint[] };
  // Node does not expose openat. Use held directory descriptors on Linux and
  // skip optional filesystem evidence where descriptor-relative opens are unavailable.
  if (process.platform !== "linux" || path.resolve(directory) === "/") return empty;
  const root = await openRoot(directory).catch(() => undefined);
  if (!root) return empty;
  try {
    const report = await readChild(root, "crash-reports", "", (dir) => latestReport(dir, at));
    const hints = await readChild(root, "plugins", [], plugins);
    return { report, plugins: hints };
  } finally {
    await root.close();
  }
}
