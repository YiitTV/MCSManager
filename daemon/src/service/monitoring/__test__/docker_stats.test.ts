import { beforeEach, describe, expect, it, vi } from "vitest";
import DockerStatsTask from "../../../entity/commands/task/docker_stats";
import type { IInstanceProcess } from "../../../entity/instance/interface";
import type Instance from "../../../entity/instance/instance";

const mocks = vi.hoisted(() => ({ stats: vi.fn() }));
vi.mock("../../docker_service", () => ({
  DefaultDocker: class {
    getContainer() {
      return { stats: mocks.stats };
    }
  }
}));

function makeStats(memory: Record<string, number>) {
  return {
    cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 100, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 60 },
    memory_stats: { usage: 500, limit: 800, stats: memory }
  };
}

let instance: Instance;
let running: IInstanceProcess;
beforeEach(() => {
  mocks.stats.mockReset();
  running = { pid: "container" } as IInstanceProcess;
  instance = { process: running, info: {}, config: { docker: {} } } as Instance;
});

describe("Docker monitoring cache", () => {
  it.each([{ total_rss: 300, rss: 100 }, { anon: 300 }])(
    "takes RSS from existing container stats (%j)",
    async (memory) => {
      mocks.stats.mockResolvedValue(makeStats(memory));
      const task = new DockerStatsTask();
      await task.updateStats("container", instance);
      expect(DockerStatsTask.getMonitoringStats(instance, running)).toMatchObject({
        ramBytes: 300,
        cpuPercent: 100
      });
      await task.stop(instance);
      expect(DockerStatsTask.getMonitoringStats(instance, running)).toBeUndefined();
    }
  );

  it("discards a response from a previous run", async () => {
    let resolve!: (stats: ReturnType<typeof makeStats>) => void;
    mocks.stats.mockReturnValue(new Promise((done) => (resolve = done)));
    const task = new DockerStatsTask();
    const pending = task.updateStats("container", instance);
    instance.process = { pid: "replacement" } as IInstanceProcess;
    resolve(makeStats({ total_rss: 300 }));
    await pending;
    expect(DockerStatsTask.getMonitoringStats(instance, instance.process)).toBeUndefined();
    expect(DockerStatsTask.getMonitoringStats(instance, running)).toBeUndefined();
  });
});
