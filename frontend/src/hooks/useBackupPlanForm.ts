import { t } from "@/lang/i18n";
import {
  checkBackupName,
  checkDestinationCount,
  checkExcludeList,
  checkIncludeList,
  checkIntervalSeconds,
  checkRetention,
  isValidCron
} from "@/tools/backupValidation";
import {
  BACKUP_PRESETS,
  type BackupPlan,
  type BackupPreset,
  type BackupSchedule
} from "@/types/backup";
import { computed, reactive } from "vue";

export type ScheduleMode = "manual" | "interval" | "daily" | "cron";

export interface PlanFormState {
  id?: string;
  name: string;
  preset: BackupPreset;
  include: string[];
  exclude: string[];
  scheduleMode: ScheduleMode;
  intervalHours: number;
  intervalMinutes: number;
  dailyTime: string; // HH:mm
  cron: string;
  retention: number;
  destinationIds: string[];
  minecraftSaveHook: boolean;
  enabled: boolean;
}

const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function errorText(code: string | null): string {
  return code ? t(`TXT_CODE_backup_ui.err_${code}`) : "";
}

export function createPlanFormState(isMinecraft: boolean): PlanFormState {
  const preset = isMinecraft ? "minecraft-worlds" : "whole-directory";
  const def = BACKUP_PRESETS[preset];
  return {
    name: "",
    preset,
    include: [...def.include],
    exclude: [...def.exclude],
    scheduleMode: "manual",
    intervalHours: 6,
    intervalMinutes: 0,
    dailyTime: "04:00",
    cron: "0 4 * * *",
    retention: 7,
    destinationIds: [],
    minecraftSaveHook: isMinecraft,
    enabled: true
  };
}

export function planToFormState(plan: BackupPlan): PlanFormState {
  const form = createPlanFormState(false);
  Object.assign(form, {
    id: plan.id,
    name: plan.name,
    preset: plan.preset,
    include: [...plan.include],
    exclude: [...plan.exclude],
    retention: plan.retention,
    destinationIds: [...plan.destinationIds],
    minecraftSaveHook: plan.minecraftSaveHook,
    enabled: plan.enabled
  });
  const s = plan.schedule;
  if (!s) {
    form.scheduleMode = "manual";
  } else if (s.kind === "interval") {
    const total = Number(s.value);
    form.scheduleMode = "interval";
    form.intervalHours = Math.floor(total / 3600);
    form.intervalMinutes = Math.floor((total % 3600) / 60);
  } else {
    const m = DAILY_CRON.exec(s.value.trim());
    if (m && Number(m[1]) < 60 && Number(m[2]) < 24) {
      form.scheduleMode = "daily";
      form.dailyTime = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
    } else {
      form.scheduleMode = "cron";
      form.cron = s.value;
    }
  }
  return form;
}

export function buildSchedule(form: PlanFormState): BackupSchedule | undefined {
  switch (form.scheduleMode) {
    case "interval":
      return {
        kind: "interval",
        value: String(form.intervalHours * 3600 + form.intervalMinutes * 60)
      };
    case "daily": {
      const [h, m] = form.dailyTime.split(":").map(Number);
      return { kind: "cron", value: `${m} ${h} * * *` };
    }
    case "cron":
      return { kind: "cron", value: form.cron.trim() };
    default:
      return undefined;
  }
}

export function validatePlanForm(form: PlanFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const set = (field: string, code: string | null) => {
    if (code) errors[field] = errorText(code);
  };
  set("name", checkBackupName(form.name));
  set("include", checkIncludeList(form.include));
  set("exclude", checkExcludeList(form.exclude));
  set("retention", checkRetention(form.retention));
  set("destinationIds", checkDestinationCount(form.destinationIds));
  const schedule = buildSchedule(form);
  if (schedule?.kind === "interval") {
    set("schedule", checkIntervalSeconds(Number(schedule.value)));
  } else if (schedule?.kind === "cron") {
    if (form.scheduleMode === "daily" && !/^\d{1,2}:\d{2}$/.test(form.dailyTime)) {
      set("schedule", "cron");
    } else if (!isValidCron(schedule.value)) {
      set("schedule", "cron");
    }
  }
  return errors;
}

export function usePlanForm(initial: PlanFormState) {
  const form = reactive<PlanFormState>(initial);
  const errors = computed(() => validatePlanForm(form));
  const isValid = computed(() => Object.keys(errors.value).length === 0);

  /** Pick a preset: fills include/exclude (custom keeps the current lists). */
  const applyPreset = (preset: BackupPreset) => {
    form.preset = preset;
    if (preset !== "custom") {
      const def = BACKUP_PRESETS[preset];
      form.include = [...def.include];
      form.exclude = [...def.exclude];
    }
  };

  /** Editing a list by hand turns the plan into a custom one. */
  const markCustom = () => {
    form.preset = "custom";
  };

  const toPayload = (daemonId: string, instanceUuid: string): Omit<BackupPlan, "id"> => ({
    daemonId,
    instanceUuid,
    name: form.name.trim(),
    preset: form.preset,
    include: form.include.map((s) => s.trim()),
    exclude: form.exclude.map((s) => s.trim()),
    schedule: buildSchedule(form),
    retention: form.retention,
    destinationIds: [...form.destinationIds],
    minecraftSaveHook: form.minecraftSaveHook,
    enabled: form.enabled
  });

  return { form, errors, isValid, applyPreset, markCustom, toPayload };
}
