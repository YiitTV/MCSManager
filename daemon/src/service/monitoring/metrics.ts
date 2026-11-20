import { MONITORING_INTERVAL_MS, type InstanceMonitoringSample } from "mcsmanager-common";

const CAPACITY = 24 * 60;
const RETENTION_MS = CAPACITY * MONITORING_INTERVAL_MS;
export const MAX_SAMPLE_GAP_MS = 1.5 * MONITORING_INTERVAL_MS;

export class MonitoringHistory {
  private readonly samples: (InstanceMonitoringSample | undefined)[] = new Array(CAPACITY);
  private start = 0;
  private size = 0;

  prune(now: number) {
    while (this.size && this.samples[this.start]!.timestamp <= now - RETENTION_MS) {
      this.discardOldest();
    }
    return this.size;
  }

  push(sample: InstanceMonitoringSample) {
    this.prune(sample.timestamp);
    if (this.size === CAPACITY) this.discardOldest();
    this.samples[(this.start + this.size) % CAPACITY] = sample;
    this.size++;
  }

  read(now: number, compact: boolean) {
    this.prune(now);
    const result: InstanceMonitoringSample[] = [];
    const windowStart = now - 60 * MONITORING_INTERVAL_MS;
    for (let i = compact ? Math.max(0, this.size - 60) : 0; i < this.size; i++) {
      const sample = this.samples[(this.start + i) % CAPACITY]!;
      if (!compact || sample.timestamp > windowStart) result.push(sample);
    }
    return result;
  }

  private discardOldest() {
    this.samples[this.start] = undefined;
    this.start = (this.start + 1) % CAPACITY;
    this.size--;
  }
}

export function parseMaxHeap(command: string) {
  const units = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  let bytes: number | undefined;
  for (const [, size, suffix] of command.matchAll(
    /(?:^|[\s'"])-Xmx(\d{1,16})([kKmMgGtT]?)(?=$|[\s'"])/g
  )) {
    const value = Number(size) * units[suffix.toLowerCase() as keyof typeof units];
    if (Number.isSafeInteger(value) && value > 0) bytes = value;
  }
  return bytes;
}

export function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function nextLowTpsCount(
  count: number,
  previous: InstanceMonitoringSample | null,
  sample: InstanceMonitoringSample
) {
  if (sample.tps === null || sample.tps >= 15) return 0;
  if (!previous || sample.timestamp - previous.timestamp > MAX_SAMPLE_GAP_MS) return 1;
  return Math.min(count + 1, 3);
}
