import StorageSubsystem from "../../common/system_storage";
import logger from "../log";
import { readCrashEvidence } from "./evidence";
import { CRASH_OUTPUT_LIMIT, parseCrash, type CrashDetails } from "./parser";

const CATEGORY = "InstanceCrashHistory";
const HISTORY_LIMIT = 10;
const MAX_ACTIVE_READS = 4;
let activeReads = 0;

export interface CrashSummary extends CrashDetails {
  at: number;
  exitCode: number | null;
}

/** Byte-bounded ring for the current process, independent of terminal flush timing. */
export class CrashOutputTail {
  private buffer?: Buffer;
  private position = 0;
  private length = 0;

  append(text: string) {
    const data = Buffer.from(text.slice(-CRASH_OUTPUT_LIMIT));
    const suffix = data.subarray(-CRASH_OUTPUT_LIMIT);
    this.buffer ??= Buffer.alloc(CRASH_OUTPUT_LIMIT);
    const first = Math.min(suffix.length, CRASH_OUTPUT_LIMIT - this.position);
    suffix.copy(this.buffer, this.position, 0, first);
    suffix.copy(this.buffer, 0, first);
    this.position = (this.position + suffix.length) % CRASH_OUTPUT_LIMIT;
    this.length = Math.min(this.length + suffix.length, CRASH_OUTPUT_LIMIT);
  }

  take() {
    const buffer = this.buffer;
    const output =
      buffer && this.length === CRASH_OUTPUT_LIMIT
        ? Buffer.concat([buffer.subarray(this.position), buffer.subarray(0, this.position)])
        : buffer?.subarray(0, this.position);
    this.clear();
    return output?.toString("utf8") ?? "";
  }

  clear() {
    this.buffer = undefined;
    this.position = 0;
    this.length = 0;
  }
}

export class CrashHistory {
  private summaries: CrashSummary[] = [];
  private removed = false;

  constructor(private readonly uuid: string) {
    try {
      const saved = StorageSubsystem.load(CATEGORY, null, uuid);
      if (Array.isArray(saved)) this.summaries = saved.slice(0, HISTORY_LIMIT);
    } catch {
      logger.warn(`Could not load crash history for instance ${uuid}`);
    }
  }

  get latestAt() {
    return this.summaries[0]?.at;
  }

  list() {
    return this.summaries;
  }

  private persist() {
    try {
      StorageSubsystem.store(CATEGORY, this.uuid, this.summaries);
    } catch {
      logger.warn(`Could not save crash history for instance ${this.uuid}`);
    }
  }

  async record(directory: string | undefined, output: string, at: number, exitCode: number | null) {
    if (this.removed) return;
    const summary = { at, exitCode, ...parseCrash("", output, []) };
    this.summaries = [summary, ...this.summaries].slice(0, HISTORY_LIMIT);
    this.persist();

    if (!directory || activeReads >= MAX_ACTIVE_READS) return;
    activeReads++;
    try {
      const { report, plugins } = await readCrashEvidence(directory, at);
      if (this.removed || !this.summaries.includes(summary)) return;
      Object.assign(summary, parseCrash(report, output, plugins));
      this.persist();
    } catch {
      logger.debug(`Could not read optional crash evidence for instance ${this.uuid}`);
    } finally {
      activeReads--;
    }
  }

  remove() {
    this.removed = true;
    this.summaries = [];
    try {
      StorageSubsystem.delete(CATEGORY, this.uuid);
    } catch {
      logger.warn(`Could not remove crash history for instance ${this.uuid}`);
    }
  }
}
