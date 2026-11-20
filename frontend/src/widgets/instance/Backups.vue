<script setup lang="ts">
import BetweenMenus from "@/components/BetweenMenus.vue";
import CardPanel from "@/components/CardPanel.vue";
import { useAppRouters } from "@/hooks/useAppRouters";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { useBackups } from "@/hooks/useBackups";
import { useScreen } from "@/hooks/useScreen";
import { t } from "@/lang/i18n";
import { getInstanceInfo } from "@/services/apis/instance";
import {
  createBackupPlan,
  deleteBackupPlan,
  listBackupDestinations,
  updateBackupPlan
} from "@/services/apis/backup";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import { INSTANCE_STATUS_CODE } from "@/types/const";
import type { BackupDestinationRef, BackupPlan, BackupRecord } from "@/types/backup";
import BackupJobPanel from "@/widgets/backup/BackupJobPanel.vue";
import BackupPlanEditor from "@/widgets/backup/BackupPlanEditor.vue";
import BackupRecordList from "@/widgets/backup/BackupRecordList.vue";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined
} from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";

const props = defineProps<{ card: LayoutCard }>();

const { isPhone } = useScreen();
const { isAdmin } = useAppStateStore();
const { toPage } = useAppRouters();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const instanceId = String(getMetaOrRouteValue("instanceId") ?? "");
const daemonId = String(getMetaOrRouteValue("daemonId") ?? "");

const {
  records,
  plans,
  running,
  queued,
  loading,
  jobActive,
  restoreActive,
  latestRestore,
  cooldownSeconds,
  refreshAll,
  runNow,
  cancel,
  restore,
  getDownloadUrl
} = useBackups(daemonId, instanceId);

const instanceStatus = ref<number>(INSTANCE_STATUS_CODE.STOPPED);
const isMinecraft = ref(false);
const instanceRunning = computed(() => instanceStatus.value !== INSTANCE_STATUS_CODE.STOPPED);
const planNames = computed(() => Object.fromEntries(plans.value.map((p) => [p.id, p.name])));

const destinations = ref<BackupDestinationRef[]>([]);
const editorOpen = ref(false);
const editingPlan = ref<BackupPlan>();
const savingPlan = ref(false);

const loadInstance = async () => {
  if (!isAdmin.value) return;
  try {
    const { execute } = getInstanceInfo();
    const res = await execute({ params: { uuid: instanceId, daemonId } });
    instanceStatus.value = res.value?.status ?? INSTANCE_STATUS_CODE.STOPPED;
    isMinecraft.value = !!res.value?.config?.type?.includes("minecraft/java");
  } catch (error) {
    reportErrorMsg(error);
  }
};

const safely = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return true;
  } catch (error) {
    reportErrorMsg(error);
    return false;
  }
};

const refresh = async () => {
  await safely(async () => {
    await Promise.all([refreshAll(), loadInstance()]);
  });
};

const backupNow = async (plan: BackupPlan) => {
  const ok = await safely(() => runNow(plan.id, !isAdmin.value));
  if (ok) message.success(t("TXT_CODE_backup_ui.started"));
};

const backupNowDisabled = (plan: BackupPlan) =>
  !plan.enabled || jobActive.value || (!isAdmin.value && cooldownSeconds(plan.id) > 0);

const backupNowLabel = (plan: BackupPlan) => {
  const s = isAdmin.value ? 0 : cooldownSeconds(plan.id);
  return s > 0
    ? t("TXT_CODE_backup_ui.backupNowWait", { seconds: s })
    : t("TXT_CODE_backup_ui.backupNow");
};

const download = async (record: BackupRecord) => {
  await safely(async () => {
    const url = await getDownloadUrl(record.id);
    window.open(url, "_blank");
  });
};

const confirmRestore = (record: BackupRecord, source?: "gdrive") => {
  const action = source ? "restoreFromDrive" : "restore";
  Modal.confirm({
    title: t(source ? "TXT_CODE_backup_ui.restoreFromDrive" : "TXT_CODE_backup_ui.restoreTitle"),
    content: t("TXT_CODE_backup_ui.restoreWarning"),
    okText: t(`TXT_CODE_backup_ui.${action}`),
    okType: "danger",
    cancelText: t("TXT_CODE_backup_ui.cancel"),
    onOk: async () => {
      const ok = await safely(() => (source ? restore(record.id, source) : restore(record.id)));
      if (ok) message.success(t("TXT_CODE_backup_ui.restoreStarted"));
    }
  });
};

const openEditor = async (plan?: BackupPlan) => {
  editingPlan.value = plan;
  await safely(async () => {
    const { execute } = listBackupDestinations();
    const res = await execute();
    destinations.value = (res.value ?? []).map((d) => ({ id: d.id, name: d.name, type: d.type }));
  });
  editorOpen.value = true;
};

const savePlan = async ({ id, plan }: { id?: string; plan: Omit<BackupPlan, "id"> }) => {
  savingPlan.value = true;
  const payload = { ...plan, daemonId, instanceUuid: instanceId };
  const ok = await safely(async () => {
    if (id) await updateBackupPlan().execute({ data: { ...payload, id } });
    else await createBackupPlan().execute({ data: payload });
  });
  savingPlan.value = false;
  if (ok) {
    editorOpen.value = false;
    await safely(() => refreshAll());
  }
};

const removePlan = async (plan: BackupPlan) => {
  const ok = await safely(() =>
    deleteBackupPlan().execute({ data: { daemonId, uuid: instanceId, planId: plan.id } })
  );
  if (ok) await safely(() => refreshAll());
};

