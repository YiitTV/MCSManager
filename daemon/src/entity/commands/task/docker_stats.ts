import Dockerode from "dockerode";
import { DefaultDocker } from "../../../service/docker_service";
import type { IInstanceProcess } from "../../instance/interface";
import Instance from "../../instance/instance";
import { ILifeCycleTask } from "../../instance/life_cycle";

export default class DockerStatsTask implements ILifeCycleTask {
  private static defaultDocker = new DefaultDocker();

  private static readonly monitoring = new WeakMap<
    Instance,
    { process: IInstanceProcess; timestamp: number; ramBytes?: number; cpuPercent?: number }
  >();

  static getMonitoringStats(instance: Instance, process: IInstanceProcess) {
    const cached = this.monitoring.get(instance);
    if (cached?.process === process && Date.now() - cached.timestamp < 15_000) return cached;
  }

  public status: number = 0;
  public name: string = "DockerStats";
  private task: NodeJS.Timeout | null = null;
  private isUpdating = false;
  private lastStatsMap: Map<string, { [key: string]: number | undefined; timestamp: number }> =
    new Map();

  private calculateRealTimeRate<T extends Record<string, number | undefined>>(
    currentValues: T,
    statsName: string
  ): T {
    const currentTimestamp = Date.now();
    const result = {} as T;
    const lastStats = this.lastStatsMap.get(statsName);

    if (lastStats) {
      const timeDelta = (currentTimestamp - lastStats.timestamp) / 1000;

      if (timeDelta > 0) {
        for (const key in currentValues) {
          const currentValue = currentValues[key];
          const lastValue = lastStats[key];

          if (currentValue !== undefined && lastValue !== undefined) {
            result[key] = Math.max(0, (currentValue - lastValue) / timeDelta) as T[Extract<
              keyof T,
              string
            >];
          }
        }
      }
    }

    this.lastStatsMap.set(statsName, {
      ...currentValues,
      timestamp: currentTimestamp
    });

    return result;
  }

  private getDockerNetworkCumulative(networks?: Dockerode.NetworkStats) {
    if (!networks || typeof networks !== "object") {
      return {
        rxBytes: undefined,
        txBytes: undefined,
        interfaceNames: undefined,
        source: "docker" as const
      };
    }

    let rxBytes = 0;
    let txBytes = 0;
    let hasNetworkData = false;
    const interfaceNames: string[] = [];
    for (const [interfaceName, networkInterface] of Object.entries(networks)) {
      if (interfaceName.startsWith("lo")) continue;
      interfaceNames.push(interfaceName);
      const interfaceRxBytes = networkInterface?.rx_bytes;
      const interfaceTxBytes = networkInterface?.tx_bytes;
      if (typeof interfaceRxBytes === "number" && Number.isFinite(interfaceRxBytes)) {
        rxBytes += interfaceRxBytes;
        hasNetworkData = true;
      }
      if (typeof interfaceTxBytes === "number" && Number.isFinite(interfaceTxBytes)) {
        txBytes += interfaceTxBytes;
        hasNetworkData = true;
      }
    }

    if (!hasNetworkData) {
      return {
        rxBytes: undefined,
        txBytes: undefined,
        interfaceNames: undefined,
        source: "docker" as const
      };
    }

    return {
      rxBytes,
      txBytes,
      interfaceNames: interfaceNames.sort(),
      source: "docker" as const
    };
  }

  private getCpuUsage(stats: Dockerode.ContainerStats) {
    if (!stats?.cpu_stats?.cpu_usage) return undefined;
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    let numberCpus = 1;
    if (Array.isArray(stats.cpu_stats.cpu_usage.percpu_usage)) {
      numberCpus = stats.cpu_stats.cpu_usage.percpu_usage.length;
    } else if (typeof stats.cpu_stats.online_cpus === "number") {
      numberCpus = stats.cpu_stats.online_cpus;
    }
    if (systemCpuDelta > 0 && cpuDelta > 0) {
      return Math.ceil((cpuDelta / systemCpuDelta) * numberCpus * 100.0);
    }
    return 0;
  }

  async updateStats(containerId: string, instance: Instance) {
    if (this.isUpdating) {
      return;
    }
    this.isUpdating = true;

    try {
      const process = instance.process;
      const container = DockerStatsTask.defaultDocker.getContainer(containerId);
      const stats = await container.stats({ stream: false });
      if (!process || instance.process !== process) return;

      const memory = stats.memory_stats?.stats as
        | (Dockerode.MemoryStats["stats"] & { anon?: number })
        | undefined;
      const cpuPercent = this.getCpuUsage(stats);
      DockerStatsTask.monitoring.set(instance, {
        process,
        timestamp: Date.now(),
        ramBytes:
          memory?.total_rss ?? memory?.rss ?? memory?.anon ?? stats.memory_stats?.privateworkingset,
        cpuPercent
      });

      let rxBytes: number | undefined = undefined;
      let txBytes: number | undefined = undefined;
      let rxRate: number | undefined = undefined;
      let txRate: number | undefined = undefined;
      let networkInterfaces: string[] | undefined = undefined;
      let networkStatsSource: "docker" | undefined = undefined;

      const networkStats = this.getDockerNetworkCumulative(stats.networks);
      rxBytes = networkStats.rxBytes;
      txBytes = networkStats.txBytes;
      networkInterfaces = networkStats.interfaceNames;
      networkStatsSource = networkStats.source;

      const networkRates = this.calculateRealTimeRate({ rxBytes, txBytes }, "network");
      rxRate = networkRates.rxBytes;
      txRate = networkRates.txBytes;

      const memoryUsage = stats.memory_stats.usage - (stats.memory_stats.stats.cache ?? 0);
      const memoryUsagePercent = Math.ceil((memoryUsage / stats.memory_stats.limit) * 100);

      const result = {
        cpuUsage: cpuPercent,
        rxBytes,
        txBytes,
        rxRate,
        txRate,
        networkInterfaces,
        networkStatsSource,
        memoryUsagePercent,
        memoryUsage,
        memoryLimit: stats.memory_stats.limit
      };

      instance.info = { ...instance.info, ...result };
    } catch (error) {
      // ignore error
    } finally {
      this.isUpdating = false;
    }
  }

  async start(instance: Instance) {
    const containerId = String(instance.process?.pid ?? "");
    if (!containerId) return;
    if (!instance.config.docker?.image || instance.config.processType !== "docker") return;
    this.task = setInterval(() => {
      this.updateStats(containerId, instance);
    }, 4000);
  }

  async stop(instance: Instance) {
    DockerStatsTask.monitoring.delete(instance);
    if (this.task) {
      clearInterval(this.task);
      this.task = null;
    }
    this.isUpdating = false;
    this.lastStatsMap.clear();
    instance.info = {
      ...instance.info,
      cpuUsage: undefined,
      rxBytes: undefined,
      txBytes: undefined,
      rxRate: undefined,
      txRate: undefined,
      networkInterfaces: undefined,
      networkStatsSource: undefined,
      memoryUsagePercent: undefined,
      readBytes: undefined,
      writeBytes: undefined,
      storageUsage: 0,
      storageLimit: instance.config.docker?.maxSpace ?? 0
    };
  }
}
