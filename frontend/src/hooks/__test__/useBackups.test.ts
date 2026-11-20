// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { BACKUP_POLL_INTERVAL_MS, buildBackupDownloadUrl, useBackups } from "../useBackups";

const mocks = vi.hoisted(() => ({
  jobs: vi.fn(),
  records: vi.fn(),
  plans: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  restore: vi.fn(),
  download: vi.fn()
}));

vi.mock("@/services/apis/backup", () => ({
  getBackupJobs: () => ({ execute: mocks.jobs }),
  listBackupRecords: () => ({ execute: mocks.records }),
  listBackupPlans: () => ({ execute: mocks.plans }),
  runBackup: () => ({ execute: mocks.run }),
  cancelBackupJob: () => ({ execute: mocks.cancel }),
  restoreBackup: () => ({ execute: mocks.restore }),
  requestBackupDownload: () => ({ execute: mocks.download })
}));

const runningJob = {
  backupId: "b1",
  kind: "backup",
  planId: "p1",
  trigger: "manual",
  state: "running",
  phase: "archiving",
  doneBytes: 1,
  totalBytes: 10,
  queuedAt: 0
};

function mountHook(now?: () => number) {
  let api!: ReturnType<typeof useBackups>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useBackups("d1", "u1", now);
        return () => h("div");
      }
    })
  );
  return { api, wrapper };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.jobs.mockResolvedValue({ value: { queued: [] } });
  mocks.records.mockResolvedValue({ value: [] });
  mocks.plans.mockResolvedValue({ value: [] });
  mocks.run.mockResolvedValue({ value: { backupId: "b1" } });
  mocks.cancel.mockResolvedValue({ value: true });
  mocks.restore.mockResolvedValue({ value: {} });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useBackups polling", () => {
  it("does not poll while no job is active", async () => {
    const { api } = mountHook();
    await api.refreshAll();
    mocks.jobs.mockClear();
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 5);
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("polls every 3 s while a job is active and stops (reloading records) when it ends", async () => {
    mocks.jobs.mockResolvedValue({ value: { running: runningJob, queued: [] } });
    const { api } = mountHook();
    await api.refreshAll();
    expect(api.jobActive.value).toBe(true);
    mocks.jobs.mockClear();
    mocks.records.mockClear();

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 2);
    expect(mocks.jobs).toHaveBeenCalledTimes(2);

    mocks.jobs.mockResolvedValue({ value: { queued: [] } });
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(api.jobActive.value).toBe(false);
    expect(mocks.records).toHaveBeenCalledTimes(1);

    mocks.jobs.mockClear();
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 4);
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("shows a Drive restore result even when the job finishes before the first status request", async () => {
    const { api } = mountHook();
    const latestRestore = { jobId: "restore1", recordId: "bk1", ok: false, warnings: [] };
    mocks.jobs.mockResolvedValue({ value: { queued: [], latestRestore } });
    await api.restore("bk1", "gdrive");
    expect(mocks.restore).toHaveBeenCalledWith({
      data: { daemonId: "d1", uuid: "u1", recordId: "bk1", source: "gdrive" }
    });
    expect(api.latestRestore.value).toEqual(latestRestore);
    expect(api.restoreActive.value).toBe(false);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 2);
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
  });

  it("clears the poll timer on unmount", async () => {
    mocks.jobs.mockResolvedValue({ value: { running: runningJob, queued: [] } });
    const { api, wrapper } = mountHook();
    await api.refreshAll();
    wrapper.unmount();
    mocks.jobs.mockClear();
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 5);
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("starts polling after Backup now", async () => {
    const { api } = mountHook();
    await api.refreshAll();
    mocks.jobs.mockResolvedValue({ value: { running: runningJob, queued: [] } });
    await api.runNow("p1", false);
    expect(mocks.run).toHaveBeenCalledWith({ data: { daemonId: "d1", uuid: "u1", planId: "p1" } });
    mocks.jobs.mockClear();
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
  });
});

describe("useBackups rate limit countdown", () => {
  it("counts down 60 s after a rate limited run", async () => {
    let clock = 1_000_000;
    const { api } = mountHook(() => clock);
    await api.runNow("p1", true);
    expect(api.cooldownSeconds("p1")).toBe(60);
    clock += 20_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.cooldownSeconds("p1")).toBe(40);
    clock += 40_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.cooldownSeconds("p1")).toBe(0);
  });

  it("does not start a cooldown for unrestricted runs", async () => {
    const { api } = mountHook();
    await api.runNow("p1", false);
    expect(api.cooldownSeconds("p1")).toBe(0);
  });
});

describe("useBackups misc", () => {
  it("sorts records newest first and accepts the wrapped form", async () => {
    mocks.records.mockResolvedValue({
      value: {
        records: [
          { id: "a", createdAt: 1 },
          { id: "b", createdAt: 2 }
        ]
      }
    });
    const { api } = mountHook();
    await api.loadRecords();
    expect(api.records.value.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("builds the download URL from the ticket", async () => {
    expect(
      buildBackupDownloadUrl({ addr: "http://1.2.3.4:24444", password: "tk", fileName: "a b.zip" })
    ).toBe("http://1.2.3.4:24444/download/tk/a%20b.zip");
    expect(
      buildBackupDownloadUrl({ addr: "", password: "", fileName: "x", url: "https://h/x" })
    ).toBe("https://h/x");
  });
});
