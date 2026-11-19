import { describe, expect, it, vi } from "vitest";
import {
  buildSchedule,
  createPlanFormState,
  planToFormState,
  usePlanForm,
  validatePlanForm
} from "../useBackupPlanForm";
import { BACKUP_PRESETS } from "@/types/backup";

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));

const valid = () => {
  const s = createPlanFormState(true);
  s.name = "Nightly";
  s.destinationIds = ["local"];
  return s;
};

describe("plan form", () => {
  it("defaults to the worlds preset and the save hook for Minecraft instances", () => {
    const s = createPlanFormState(true);
    expect(s.preset).toBe("minecraft-worlds");
    expect(s.include).toEqual([...BACKUP_PRESETS["minecraft-worlds"].include]);
    expect(s.minecraftSaveHook).toBe(true);
    const other = createPlanFormState(false);
    expect(other.preset).toBe("whole-directory");
    expect(other.minecraftSaveHook).toBe(false);
  });

  it("fills include/exclude when a preset is picked and flips to custom on edits", () => {
    const { form, applyPreset, markCustom } = usePlanForm(valid());
    applyPreset("minecraft-worlds-plugins-configs");
    expect(form.include).toContain("plugins");
    expect(form.exclude).toContain("session.lock");
    applyPreset("whole-directory");
    expect(form.include).toEqual(["."]);
    markCustom();
    expect(form.preset).toBe("custom");
    form.include = ["only-this"];
    applyPreset("custom");
    expect(form.include).toEqual(["only-this"]);
  });

  it("accepts a valid form and rejects each invalid field with an error", () => {
    expect(validatePlanForm(valid())).toEqual({});
    const bad = valid();
    bad.name = "";
    bad.include = ["../etc"];
    bad.exclude = ["!x"];
    bad.retention = 0;
    bad.destinationIds = [];
    Object.assign(bad, { scheduleMode: "cron", cron: "nope" });
    expect(Object.keys(validatePlanForm(bad)).sort()).toEqual(
      ["destinationIds", "exclude", "include", "name", "retention", "schedule"].sort()
    );
    const six = valid();
    six.destinationIds = ["a", "b", "c", "d", "e", "f"];
    expect(validatePlanForm(six).destinationIds).toBeTruthy();
  });

  it("builds schedules for every mode and round-trips them", () => {
    const s = valid();
    expect(buildSchedule(s)).toBeUndefined();
    s.scheduleMode = "interval";
    s.intervalHours = 2;
    s.intervalMinutes = 30;
    expect(buildSchedule(s)).toEqual({ kind: "interval", value: "9000" });
    s.intervalHours = 0;
    s.intervalMinutes = 0;
    expect(validatePlanForm(s).schedule).toBeTruthy();
    s.scheduleMode = "daily";
    s.dailyTime = "04:05";
    expect(buildSchedule(s)).toEqual({ kind: "cron", value: "5 4 * * *" });

    const plan = {
      id: "p",
      daemonId: "d",
      instanceUuid: "u",
      name: "n",
      preset: "custom" as const,
      include: ["a"],
      exclude: [],
      retention: 3,
      destinationIds: ["local"],
      minecraftSaveHook: false,
      enabled: true
    };
    expect(
      planToFormState({ ...plan, schedule: { kind: "cron", value: "5 4 * * *" } })
    ).toMatchObject({
      scheduleMode: "daily",
      dailyTime: "04:05"
    });
    expect(
      planToFormState({ ...plan, schedule: { kind: "cron", value: "*/5 * * * *" } })
    ).toMatchObject({
      scheduleMode: "cron"
    });
    expect(
      planToFormState({ ...plan, schedule: { kind: "interval", value: "7200" } })
    ).toMatchObject({
      scheduleMode: "interval",
      intervalHours: 2
    });
  });

  it("builds a trimmed payload", () => {
    const { form, toPayload } = usePlanForm(valid());
    form.name = "  Nightly ";
    form.include = [" world "];
    const payload = toPayload("d1", "u1");
    expect(payload).toMatchObject({
      name: "Nightly",
      include: ["world"],
      daemonId: "d1",
      instanceUuid: "u1"
    });
  });
});
