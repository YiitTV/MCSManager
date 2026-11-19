<script setup lang="ts">
import { createPlanFormState, planToFormState, usePlanForm } from "@/hooks/useBackupPlanForm";
import { t } from "@/lang/i18n";
import { BACKUP_LIMITS, type BackupDestinationRef, type BackupPlan } from "@/types/backup";
import type { BackupPreset } from "@/types/backup";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  plan?: BackupPlan;
  destinations: BackupDestinationRef[];
  isMinecraft: boolean;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", payload: { id?: string; plan: Omit<BackupPlan, "id"> }): void;
}>();

const initial = () =>
  props.plan ? planToFormState(props.plan) : createPlanFormState(props.isMinecraft);
const { form, errors, isValid, applyPreset, markCustom, toPayload } = usePlanForm(initial());

const touched = ref(false);

watch(
  () => [props.open, props.plan] as const,
  ([open]) => {
    if (!open) return;
    touched.value = false;
    Object.assign(form, initial());
  }
);

const presetOptions = computed(() => [
  { value: "minecraft-worlds", label: t("TXT_CODE_backup_ui.preset_worlds") },
  {
    value: "minecraft-worlds-plugins-configs",
    label: t("TXT_CODE_backup_ui.preset_worldsPlugins")
  },
  { value: "whole-directory", label: t("TXT_CODE_backup_ui.preset_whole") },
  { value: "custom", label: t("TXT_CODE_backup_ui.preset_custom") }
]);

const scheduleOptions = computed(() => [
  { value: "manual", label: t("TXT_CODE_backup_ui.schedule_manual") },
  { value: "interval", label: t("TXT_CODE_backup_ui.schedule_interval") },
  { value: "daily", label: t("TXT_CODE_backup_ui.schedule_daily") },
  { value: "cron", label: t("TXT_CODE_backup_ui.schedule_cron") }
]);

const destinationOptions = computed(() =>
  props.destinations.map((d) => ({ value: d.id, label: `${d.name} (${d.type})` }))
);

const fieldError = (field: string) => (touched.value ? errors.value[field] : undefined);

const onSave = () => {
  touched.value = true;
  if (!isValid.value) return;
  emit("save", {
    id: form.id,
    plan: toPayload(props.plan?.daemonId ?? "", props.plan?.instanceUuid ?? "")
  });
};
</script>

<template>
  <a-modal
    :open="open"
    :title="plan ? t('TXT_CODE_backup_ui.editPlan') : t('TXT_CODE_backup_ui.newPlan')"
    :ok-text="t('TXT_CODE_backup_ui.save')"
    :cancel-text="t('TXT_CODE_backup_ui.cancel')"
    :confirm-loading="saving"
    :width="720"
    data-test="plan-editor"
    @ok="onSave"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical">
      <a-form-item
        :label="t('TXT_CODE_backup_ui.planName')"
        :validate-status="fieldError('name') ? 'error' : ''"
        :help="fieldError('name')"
      >
        <a-input
          v-model:value="form.name"
          :maxlength="BACKUP_LIMITS.MAX_NAME_LENGTH"
          data-test="plan-name"
        />
      </a-form-item>

      <a-form-item :label="t('TXT_CODE_backup_ui.preset')">
        <a-radio-group
          :value="form.preset"
          data-test="preset-group"
          @update:value="(v: BackupPreset) => applyPreset(v)"
        >
          <a-radio-button v-for="p in presetOptions" :key="p.value" :value="p.value">
            {{ p.label }}
          </a-radio-button>
        </a-radio-group>
      </a-form-item>

      <a-form-item
        :label="t('TXT_CODE_backup_ui.include')"
        :extra="t('TXT_CODE_backup_ui.includeHelp')"
        :validate-status="fieldError('include') ? 'error' : ''"
        :help="fieldError('include')"
      >
        <a-select
          v-model:value="form.include"
          mode="tags"
          :open="false"
          :token-separators="[',', ' ']"
          :placeholder="t('TXT_CODE_backup_ui.includePlaceholder')"
          data-test="include-list"
          @change="markCustom"
        />
      </a-form-item>

      <a-form-item
        :label="t('TXT_CODE_backup_ui.exclude')"
        :extra="t('TXT_CODE_backup_ui.excludeHelp')"
        :validate-status="fieldError('exclude') ? 'error' : ''"
        :help="fieldError('exclude')"
      >
        <a-select
          v-model:value="form.exclude"
          mode="tags"
          :open="false"
          :token-separators="[',', ' ']"
          data-test="exclude-list"
          @change="markCustom"
        />
      </a-form-item>

      <a-form-item
        :label="t('TXT_CODE_backup_ui.schedule')"
        :validate-status="fieldError('schedule') ? 'error' : ''"
        :help="fieldError('schedule')"
      >
        <a-select
          v-model:value="form.scheduleMode"
          style="width: 220px"
          :options="scheduleOptions"
          data-test="schedule-mode"
        />
        <div v-if="form.scheduleMode === 'interval'" class="mt-8">
          <a-input-number v-model:value="form.intervalHours" :min="0" :max="8760" />
          {{ t("TXT_CODE_backup_ui.hours") }}
          <a-input-number v-model:value="form.intervalMinutes" :min="0" :max="59" />
          {{ t("TXT_CODE_backup_ui.minutes") }}
        </div>
        <div v-else-if="form.scheduleMode === 'daily'" class="mt-8">
          <a-input v-model:value="form.dailyTime" style="width: 120px" placeholder="04:00" />
          <span class="ml-8 text-secondary">{{ t("TXT_CODE_backup_ui.dailyHelp") }}</span>
        </div>
        <div v-else-if="form.scheduleMode === 'cron'" class="mt-8">
          <a-input v-model:value="form.cron" placeholder="0 4 * * *" data-test="cron-input" />
          <div class="text-secondary">{{ t("TXT_CODE_backup_ui.cronHelp") }}</div>
        </div>
      </a-form-item>

      <a-form-item
        :label="t('TXT_CODE_backup_ui.retention')"
        :extra="t('TXT_CODE_backup_ui.retentionHelp')"
        :validate-status="fieldError('retention') ? 'error' : ''"
        :help="fieldError('retention')"
      >
        <a-input-number
          v-model:value="form.retention"
          :min="BACKUP_LIMITS.MIN_RETENTION"
          :max="BACKUP_LIMITS.MAX_RETENTION"
          data-test="retention"
        />
      </a-form-item>

      <a-form-item
        :label="t('TXT_CODE_backup_ui.destinations')"
        :validate-status="fieldError('destinationIds') ? 'error' : ''"
        :help="fieldError('destinationIds')"
      >
        <a-select
          v-model:value="form.destinationIds"
          mode="multiple"
          :options="destinationOptions"
          :placeholder="t('TXT_CODE_backup_ui.destinationsPlaceholder')"
          data-test="destination-select"
        />
      </a-form-item>

      <a-form-item :extra="t('TXT_CODE_backup_ui.saveHookHelp')">
        <a-switch v-model:checked="form.minecraftSaveHook" data-test="save-hook" />
        <span class="ml-8">{{ t("TXT_CODE_backup_ui.saveHook") }}</span>
      </a-form-item>

      <a-form-item>
        <a-switch v-model:checked="form.enabled" data-test="plan-enabled" />
        <span class="ml-8">{{ t("TXT_CODE_backup_ui.enabled") }}</span>
      </a-form-item>
    </a-form>
  </a-modal>
</template>
