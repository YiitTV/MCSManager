export const MONITORING_INTERVAL_MS = 60_000;

export interface InstanceMonitoringSample {
  timestamp: number;
  ramBytes: number | null;
  cpuPercent: number | null;
  tps: number | null;
  mspt: number | null;
}

export interface InstanceMonitoringResponse {
  current: InstanceMonitoringSample | null;
  history: InstanceMonitoringSample[];
  memoryLimitBytes: number | null;
  warnings: { memory: boolean; tps: boolean };
}

export function isMonitoringId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}
