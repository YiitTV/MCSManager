<script setup lang="ts">
import { t } from "@/lang/i18n";
import type { BackupRecord } from "@/types/backup";
import { DownloadOutlined, RollbackOutlined } from "@ant-design/icons-vue";
import dayjs from "dayjs";
import prettyBytes from "pretty-bytes";
import { computed } from "vue";

const props = defineProps<{
  records: BackupRecord[];
  planNames: Record<string, string>;
  isAdmin: boolean;
  instanceRunning: boolean;
  jobActive: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: "download", record: BackupRecord): void;
  (e: "restore", record: BackupRecord, source?: "gdrive"): void;
}>();

const formatSize = (bytes: number) => prettyBytes(bytes ?? 0, { binary: true });
const formatDate = (ts: number) => dayjs(ts).format("YYYY-MM-DD HH:mm:ss");

const statusColor = (status: string) =>
  status === "ok" ? "success" : status === "failed" ? "error" : "default";
const statusText = (status: string) => t(`TXT_CODE_backup_ui.status_${status}`);

const hasLocalCopy = (r: BackupRecord) =>
  Object.values(r.copies).some((c) => c.type === "local" && c.status === "ok");
const hasDriveCopy = (r: BackupRecord) =>
  Object.values(r.copies).some((c) => c.type === "gdrive" && c.status === "ok");
const hasOtherCopy = (r: BackupRecord) =>
  Object.values(r.copies).some((c) => c.type !== "gdrive" && c.status === "ok");

const restoreDisabledReason = computed(() => {
  if (props.instanceRunning) return t("TXT_CODE_backup_ui.restoreNeedsStopped");
  if (props.jobActive) return t("TXT_CODE_backup_ui.restoreJobActive");
  return "";
});
</script>

<template>
  <a-table
    :data-source="records"
    :loading="loading"
    :pagination="{ pageSize: 15, hideOnSinglePage: true }"
    :scroll="{ x: 'max-content' }"
    row-key="id"
    size="middle"
    data-test="record-list"
  >
    <template #emptyText>
      <span data-test="records-empty">{{ t("TXT_CODE_backup_ui.noRecords") }}</span>
    </template>
    <a-table-column key="date" :title="t('TXT_CODE_backup_ui.colDate')">
      <template #default="{ record }">{{ formatDate(record.createdAt) }}</template>
    </a-table-column>
    <a-table-column key="plan" :title="t('TXT_CODE_backup_ui.colPlan')">
      <template #default="{ record }">{{ planNames[record.planId] ?? "-" }}</template>
    </a-table-column>
    <a-table-column key="size" :title="t('TXT_CODE_backup_ui.colSize')">
      <template #default="{ record }">{{ formatSize(record.sizeBytes) }}</template>
    </a-table-column>
    <a-table-column key="trigger" :title="t('TXT_CODE_backup_ui.colTrigger')">
      <template #default="{ record }">
        {{
          record.trigger === "schedule"
            ? t("TXT_CODE_backup_ui.triggerSchedule")
            : t("TXT_CODE_backup_ui.triggerManual")
        }}
      </template>
    </a-table-column>
    <a-table-column key="destinations" :title="t('TXT_CODE_backup_ui.colDestinations')">
      <template #default="{ record }">
        <a-tooltip
          v-for="(copy, id) in (record as BackupRecord).copies"
          :key="id"
          :title="copy.error"
        >
          <a-tag :color="statusColor(copy.status)" class="status-chip" :data-status="copy.status">
            {{ copy.name
            }}<template
              v-if="copy.type === 'gdrive' && copy.name !== t('TXT_CODE_backup_ui.type_gdrive')"
            >
              ({{ t("TXT_CODE_backup_ui.type_gdrive") }})
            </template>
            · {{ statusText(copy.status) }}
          </a-tag>
        </a-tooltip>
      </template>
    </a-table-column>
    <a-table-column key="actions" :title="t('TXT_CODE_backup_ui.colActions')">
      <template #default="{ record }">
        <a-space>
          <a-button
            v-if="hasLocalCopy(record)"
            size="small"
            data-test="download-btn"
            @click="emit('download', record)"
          >
            <DownloadOutlined />
            {{ t("TXT_CODE_backup_ui.download") }}
          </a-button>
          <a-tooltip
            v-if="isAdmin && (hasOtherCopy(record) || !hasDriveCopy(record))"
            :title="restoreDisabledReason"
          >
            <a-button
              size="small"
              danger
              data-test="restore-btn"
              :disabled="!hasOtherCopy(record) || instanceRunning || jobActive"
              @click="emit('restore', record)"
            >
              <RollbackOutlined />
              {{ t("TXT_CODE_backup_ui.restore") }}
            </a-button>
          </a-tooltip>
          <a-tooltip v-if="isAdmin && hasDriveCopy(record)" :title="restoreDisabledReason">
            <a-button
              size="small"
              danger
              data-test="restore-drive-btn"
              :disabled="instanceRunning || jobActive"
              @click="emit('restore', record, 'gdrive')"
            >
              <RollbackOutlined />
              {{ t("TXT_CODE_backup_ui.restoreFromDrive") }}
            </a-button>
          </a-tooltip>
        </a-space>
      </template>
    </a-table-column>
  </a-table>
</template>

<style scoped>
.status-chip {
  margin-bottom: 2px;
}
</style>
