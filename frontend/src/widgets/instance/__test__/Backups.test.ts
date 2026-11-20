// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { Modal } from "ant-design-vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import Backups from "../Backups.vue";
import { installDomShims } from "@/widgets/backup/__test__/setup";

const mocks = vi.hoisted(() => ({
  isAdmin: { value: true } as { value: boolean },
  jobs: vi.fn(),
  records: vi.fn(),
  plans: vi.fn(),
  run: vi.fn(),
  restore: vi.fn(),
  download: vi.fn(),
  destinations: vi.fn(),
  instance: vi.fn()
}));

vi.mock("@/lang/i18n", async () => (await import("@/widgets/backup/__test__/setup")).i18nMock);
vi.mock("@/tools/validator", () => ({ reportErrorMsg: vi.fn() }));
vi.mock("@/hooks/useAppRouters", () => ({ useAppRouters: () => ({ toPage: vi.fn() }) }));
vi.mock("@/hooks/useCardTools", () => ({
  useLayoutCardTools: () => ({
    getMetaOrRouteValue: (k: string) => (k === "daemonId" ? "d1" : "u1")
  })
}));
vi.mock("@/stores/useAppStateStore", () => ({
  useAppStateStore: () => ({
    get isAdmin() {
      return ref(mocks.isAdmin.value);
    }
  })
}));
vi.mock("@/services/apis/instance", () => ({
  getInstanceInfo: () => ({ execute: mocks.instance })
}));
vi.mock("@/services/apis/backup", () => ({
  getBackupJobs: () => ({ execute: mocks.jobs }),
  listBackupRecords: () => ({ execute: mocks.records }),
  listBackupPlans: () => ({ execute: mocks.plans }),
  runBackup: () => ({ execute: mocks.run }),
  cancelBackupJob: () => ({ execute: vi.fn() }),
  restoreBackup: () => ({ execute: mocks.restore }),
  requestBackupDownload: () => ({ execute: mocks.download }),
  listBackupDestinations: () => ({ execute: mocks.destinations }),
  createBackupPlan: () => ({ execute: vi.fn() }),
  updateBackupPlan: () => ({ execute: vi.fn() }),
  deleteBackupPlan: () => ({ execute: vi.fn() })
}));

beforeAll(installDomShims);

const plan = {
  id: "p1",
  daemonId: "d1",
  instanceUuid: "u1",
  name: "Nightly",
  preset: "minecraft-worlds",
  include: ["world"],
  exclude: [],
  retention: 7,
  destinationIds: ["local"],
  minecraftSaveHook: true,
  enabled: true
};
const record = {
  id: "r1",
  planId: "p1",
  createdAt: 1_700_000_000_000,
  sizeBytes: 1024,
  sha256: "x",
  trigger: "manual",
  warnings: [],
  copies: { local: { status: "ok", type: "local", name: "Local" } }
};
const runningJob = {
  backupId: "b1",
  kind: "backup",
  planId: "p1",
  trigger: "manual",
  state: "running",
  phase: "uploading",
  doneBytes: 50,
  totalBytes: 100,
  queuedAt: 0
};

let wrapper: VueWrapper<any>;
const mountPage = async () => {
  wrapper = mount(Backups, { props: { card: { id: "c", title: "Backups" } as any } });
  await flushPromises();
};

beforeEach(() => {
  mocks.isAdmin.value = true;
  mocks.jobs.mockResolvedValue({ value: { queued: [] } });
  mocks.records.mockResolvedValue({ value: [record] });
  mocks.plans.mockResolvedValue({ value: [plan] });
  mocks.run.mockResolvedValue({ value: { backupId: "b1" } });
  mocks.restore.mockResolvedValue({ value: {} });
  mocks.destinations.mockResolvedValue({ value: [] });
  mocks.instance.mockResolvedValue({ value: { status: 0, config: { type: "minecraft/java" } } });
});

