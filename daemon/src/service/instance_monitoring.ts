import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  MONITORING_INTERVAL_MS,
  type InstanceMonitoringResponse,
  type InstanceMonitoringSample
} from "mcsmanager-common";
import type { IInstanceProcess } from "../entity/instance/interface";
import Instance from "../entity/instance/instance";
import logger from "./log";
import { MAX_SAMPLE_GAP_MS, MonitoringHistory, nextLowTpsCount } from "./monitoring/metrics";
import { readResources } from "./monitoring/resources";
import { probeSpark } from "./monitoring/spark";

interface InstanceHistory {
  history: MonitoringHistory;
  current: InstanceMonitoringSample | null;
  memoryLimitBytes: number | null;
  running: IInstanceProcess | undefined;
  lowTps: number;
  lastProbe: number;
}

class InstanceMonitoring {
  private readonly entries = new Map<Instance, InstanceHistory>();
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;

  start(getInstances: () => Iterable<Instance>) {
    if (this.controller) return;
    this.controller = new AbortController();
    const { signal } = this.controller;
    let collecting = false;
    const collect = async () => {
      if (collecting || signal.aborted) return;
      collecting = true;
      try {
        const now = Date.now();
        for (const [instance, { history }] of this.entries) {
          if (!history.prune(now) && instance.status() !== Instance.STATUS_RUNNING) {
            this.entries.delete(instance);
          }
        }
        let pending: Promise<void>[] = [];
        for (const instance of getInstances()) {
          if (signal.aborted) break;
          if (instance.status() !== Instance.STATUS_RUNNING || !instance.process) continue;
          pending.push(
            this.sample(instance, instance.process, signal).catch(() => {
              if (!signal.aborted)
                logger.debug(`Monitoring sample unavailable for ${instance.instanceUuid}`);
            })
          );
          if (pending.length === 8) {
            await Promise.all(pending);
            pending = [];
          }
        }
        await Promise.all(pending);
      } finally {
        collecting = false;
      }
    };
    this.timer = setInterval(() => void collect(), MONITORING_INTERVAL_MS).unref();
    void collect();
  }

  stop() {
    this.controller?.abort();
    this.controller = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  clearCurrent(instance: Instance) {
    const state = this.entries.get(instance);
    if (!state) return;
    state.current = null;
    state.running = undefined;
    state.memoryLimitBytes = null;
    state.lowTps = 0;
  }

  remove(instance: Instance) {
    this.entries.delete(instance);
  }

  read(instance: Instance, compact: boolean): InstanceMonitoringResponse {
    const state = this.entries.get(instance);
    const now = Date.now();
    const current =
      state?.current &&
      state.running === instance.process &&
      instance.status() === Instance.STATUS_RUNNING &&
      now - state.current.timestamp <= MAX_SAMPLE_GAP_MS
        ? state.current
        : null;
    const memoryLimitBytes = current ? state?.memoryLimitBytes ?? null : null;
    return {
      current,
      history: state?.history.read(now, compact) ?? [],
      memoryLimitBytes,
      warnings: {
        memory: Boolean(
          memoryLimitBytes && current?.ramBytes != null && current.ramBytes > 0.9 * memoryLimitBytes
        ),
        tps: Boolean(current && state && state.lowTps >= 3)
      }
    };
  }

  private async sample(instance: Instance, running: IInstanceProcess, shutdown: AbortSignal) {
    let state = this.entries.get(instance);
    if (!state) {
      state = {
        history: new MonitoringHistory(),
        running: undefined,
        current: null,
        memoryLimitBytes: null,
        lowTps: 0,
        lastProbe: -Infinity
      };
      this.entries.set(instance, state);
    }
    const exited = new AbortController();
    const signal = AbortSignal.any([shutdown, exited.signal]);
    const abort = () => exited.abort();
    instance.once("exit", abort);
    const canCollect = () =>
      !signal.aborted &&
      this.entries.get(instance) === state &&
      instance.process === running &&
      instance.status() === Instance.STATUS_RUNNING;

    try {
      const timestamp = Date.now();
      const resources = await readResources(instance, running);
      const sample: InstanceMonitoringSample = {
        timestamp,
        ramBytes: resources.ramBytes,
        cpuPercent: resources.cpuPercent,
        tps: null,
        mspt: null
      };

      if (resources.spark && canCollect()) {
        // File I/O and queueing can shift the start of a sample across minute boundaries.
        const nextProbe = state.lastProbe + MONITORING_INTERVAL_MS;
        while (canCollect() && performance.now() < nextProbe) {
          await delay(Math.ceil(nextProbe - performance.now()), undefined, { signal, ref: false });
        }
        if (canCollect()) {
          Object.assign(
            sample,
            await probeSpark(
              instance,
              () => {
                state.lastProbe = performance.now();
                return instance.execPreset("command", "spark tps");
              },
              signal
            )
          );
        }
      }
      if (!canCollect()) return;

      const previous = state.running === running ? state.current : null;
      state.lowTps = nextLowTpsCount(state.lowTps, previous, sample);
      state.running = running;
      state.current = sample;
      state.memoryLimitBytes = resources.memoryLimitBytes;
      state.history.push(sample);
    } finally {
      instance.off("exit", abort);
    }
  }
}

export const instanceMonitoring = new InstanceMonitoring();
