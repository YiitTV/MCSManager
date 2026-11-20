// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BackupRecord } from "@/types/backup";
import BackupRecordList from "../BackupRecordList.vue";
import { installDomShims } from "./setup";

vi.mock("@/lang/i18n", async () => (await import("./setup")).i18nMock);
beforeAll(installDomShims);

const record = (over: Partial<BackupRecord> = {}): BackupRecord => ({
  id: "r1",
  planId: "p1",
  createdAt: Date.UTC(2026, 10, 1, 10, 0, 0),
  sizeBytes: 5 * 1024 * 1024,
  sha256: "x",
  trigger: "manual",
  warnings: [],
  copies: {
    local: { status: "ok", type: "local", name: "Local" },
    s3: { status: "failed", type: "s3", name: "R2", error: "DRIVER_AUTH" },
    gd: { status: "deleted", type: "gdrive", name: "Drive" }
  },
  ...over
});

const mountList = (props: Record<string, unknown> = {}) =>
  mount(BackupRecordList, {
    props: {
      records: [record()],
      planNames: { p1: "Nightly" },
      isAdmin: true,
      instanceRunning: false,
      jobActive: false,
      ...props
    }
  });

describe("BackupRecordList", () => {
  it("renders size, plan, trigger and one status chip per destination", () => {
    const w = mountList();
    const text = w.text();
    expect(text).toContain("5 MiB");
    expect(text).toContain("Nightly");
    expect(text).toContain("TXT_CODE_backup_ui.triggerManual");
    const statuses = w.findAll(".status-chip").map((c) => c.attributes("data-status"));
    expect(statuses).toEqual(["ok", "failed", "deleted"]);
  });

  it("shows restore only to administrators; download is available to both", () => {
    const admin = mountList();
    expect(admin.find("[data-test=restore-btn]").exists()).toBe(true);
    expect(admin.find("[data-test=download-btn]").exists()).toBe(true);
    const user = mountList({ isAdmin: false });
    expect(user.find("[data-test=restore-btn]").exists()).toBe(false);
    expect(user.find("[data-test=download-btn]").exists()).toBe(true);
  });

  it("hides download when no local copy is ok", () => {
    const r = record({ copies: { s3: { status: "ok", type: "s3", name: "R2" } } });
    expect(
      mountList({ records: [r] })
        .find("[data-test=download-btn]")
        .exists()
    ).toBe(false);
  });

  it("disables restore while the instance runs or a job is active", () => {
    expect(mountList().find("[data-test=restore-btn]").attributes("disabled")).toBeUndefined();
    expect(
      mountList({ instanceRunning: true }).find("[data-test=restore-btn]").attributes("disabled")
    ).toBeDefined();
    expect(
      mountList({ jobActive: true }).find("[data-test=restore-btn]").attributes("disabled")
    ).toBeDefined();
  });

  it("emits download and restore", async () => {
    const w = mountList();
    await w.find("[data-test=download-btn]").trigger("click");
    await w.find("[data-test=restore-btn]").trigger("click");
    expect(w.emitted("download")?.[0][0]).toMatchObject({ id: "r1" });
    expect(w.emitted("restore")?.[0][0]).toMatchObject({ id: "r1" });
  });

  it("labels Drive-only copies and offers explicit Drive restore to admins", async () => {
    const records = [record({ copies: { gd: { status: "ok", type: "gdrive", name: "Offsite" } } })];
    const admin = mountList({ records });
    expect(admin.text()).toContain("TXT_CODE_backup_ui.type_gdrive");
    expect(admin.find("[data-test=download-btn]").exists()).toBe(false);
    await admin.find("[data-test=restore-drive-btn]").trigger("click");
    expect(admin.emitted("restore")).toEqual([[records[0], "gdrive"]]);
    expect(
      mountList({ records, isAdmin: false }).find("[data-test=restore-drive-btn]").exists()
    ).toBe(false);
  });

  it("shows the empty state", () => {
    expect(mountList({ records: [] }).find("[data-test=records-empty]").exists()).toBe(true);
  });
});