afterEach(() => {
  wrapper?.unmount();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Backups page roles", () => {
  it("shows plan management and restore to administrators", async () => {
    await mountPage();
    expect(wrapper.find("[data-test=new-plan-btn]").exists()).toBe(true);
    expect(wrapper.find("[data-test=edit-plan-btn]").exists()).toBe(true);
    expect(wrapper.find("[data-test=delete-plan-btn]").exists()).toBe(true);
    expect(wrapper.find("[data-test=restore-btn]").exists()).toBe(true);
    expect(wrapper.find("[data-test=backup-now-btn]").exists()).toBe(true);
  });

  it("hides admin controls from assigned users but keeps Backup now and download", async () => {
    mocks.isAdmin.value = false;
    await mountPage();
    expect(wrapper.find("[data-test=new-plan-btn]").exists()).toBe(false);
    expect(wrapper.find("[data-test=edit-plan-btn]").exists()).toBe(false);
    expect(wrapper.find("[data-test=delete-plan-btn]").exists()).toBe(false);
    expect(wrapper.find("[data-test=restore-btn]").exists()).toBe(false);
    expect(wrapper.find("[data-test=backup-now-btn]").exists()).toBe(true);
    expect(wrapper.find("[data-test=download-btn]").exists()).toBe(true);
    // the admin-only instance detail request is not made for users
    expect(mocks.instance).not.toHaveBeenCalled();
  });
});

describe("Backups page states", () => {
  it("disables Backup now and shows progress while a job is active", async () => {
    mocks.jobs.mockResolvedValue({ value: { running: runningJob, queued: [] } });
    await mountPage();
    expect(wrapper.find("[data-test=backup-now-btn]").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-test=job-panel]").exists()).toBe(true);
    expect(wrapper.find("[data-test=job-phase]").text()).toContain(
      "TXT_CODE_backup_ui.phase_uploading"
    );
    expect(wrapper.find("[data-test=cancel-btn]").exists()).toBe(true);
  });

  it("shows Drive download progress and then the restore outcome", async () => {
    const restore = { ...runningJob, kind: "restore", phase: "downloading" };
    mocks.jobs.mockResolvedValue({ value: { running: restore, queued: [] } });
    await mountPage();
    expect(wrapper.find("[data-test=job-phase]").text()).toContain(
      "TXT_CODE_backup_ui.phase_downloading"
    );
    const latestRestore = {
      jobId: restore.backupId,
      recordId: record.id,
      ok: false,
      errorSummary: "Archive checksum mismatch",
      warnings: []
    };
    mocks.jobs.mockResolvedValue({ value: { queued: [], latestRestore } });
    await wrapper.find("[data-test=refresh-btn]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test=job-panel]").exists()).toBe(false);
    expect(wrapper.find("[data-test=restore-result]").text()).toContain(
      "Archive checksum mismatch"
    );
  });

  it("does not offer cancel to regular users", async () => {
    mocks.isAdmin.value = false;
    mocks.jobs.mockResolvedValue({ value: { running: runningJob, queued: [] } });
    await mountPage();
    expect(wrapper.find("[data-test=cancel-btn]").exists()).toBe(false);
  });

  it("shows a 60 s countdown on Backup now for regular users", async () => {
    mocks.isAdmin.value = false;
    await mountPage();
    vi.useFakeTimers();
    await wrapper.find("[data-test=backup-now-btn]").trigger("click");
    await flushPromises();
    expect(mocks.run).toHaveBeenCalledWith({ data: { daemonId: "d1", uuid: "u1", planId: "p1" } });
    const btn = wrapper.find("[data-test=backup-now-btn]");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.text()).toContain("{seconds}=60");
  });

  it("does not rate limit administrators", async () => {
    await mountPage();
    await wrapper.find("[data-test=backup-now-btn]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test=backup-now-btn]").attributes("disabled")).toBeUndefined();
  });

  it("disables restore while the instance is running", async () => {
    mocks.instance.mockResolvedValue({ value: { status: 3, config: { type: "minecraft/java" } } });
    await mountPage();
    expect(wrapper.find("[data-test=restore-btn]").attributes("disabled")).toBeDefined();
  });
});

describe("Backups restore confirmation", () => {
  it("asks for confirmation with the overwrite warning before restoring", async () => {
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation((() => ({})) as any);
    await mountPage();
    await wrapper.find("[data-test=restore-btn]").trigger("click");
    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0][0] as any;
    expect(options.content).toBe("TXT_CODE_backup_ui.restoreWarning");
    // nothing restored until the user confirms
    expect(mocks.restore).not.toHaveBeenCalled();
    await options.onOk();
    expect(mocks.restore).toHaveBeenCalledWith({
      data: { daemonId: "d1", uuid: "u1", recordId: "r1" }
    });
  });
});
