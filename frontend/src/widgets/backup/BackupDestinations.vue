<script setup lang="ts">
import { t } from "@/lang/i18n";
import {
  createBackupDestination,
  deleteBackupDestination,
  getGDriveConnectUrl,
  listBackupDestinations,
  testBackupDestination,
  updateBackupDestination
} from "@/services/apis/backup";
import { reportErrorMsg } from "@/tools/validator";
import { BACKUP_LIMITS, type BackupDestination, type BackupTestResult } from "@/types/backup";
import BackupDestinationForm from "@/widgets/backup/BackupDestinationForm.vue";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { onMounted, ref } from "vue";

const destinations = ref<BackupDestination[]>([]);
const loading = ref(false);
const formOpen = ref(false);
const editing = ref<BackupDestination>();
const saving = ref(false);
const testing = ref(false);
const testResult = ref<BackupTestResult>();

const load = async () => {
  loading.value = true;
  try {
    const res = await listBackupDestinations().execute();
    destinations.value = res.value ?? [];
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    loading.value = false;
  }
};

const openForm = (dest?: BackupDestination) => {
  editing.value = dest;
  testResult.value = undefined;
  formOpen.value = true;
};

/** Create or update; returns the destination id. */
const persist = async (payload: BackupDestination): Promise<string> => {
  if (payload.id) {
    await updateBackupDestination().execute({ data: payload });
    return payload.id;
  }
  const { id: _omit, ...body } = payload;
  const res = await createBackupDestination().execute({ data: body });
  return res.value?.id ?? "";
};

const save = async (payload: BackupDestination) => {
  saving.value = true;
  try {
    await persist(payload);
    formOpen.value = false;
    message.success(t("TXT_CODE_backup_ui.saved"));
    await load();
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    saving.value = false;
  }
};

const test = async (payload: BackupDestination) => {
  testing.value = true;
  testResult.value = undefined;
  try {
    const res = await testBackupDestination().execute({ data: { destination: payload } });
    testResult.value = res.value ?? { ok: false };
  } catch (error: any) {
    testResult.value = { ok: false, error: error?.message };
  } finally {
    testing.value = false;
  }
};

const connect = async (payload: BackupDestination) => {
  try {
    const id = await persist(payload);
    const res = await getGDriveConnectUrl().execute({ params: { destinationId: id } });
    const url = typeof res.value === "string" ? res.value : res.value?.url;
    if (url) window.location.href = url;
  } catch (error) {
    reportErrorMsg(error);
  }
};

const remove = async (dest: BackupDestination) => {
  try {
    await deleteBackupDestination().execute({ data: { id: dest.id } });
    message.success(t("TXT_CODE_backup_ui.deleted"));
    await load();
  } catch (error: any) {
    // The panel refuses to delete a destination that plans still use.
    message.error(error?.message || t("TXT_CODE_backup_ui.deleteInUse"));
  }
};

const summary = (d: BackupDestination) => {
  if (d.type === "local") return d.config.directory;
  if (d.type === "s3") return `${d.config.bucket} @ ${d.config.endpoint}`;
  return d.config.authMethod === "oauth"
    ? d.secrets?.refreshToken
      ? t("TXT_CODE_backup_ui.connected", { account: d.config.connectedEmail || "Google" })
      : t("TXT_CODE_backup_ui.notConnected")
    : t("TXT_CODE_backup_ui.authServiceAccount");
};

onMounted(load);
</script>

<template>
  <div class="content-box" data-test="destinations-section">
    <a-typography-title :level="4" class="mb-24">
      {{ t("TXT_CODE_backup_ui.destinationsTitle") }}
    </a-typography-title>
    <a-typography-paragraph type="secondary">
      {{ t("TXT_CODE_backup_ui.destinationsIntro") }}
    </a-typography-paragraph>
    <a-button
      type="primary"
      class="mb-16"
      :disabled="destinations.length >= BACKUP_LIMITS.MAX_DESTINATIONS"
      data-test="add-destination"
      @click="openForm()"
    >
      <PlusOutlined />
      {{ t("TXT_CODE_backup_ui.newDestination") }}
    </a-button>
    <a-table
      :data-source="destinations"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="middle"
      :scroll="{ x: 'max-content' }"
    >
      <template #emptyText>{{ t("TXT_CODE_backup_ui.noDestinations") }}</template>
      <a-table-column :title="t('TXT_CODE_backup_ui.destName')" data-index="name" />
      <a-table-column key="type" :title="t('TXT_CODE_backup_ui.destType')">
        <template #default="{ record }">{{ t(`TXT_CODE_backup_ui.type_${record.type}`) }}</template>
      </a-table-column>
      <a-table-column key="target" :title="t('TXT_CODE_backup_ui.destTarget')">
        <template #default="{ record }">{{ summary(record) }}</template>
      </a-table-column>
      <a-table-column key="actions" :title="t('TXT_CODE_backup_ui.colActions')">
        <template #default="{ record }">
          <a-space>
            <a-button size="small" data-test="edit-destination" @click="openForm(record)">
              <EditOutlined />
            </a-button>
            <a-popconfirm
              :title="t('TXT_CODE_backup_ui.deleteDestinationConfirm')"
              @confirm="remove(record)"
            >
              <a-button size="small" danger data-test="delete-destination">
                <DeleteOutlined />
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </a-table-column>
    </a-table>

    <BackupDestinationForm
      v-model:open="formOpen"
      :destination="editing"
      :saving="saving"
      :testing="testing"
      :test-result="testResult"
      @save="save"
      @test="test"
      @connect="connect"
    />
  </div>
</template>

<style scoped>
.content-box {
  padding: 16px;
  overflow-y: auto;
}
</style>
