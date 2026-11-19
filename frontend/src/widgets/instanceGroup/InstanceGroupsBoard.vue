<script setup lang="ts">
import Empty from "@/components/Empty.vue";
import { useInstanceGroupsBoard } from "@/hooks/useInstanceGroupsBoard";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import { GROUP_LIMITS, memberKey, type GroupMemberRef } from "@/types/instanceGroup";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import BoardInstanceCard from "./BoardInstanceCard.vue";
import InstanceGroupCard from "./InstanceGroupCard.vue";
import InstanceGroupEditor from "./InstanceGroupEditor.vue";

defineProps<{ card: LayoutCard }>();
const emit = defineEmits<{ openInstance: [daemonId: string, instanceUuid: string] }>();
const openInstance = (target: GroupMemberRef) =>
  emit("openInstance", target.daemonId, target.instanceUuid);

const {
  groups,
  runs,
  pending,
  isLoading,
  isAdmin,
  ungrouped,
  getMemberInstance,
  reload,
  onStart,
  onStop,
  onCancel,
  onRemove,
  editorOpen,
  editingGroup,
  saving,
  saveError,
  openEditor,
  onSave,
  openConsole,
  onRefreshInstance
} = useInstanceGroupsBoard();
</script>

<template>
  <div class="instance-groups-board">
    <div class="board-actions">
      <a-button :loading="isLoading" data-test="btn-refresh" @click="reload">
        <template #icon><ReloadOutlined /></template>
        {{ t("TXT_CODE_instance_group_ui.refresh") }}
      </a-button>
      <a-button
        type="primary"
        data-test="btn-create"
        :disabled="isLoading || groups.length >= GROUP_LIMITS.maxGroups"
        @click="openEditor()"
      >
        <template #icon><PlusOutlined /></template>
        {{ t("TXT_CODE_instance_group_ui.create") }}
      </a-button>
    </div>

    <div class="board-columns" :aria-busy="isLoading" data-test="board-columns">
      <InstanceGroupCard
        v-for="group in groups"
        :key="group.uuid"
        class="board-column"
        :group="group"
        :run="runs[group.uuid] ?? null"
        :pending="pending[group.uuid]"
        @start="onStart(group)"
        @stop="onStop(group)"
        @cancel="onCancel(group)"
        @edit="openEditor(group)"
        @remove="onRemove(group)"
      >
        <template #member="{ member }">
          <BoardInstanceCard
            :card="card"
            :instance="getMemberInstance(member)"
            :is-admin="isAdmin"
            @open-instance="openInstance"
            @open-console="openConsole"
            @refresh="onRefreshInstance"
          />
        </template>
      </InstanceGroupCard>

      <section class="board-column ungrouped-column" data-test="ungrouped-column">
        <a-typography-title :level="5">
          {{ t("TXT_CODE_instance_group_ui.ungrouped") }}
        </a-typography-title>
        <div class="ungrouped-cards">
          <BoardInstanceCard
            v-for="instance in ungrouped"
            :key="memberKey(instance)"
            :card="card"
            :instance="instance"
            :is-admin="isAdmin"
            @open-instance="openInstance"
            @open-console="openConsole"
            @refresh="onRefreshInstance"
          />
        </div>
        <Empty v-if="!isLoading && ungrouped.length === 0" />
      </section>
    </div>

    <InstanceGroupEditor
      v-model:open="editorOpen"
      :group="editingGroup"
      :saving="saving"
      :save-error="saveError"
      @save="onSave"
    />
  </div>
</template>

<style lang="scss" scoped>
.instance-groups-board {
  min-width: 0;
}

.board-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.board-columns {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  overflow-x: auto;
  padding: 2px 2px 12px;
}

.board-column {
  box-sizing: border-box;
  flex: 0 0 320px;
  min-width: 300px;
}

.ungrouped-column {
  border: 1px solid var(--card-border-color);
  background-color: var(--background-color-white);
  box-shadow: 0 1px 2px 1px var(--card-shadow-color);
  padding: 12px;
}

.ungrouped-cards {
  display: grid;
  gap: 12px;
}

@media (max-width: 992px) {
  .board-columns {
    flex-direction: column;
    overflow-x: visible;
  }

  .board-column {
    flex: auto;
    min-width: 0;
    width: 100%;
  }
}
</style>
