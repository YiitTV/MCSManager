import { apiService } from "@/services/apiService";
import { shallowRef, watch } from "vue";
import {
  MONITORING_INTERVAL_MS,
  type InstanceMonitoringResponse,
  type InstanceMonitoringSample
} from "../../../common/src/instance_monitoring";

const REQUEST_SPACING_MS = 300;
type Poll = { due: number; run: () => Promise<void> };
const polls = new Set<Poll>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRequest = -Infinity;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  let next: Poll | undefined;
  for (const poll of polls) {
    if (!next || poll.due < next.due) next = poll;
  }
  const poll = next;
  if (!poll || !Number.isFinite(poll.due)) return;
  const due = Math.max(lastRequest + REQUEST_SPACING_MS, poll.due);
  timer = setTimeout(
    () => {
      lastRequest = Date.now();
      poll.due = Infinity;
      void poll.run().finally(() => {
        poll.due = Date.now() + MONITORING_INTERVAL_MS;
        schedule();
      });
      schedule();
    },
    Math.max(0, due - Date.now())
  );
}

export function useInstanceMonitoring(
  target: () => { daemonId?: string; instanceId?: string; compact?: boolean }
) {
  const data = shallowRef<InstanceMonitoringResponse>();
  const unavailable = shallowRef(false);
  watch(
    target,
    ({ daemonId, instanceId, compact }, _, onCleanup) => {
      data.value = undefined;
      unavailable.value = false;
      if (!daemonId || !instanceId) return;
      const poll: Poll = {
        due: Date.now(),
        run: async () => {
          try {
            const response = await apiService.subscribe<InstanceMonitoringResponse>({
              url: "/api/protected_instance/monitoring",
              method: "GET",
              params: { uuid: instanceId, daemonId, ...(compact && { view: "compact" }) }
            });
            if (!polls.has(poll)) return;
            data.value = response;
            unavailable.value = !response;
          } catch {
            if (!polls.has(poll)) return;
            data.value = undefined;
            unavailable.value = true;
          }
        }
      };
      polls.add(poll);
      schedule();
      onCleanup(() => {
        polls.delete(poll);
        schedule();
      });
    },
    { immediate: true }
  );
  return { data, unavailable };
}

export type MonitoringMetric = "ramBytes" | "cpuPercent" | "tps" | "mspt";

export function monitoringSeries(samples: InstanceMonitoringSample[], metric: MonitoringMetric) {
  const points: [number, number | null][] = [];
  let previous: number | undefined;
  for (const sample of samples) {
    if (previous !== undefined && sample.timestamp - previous > 1.5 * MONITORING_INTERVAL_MS) {
      points.push([previous + MONITORING_INTERVAL_MS, null]);
    }
    points.push([sample.timestamp, sample[metric]]);
    previous = sample.timestamp;
  }
  return points;
}
