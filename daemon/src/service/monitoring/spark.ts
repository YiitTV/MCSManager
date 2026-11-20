import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { finiteMetric } from "./metrics";

const PROBE_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 16_384;
const NUMBER = "\\d{1,9}(?:\\.\\d{1,6})?";
const TPS_VALUES = new RegExp(`^\\*?${NUMBER}(?:\\s*,\\s*\\*?${NUMBER}){4}$`);
const TICK_GROUP = new RegExp(
  `^${NUMBER}\\s*/\\s*(${NUMBER})\\s*/\\s*${NUMBER}\\s*/\\s*${NUMBER}$`
);

interface TickMetrics {
  tps: number | null;
  mspt: number | null;
}

export class SparkReply {
  private tail = "";
  private expected?: "tps" | "mspt";
  private readonly metrics: TickMetrics = { tps: null, mspt: null };

  push(chunk: string) {
    if (chunk.length > OUTPUT_LIMIT) {
      this.tail = "";
      this.expected = undefined;
    }
    const lines = (this.tail + chunk.slice(-OUTPUT_LIMIT)).split(/\r?\n/);
    this.tail = lines.pop()!.slice(-OUTPUT_LIMIT);
    for (const line of lines) {
      const result = this.readLine(line);
      if (result) return result;
    }
  }

  get result(): TickMetrics {
    return { ...this.metrics };
  }

  private readLine(line: string) {
    const clean = stripVTControlCharacters(line).replace(/§[\da-fk-orx]/gi, "");
    const content = clean.trim().replace(/^\[[^\]\r\n]{1,80}\](?:\s*\[[^\]\r\n]{1,80}\])?:\s*/, "");
    const match = /^(?:\[spark\]\s*)?\[(?:⚡|spark)\]\s*(.*)$/i.exec(content);
    if (!match) return;
    const body = match[1].trim();
    if (body === "TPS from last 5s, 10s, 1m, 5m, 15m:") {
      this.expected = "tps";
    } else if (this.metrics.tps !== null && /^Tick durations .* from last 10s, 1m:$/.test(body)) {
      this.expected = "mspt";
    } else if (this.metrics.tps !== null && body.startsWith("CPU usage from last ")) {
      return this.result;
    } else if (this.expected === "tps" && TPS_VALUES.test(body)) {
      this.metrics.tps = finiteMetric(Number(body.split(",")[2].trim().replace(/^\*/, "")));
      this.expected = undefined;
    } else if (this.expected === "mspt") {
      const groups = body.split(";");
      const first = TICK_GROUP.exec(groups[0].trim());
      const second = groups.length === 2 && TICK_GROUP.exec(groups[1].trim());
      if (first && second) {
        this.metrics.mspt = finiteMetric(Number(second[1]));
        return this.result;
      }
    }
  }
}

export function probeSpark(
  console: EventEmitter,
  send: () => Promise<unknown>,
  signal: AbortSignal
): Promise<TickMetrics> {
  return new Promise((resolve) => {
    const parser = new SparkReply();
    const deadline = performance.now() + PROBE_TIMEOUT_MS;
    const finish = (metrics: TickMetrics) => {
      clearTimeout(timer);
      console.off("data", onData);
      signal.removeEventListener("abort", cancel);
      resolve(metrics);
    };
    const cancel = () => finish({ tps: null, mspt: null });
    const onData = (text: unknown) => {
      if (typeof text !== "string" || performance.now() >= deadline) return;
      const reply = parser.push(text);
      if (reply) finish(reply);
    };
    const timer = setTimeout(() => finish(parser.result), PROBE_TIMEOUT_MS);
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    console.on("data", onData);
    try {
      void send().catch(cancel);
    } catch {
      cancel();
    }
  });
}
