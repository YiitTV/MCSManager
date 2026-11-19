import { describe, expect, it, vi } from "vitest";
import { BACKUP_PROTOCOL, BackupErrorCode } from "mcsmanager-common";
import { BackupIndexStore } from "../index_store";
import { isValidBackupActionPayload, triggerScheduledBackup } from "../scheduler_hook";
import { MemoryBackupStorage } from "./helpers";

vi.mock("../../log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});

describe("scheduled backup action", () => {
  it("validates the payload format", () => {
    expect(isValidBackupActionPayload("plan-1_A")).toBe(true);
    for (const bad of ["", "../x", "a b", "x".repeat(65), 5, undefined, "a/b"]) {
      expect(isValidBackupActionPayload(bad)).toBe(false);
    }
  });

  it("broadcasts backup/trigger when a panel is connected and does not wait", () => {
    const broadcast = vi.fn();
    const store = new BackupIndexStore(new MemoryBackupStorage());
    const r = triggerScheduledBackup("inst1", "plan1", {
      store,
      hasPanel: () => true,
      broadcast,
      now: () => 5
    });
    expect(r).toBe("triggered");
    expect(broadcast).toHaveBeenCalledWith(BACKUP_PROTOCOL.TRIGGER, {
      instanceUuid: "inst1",
      planId: "plan1"
    });
    expect(store.list("inst1")).toEqual([]);
  });

  it("records panel_unreachable and keeps a pending event without a panel", async () => {
    const broadcast = vi.fn();
    const store = new BackupIndexStore(new MemoryBackupStorage());
    const r = triggerScheduledBackup("inst1", "plan1", {
      store,
      hasPanel: () => false,
      broadcast,
      now: () => 5
    });
    expect(r).toBe("panel_unreachable");
    await new Promise((res) => setTimeout(res, 20));
    expect(broadcast).not.toHaveBeenCalled();
    expect(store.list("inst1")).toHaveLength(1);
    const pending = await store.takePendingEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0].errorCode).toBe(BackupErrorCode.PANEL_UNREACHABLE);
    expect(pending[0].record.trigger).toBe("schedule");
  });
});