const scheduleText = (plan: BackupPlan) => {
  if (!plan.schedule) return t("TXT_CODE_backup_ui.schedule_manual");
  if (plan.schedule.kind === "interval") {
    const total = Number(plan.schedule.value);
    return t("TXT_CODE_backup_ui.everyInterval", {
      value: `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
    });
  }
  return plan.schedule.value;
};

const toConsole = () => toPage({ path: "/instances/terminal", query: { daemonId, instanceId } });

onMounted(refresh);
</script>

<template>
  <div style="height: 100%" class="container">
    <a-row :gutter="[24, 24]" style="height: 100%">
      <a-col :span="24">
        <BetweenMenus>
          <template v-if="!isPhone" #left>
            <a-typography-title class="mb-0" :level="4">
              <CloudUploadOutlined />
              {{ card.title }}
            </a-typography-title>
          </template>
          <template #right>
            <a-button @click="toConsole">{{ t("TXT_CODE_backup_ui.toConsole") }}</a-button>
            <a-button data-test="refresh-btn" @click="refresh">
              {{ t("TXT_CODE_backup_ui.refresh") }}
            </a-button>
            <a-button v-if="isAdmin" type="primary" data-test="new-plan-btn" @click="openEditor()">
              <PlusOutlined />
              {{ t("TXT_CODE_backup_ui.newPlan") }}
            </a-button>
          </template>
        </BetweenMenus>
      </a-col>

      <a-col :span="24">
        <CardPanel :full-height="false">
          <template #title>{{ t("TXT_CODE_backup_ui.plans") }}</template>
          <template #body>
            <BackupJobPanel
              :running="running"
              :queued="queued"
              :is-admin="isAdmin"
              @cancel="(id: string) => safely(() => cancel(id))"
            />
            <a-alert
              v-if="isAdmin && latestRestore && !restoreActive"
              class="mb-12"
              data-test="restore-result"
              :type="latestRestore.ok ? 'success' : 'error'"
              :message="
                t(
                  latestRestore.ok
                    ? 'TXT_CODE_backup_ui.restoreSucceeded'
                    : 'TXT_CODE_backup_ui.restoreFailed'
                )
              "
              show-icon
            >
              <template
                v-if="latestRestore.errorSummary || latestRestore.warnings.length"
                #description
              >
                <div v-if="latestRestore.errorSummary">{{ latestRestore.errorSummary }}</div>
                <div v-for="(warning, index) in latestRestore.warnings" :key="index">
                  {{ warning }}
                </div>
              </template>
            </a-alert>
            <a-table
              :data-source="plans"
              :pagination="false"
              row-key="id"
              size="middle"
              :scroll="{ x: 'max-content' }"
              data-test="plan-list"
            >
              <template #emptyText>
                <span data-test="plans-empty">{{ t("TXT_CODE_backup_ui.noPlans") }}</span>
              </template>
              <a-table-column :title="t('TXT_CODE_backup_ui.planName')" data-index="name" />
              <a-table-column
                v-if="isAdmin"
                key="schedule"
                :title="t('TXT_CODE_backup_ui.schedule')"
              >
                <template #default="{ record }">{{ scheduleText(record) }}</template>
              </a-table-column>
              <a-table-column v-if="isAdmin" key="ret" :title="t('TXT_CODE_backup_ui.retention')">
                <template #default="{ record }">{{ record.retention }}</template>
              </a-table-column>
              <a-table-column key="enabled" :title="t('TXT_CODE_backup_ui.enabled')">
                <template #default="{ record }">
                  <a-tag :color="record.enabled ? 'success' : 'default'">
                    {{
                      record.enabled
                        ? t("TXT_CODE_backup_ui.enabled")
                        : t("TXT_CODE_backup_ui.disabled")
                    }}
                  </a-tag>
                </template>
              </a-table-column>
              <a-table-column key="actions" :title="t('TXT_CODE_backup_ui.colActions')">
                <template #default="{ record }">
                  <a-space>
                    <a-button
                      type="primary"
                      size="small"
                      data-test="backup-now-btn"
                      :disabled="backupNowDisabled(record)"
                      @click="backupNow(record)"
                    >
                      {{ backupNowLabel(record) }}
                    </a-button>
                    <template v-if="isAdmin">
                      <a-button size="small" data-test="edit-plan-btn" @click="openEditor(record)">
                        <EditOutlined />
                      </a-button>
                      <a-popconfirm
                        :title="t('TXT_CODE_backup_ui.deletePlanConfirm')"
                        @confirm="removePlan(record)"
                      >
                        <a-button size="small" danger data-test="delete-plan-btn">
                          <DeleteOutlined />
                        </a-button>
                      </a-popconfirm>
                    </template>
                  </a-space>
                </template>
              </a-table-column>
            </a-table>
          </template>
        </CardPanel>
      </a-col>

      <a-col :span="24">
        <CardPanel :full-height="false">
          <template #title>{{ t("TXT_CODE_backup_ui.records") }}</template>
          <template #body>
            <BackupRecordList
              :records="records"
              :plan-names="planNames"
              :is-admin="isAdmin"
              :instance-running="instanceRunning"
              :job-active="jobActive"
              :loading="loading"
              @download="download"
              @restore="confirmRestore"
            />
          </template>
        </CardPanel>
      </a-col>
    </a-row>

    <BackupPlanEditor
      v-if="isAdmin"
      v-model:open="editorOpen"
      :plan="editingPlan"
      :destinations="destinations"
      :is-minecraft="isMinecraft"
      :saving="savingPlan"
      @save="savePlan"
    />
  </div>
</template>
