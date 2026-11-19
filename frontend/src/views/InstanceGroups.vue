<script setup lang="ts">
import Empty from "@/components/Empty.vue";
import { useInstanceGroups } from "@/hooks/useInstanceGroups";
import { MAX_MINI_CONSOLES, useMiniConsoles } from "@/hooks/useMiniConsoles";
import { t } from "@/lang/i18n";
import { getValidatorErrorMsg, reportErrorMsg } from "@/tools/validator";
import {
  GROUP_LIMITS,
  type GroupMemberView,
  type GroupRun,
  type InstanceGroupInput,
  type InstanceGroupView
} from "@/types/instanceGroup";
import InstanceGroupCard from "@/widgets/instanceGroup/InstanceGroupCard.vue";
import InstanceGroupEditor from "@/widgets/instanceGroup/InstanceGroupEditor.vue";
import MiniConsoleHost from "@/widgets/miniConsole/MiniConsoleHost.vue";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";

const onRunFinished = (group: InstanceGroupView | undefined, run: GroupRun) => {
  const name = group?.name ?? "";
  if (run.state === "succeeded") {
    message.success(t("TXT_CODE_instance_group_ui.finishedOk", { name }));
  } else if (run.state === "cancelled") {
    message.info(t("TXT_CODE_instance_group_ui.finishedCancelled", { name }));
  } else {
    message.error(t("TXT_CODE_instance_group_ui.finishedFailed", { name }));
  }
};

const {
  groups,
  runs,
  isLoading,
  load,
  startGroup,
  stopGroup,
  cancelGroup,
  removeGroup,
  saveGroup
} = useInstanceGroups({ onRunFinished });

// Group ids with a request in flight, so buttons cannot be double-clicked.
const pending = reactive<Record<string, boolean>>({});

const guarded = async (groupId: string, task: () => Promise<unknown>) => {
  if (pending[groupId]) return;
  pending[groupId] = true;
  try {
    await task();
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    pending[groupId] = false;
  }
};

const onStart = (group: InstanceGroupView) => guarded(group.uuid, () => startGroup(group.uuid));
const onStop = (group: InstanceGroupView) => guarded(group.uuid, () => stopGroup(group.uuid));
const onCancel = (group: InstanceGroupView) => guarded(group.uuid, () => cancelGroup(group.uuid));
const onRemove = (group: InstanceGroupView) => guarded(group.uuid, () => removeGroup(group.uuid));

const editorOpen = ref(false);
const editingGroup = ref<InstanceGroupView>();
const saving = ref(false);
const saveError = ref("");

const openEditor = (group?: InstanceGroupView) => {
  editingGroup.value = group;
  saveError.value = "";
  editorOpen.value = true;
};

const onSave = async (input: InstanceGroupInput) => {
  saving.value = true;
  saveError.value = "";
  try {
    await saveGroup(editingGroup.value?.uuid, input);
    editorOpen.value = false;
  } catch (error) {
    // The panel answers with a translated reason (403 member no longer assigned, 409 run active).
    saveError.value = getValidatorErrorMsg(error, t("TXT_CODE_6a365d01"));
  } finally {
    saving.value = false;
  }
};

const miniConsoles = useMiniConsoles();

const openConsole = (member: GroupMemberView) => {
  const result = miniConsoles.open({
    daemonId: member.daemonId,
    instanceUuid: member.instanceUuid,
    title: member.nickname || member.instanceUuid
  });
  if (!result.ok) {
    message.warning(t("TXT_CODE_mini_console.limitReached", { max: MAX_MINI_CONSOLES }));
  }
};

// Mini consoles only live on this page: leaving closes them and frees their streams.
onBeforeRouteLeave(() => miniConsoles.closeAll());
onUnmounted(() => miniConsoles.closeAll());

const reload = async () => {
  try {
    await load();
  } catch (error) {
    reportErrorMsg(error);
  }
};

onMounted(reload);
</script>

<template>
  <main class="main-layout-container instance-groups-page">
    <div class="page-header">
      <div>
        <a-typography-title :level="3" class="page-title">
          {{ t("TXT_CODE_instance_group_ui.title") }}
        </a-typography-title>
        <a-typography-text type="secondary">
          {{ t("TXT_CODE_instance_group_ui.help") }}
        </a-typography-text>
      </div>
      <div class="page-actions">
        <a-button :loading="isLoading" data-test="btn-refresh" @click="reload">
          <template #icon><ReloadOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.refresh") }}
        </a-button>
        <a-button
          type="primary"
          data-test="btn-create"
          :disabled="groups.length >= GROUP_LIMITS.maxGroups"
          @click="openEditor()"
        >
          <template #icon><PlusOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.create") }}
        </a-button>
      </div>
    </div>

    <div class="group-stack" data-test="group-stack">
      <InstanceGroupCard
        v-for="group in groups"
        :key="group.uuid"
        :group="group"
        :run="runs[group.uuid] ?? null"
        :pending="pending[group.uuid]"
        @start="onStart(group)"
        @stop="onStop(group)"
        @cancel="onCancel(group)"
        @edit="openEditor(group)"
        @open-console="openConsole"
        @remove="onRemove(group)"
      />
      <Empty
        v-if="!isLoading && groups.length === 0"
        :description="t('TXT_CODE_instance_group_ui.empty')"
      />
    </div>

    <InstanceGroupEditor
      v-model:open="editorOpen"
      :group="editingGroup"
      :saving="saving"
      :save-error="saveError"
      @save="onSave"
    />
    <MiniConsoleHost />
  </main>
</template>

<style lang="scss" scoped>
.instance-groups-page {
  padding-bottom: 48px;
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.page-title {
  margin-bottom: 4px !important;
}

.page-actions {
  display: flex;
  gap: 8px;
}

.group-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
