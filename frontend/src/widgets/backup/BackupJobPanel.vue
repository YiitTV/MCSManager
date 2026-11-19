<script setup lang="ts">
import { t } from "@/lang/i18n";
import type { BackupJobStatus } from "@/types/backup";
import { computed } from "vue";

const props = defineProps<{
  running?: BackupJobStatus;
  queued: BackupJobStatus[];
  isAdmin: boolean;
}>();

const emit = defineEmits<{ (e: "cancel", backupId: string): void }>();

const percent = computed(() => {
  const job = props.running;
  if (!job || !job.totalBytes) return 0;
  return Math.min(100, Math.floor((job.doneBytes / job.totalBytes) * 100));
});

const phaseText = computed(() =>
  props.running ? t(`TXT_CODE_backup_ui.phase_${props.running.phase}`) : ""
);
</script>

<template>
  <div v-if="running || queued.length" class="job-panel" data-test="job-panel">
    <div v-if="running" class="job-row">
      <div class="job-title">
        <strong>
          {{
            running.kind === "restore"
              ? t("TXT_CODE_backup_ui.jobRestoring")
              : t("TXT_CODE_backup_ui.jobRunning")
          }}
        </strong>
        <span class="job-phase" data-test="job-phase">{{ phaseText }}</span>
        <span v-if="running.state === 'cancelling'" class="job-phase">
          {{ t("TXT_CODE_backup_ui.cancelling") }}
        </span>
      </div>
      <a-progress
        :percent="percent"
        size="small"
        stroke-color="var(--color-primary)"
        data-test="job-progress"
      />
      <a-button
        v-if="isAdmin && running.kind === 'backup' && running.state !== 'cancelling'"
        size="small"
        danger
        data-test="cancel-btn"
        @click="emit('cancel', running.backupId)"
      >
        {{ t("TXT_CODE_backup_ui.cancelJob") }}
      </a-button>
    </div>
    <div v-if="queued.length" class="job-queued" data-test="job-queued">
      {{ t("TXT_CODE_backup_ui.queued", { count: queued.length }) }}
    </div>
  </div>
</template>

<style scoped>
.job-panel {
  border: 1px solid var(--color-gray-4, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.job-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.job-row :deep(.ant-progress) {
  width: 100%;
}
.job-phase {
  margin-left: 12px;
  opacity: 0.75;
}
.job-queued {
  margin-top: 6px;
  opacity: 0.75;
}
</style>
