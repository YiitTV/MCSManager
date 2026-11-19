<script setup lang="ts">
import { useSelectInstances } from "@/components/fc";
import { useInstanceGroupEditor, type EditorMember } from "@/hooks/useInstanceGroupEditor";
import { t } from "@/lang/i18n";
import { userInfoApi } from "@/services/apis";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { reportErrorMsg } from "@/tools/validator";
import {
  GROUP_LIMITS,
  memberKey,
  type GroupAdvanceMode,
  type InstanceGroupInput,
  type InstanceGroupView
} from "@/types/instanceGroup";
import type { UserInstance } from "@/types/user";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  PlusOutlined
} from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  // Group being edited; undefined creates a new group.
  group?: InstanceGroupView;
  saving?: boolean;
  // Translated message of the last failed save (for example a 403 for a member that is no longer
  // assigned), shown inside the dialog so it cannot be missed.
  saveError?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  save: [input: InstanceGroupInput];
}>();

const {
  form,
  stopMembers,
  errors,
  isValid,
  reset,
  syncMembers,
  removeMember,
  moveStart,
  moveStop,
  toInput
} = useInstanceGroupEditor();
const { isAdmin } = useAppStateStore();

const showErrors = ref(false);
const title = computed(() =>
  props.group
    ? t("TXT_CODE_instance_group_ui.editTitle")
    : t("TXT_CODE_instance_group_ui.createTitle")
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    reset(props.group);
    showErrors.value = false;
  },
  { immediate: true }
);

const toEditorMember = (item: UserInstance): EditorMember => ({
  daemonId: item.daemonId,
  instanceUuid: item.instanceUuid,
  nickname: item.nickname
});

const asUserInstances = (): UserInstance[] =>
  form.members.map((m) => ({
    daemonId: m.daemonId,
    instanceUuid: m.instanceUuid,
    nickname: m.nickname,
    hostIp: "",
    status: 0
  }));

// Regular users pick from the instances assigned to them (the panel re-validates on save).
const userPickerOpen = ref(false);
const userCandidates = ref<UserInstance[]>([]);
const userPickerSelection = ref<string[]>([]);
const userPickerLoading = ref(false);

const openPicker = async () => {
  if (isAdmin.value) {
    // Administrators reuse the node based instance picker.
    const picked = await useSelectInstances(asUserInstances());
    if (picked) syncMembers(picked.map(toEditorMember));
    return;
  }
  userPickerOpen.value = true;
  userPickerLoading.value = true;
  userPickerSelection.value = form.members.map(memberKey);
  try {
    const info = await userInfoApi().execute({ params: { advanced: true }, forceRequest: true });
    userCandidates.value = info.value?.instances ?? [];
  } catch (error) {
    reportErrorMsg(error);
  } finally {
    userPickerLoading.value = false;
  }
};

const confirmUserPicker = () => {
  const chosen = new Set(userPickerSelection.value);
  syncMembers(userCandidates.value.filter((i) => chosen.has(memberKey(i))).map(toEditorMember));
  userPickerOpen.value = false;
};

const submit = () => {
  showErrors.value = true;
  if (!isValid.value) return;
  emit("save", toInput());
};

const modeOptions: { value: GroupAdvanceMode; label: () => string }[] = [
  { value: "pattern", label: () => t("TXT_CODE_instance_group_ui.modePattern") },
  { value: "running", label: () => t("TXT_CODE_instance_group_ui.modeRunning") },
  { value: "delay", label: () => t("TXT_CODE_instance_group_ui.modeDelay") }
];

const memberName = (m: EditorMember) =>
  m.unavailable
    ? `${t("TXT_CODE_instance_group_ui.unavailable")} (${m.instanceUuid})`
    : m.nickname || m.instanceUuid;
</script>

<template>
  <a-modal
    :open="open"
    :title="title"
    :width="860"
    centered
    :mask-closable="false"
    :confirm-loading="saving"
    :ok-text="t('TXT_CODE_instance_group_ui.save')"
    :cancel-text="t('TXT_CODE_instance_group_ui.cancelEdit')"
    @ok="submit"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical" class="group-editor" data-test="group-editor">
      <a-form-item :label="t('TXT_CODE_instance_group_ui.name')" required>
        <a-input
          v-model:value="form.name"
          data-test="input-name"
          :maxlength="GROUP_LIMITS.nameMax + 20"
          :placeholder="t('TXT_CODE_instance_group_ui.namePlaceholder')"
        />
      </a-form-item>

      <div class="members-header">
        <strong>{{ t("TXT_CODE_instance_group_ui.members") }}</strong>
        <span class="members-count">{{ form.members.length }} / {{ GROUP_LIMITS.maxMembers }}</span>
        <a-button size="small" data-test="btn-add-members" @click="openPicker">
          <template #icon><PlusOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.addInstances") }}
        </a-button>
      </div>

      <a-row :gutter="[16, 16]">
        <a-col :xs="24" :md="12">
          <div class="order-title">{{ t("TXT_CODE_instance_group_ui.startOrder") }}</div>
          <ol class="order-list" data-test="start-order">
            <li
              v-for="(m, i) in form.members"
              :key="memberKey(m)"
              class="order-item"
              :class="{ 'order-unavailable': m.unavailable }"
              data-test="start-item"
            >
              <span class="order-index">{{ i + 1 }}</span>
              <span class="order-name" :title="memberName(m)">{{ memberName(m) }}</span>
              <a-button
                size="small"
                type="text"
                :data-test="`start-up-${i}`"
                :disabled="i === 0"
                :title="t('TXT_CODE_instance_group_ui.moveUp')"
                @click="moveStart(memberKey(m), -1)"
              >
                <template #icon><ArrowUpOutlined /></template>
              </a-button>
              <a-button
                size="small"
                type="text"
                :data-test="`start-down-${i}`"
                :disabled="i === form.members.length - 1"
                :title="t('TXT_CODE_instance_group_ui.moveDown')"
                @click="moveStart(memberKey(m), 1)"
              >
                <template #icon><ArrowDownOutlined /></template>
              </a-button>
              <a-button
                size="small"
                type="text"
                danger
                :data-test="`remove-${i}`"
                :title="t('TXT_CODE_instance_group_ui.removeMember')"
                @click="removeMember(memberKey(m))"
              >
                <template #icon><CloseOutlined /></template>
              </a-button>
            </li>
          </ol>
          <div v-if="form.members.length === 0" class="order-empty">
            {{ t("TXT_CODE_instance_group_ui.noMembers") }}
          </div>
        </a-col>
        <a-col :xs="24" :md="12">
          <div class="order-title">{{ t("TXT_CODE_instance_group_ui.stopOrder") }}</div>
          <ol class="order-list" data-test="stop-order">
            <li v-for="(m, i) in stopMembers" :key="memberKey(m)" class="order-item">
              <span class="order-index">{{ i + 1 }}</span>
              <span class="order-name" :title="memberName(m)">{{ memberName(m) }}</span>
              <a-button
                size="small"
                type="text"
                :data-test="`stop-up-${i}`"
                :disabled="i === 0"
                :title="t('TXT_CODE_instance_group_ui.moveUp')"
                @click="moveStop(memberKey(m), -1)"
              >
                <template #icon><ArrowUpOutlined /></template>
              </a-button>
              <a-button
                size="small"
                type="text"
                :data-test="`stop-down-${i}`"
                :disabled="i === stopMembers.length - 1"
                :title="t('TXT_CODE_instance_group_ui.moveDown')"
                @click="moveStop(memberKey(m), 1)"
              >
                <template #icon><ArrowDownOutlined /></template>
              </a-button>
            </li>
          </ol>
        </a-col>
      </a-row>

      <a-divider />

      <a-form-item :label="t('TXT_CODE_instance_group_ui.advanceMode')">
        <a-radio-group v-model:value="form.advance.mode" data-test="advance-mode">
          <a-radio v-for="o in modeOptions" :key="o.value" :value="o.value" class="mode-radio">
            {{ o.label() }}
          </a-radio>
        </a-radio-group>
      </a-form-item>

      <a-form-item
        v-if="form.advance.mode === 'pattern'"
        :label="t('TXT_CODE_instance_group_ui.pattern')"
        :extra="t('TXT_CODE_instance_group_ui.patternHelp')"
      >
        <a-input
          v-model:value="form.advance.pattern"
          data-test="input-pattern"
          :maxlength="GROUP_LIMITS.patternMax + 20"
        />
      </a-form-item>

      <a-row :gutter="16">
        <a-col v-if="form.advance.mode === 'delay'" :xs="24" :sm="8">
          <a-form-item :label="t('TXT_CODE_instance_group_ui.delaySec')">
            <a-input-number
              v-model:value="form.advance.delaySec"
              data-test="input-delay"
              :min="0"
              :max="GROUP_LIMITS.delayMax"
              style="width: 100%"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('TXT_CODE_instance_group_ui.startTimeout')">
            <a-input-number
              v-model:value="form.advance.startTimeoutSec"
              data-test="input-start-timeout"
              :min="GROUP_LIMITS.timeoutMin"
              :max="GROUP_LIMITS.timeoutMax"
              style="width: 100%"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="8">
          <a-form-item :label="t('TXT_CODE_instance_group_ui.stopTimeout')">
            <a-input-number
              v-model:value="form.advance.stopTimeoutSec"
              data-test="input-stop-timeout"
              :min="GROUP_LIMITS.timeoutMin"
              :max="GROUP_LIMITS.timeoutMax"
              style="width: 100%"
            />
          </a-form-item>
        </a-col>
      </a-row>

      <a-alert
        v-if="saveError"
        type="error"
        show-icon
        class="save-error"
        data-test="save-error"
        :message="saveError"
      />

      <a-alert
        v-if="showErrors && errors.length"
        type="error"
        show-icon
        data-test="editor-errors"
        :message="errors[0]"
      >
        <template v-if="errors.length > 1" #description>
          <div v-for="e in errors.slice(1)" :key="e">{{ e }}</div>
        </template>
      </a-alert>
    </a-form>

    <a-modal
      v-model:open="userPickerOpen"
      centered
      :title="t('TXT_CODE_instance_group_ui.pickerTitle')"
      :confirm-loading="userPickerLoading"
      :ok-text="t('TXT_CODE_instance_group_ui.pickerConfirm')"
      :cancel-text="t('TXT_CODE_instance_group_ui.cancelEdit')"
      @ok="confirmUserPicker"
    >
      <a-empty
        v-if="!userPickerLoading && userCandidates.length === 0"
        :description="t('TXT_CODE_instance_group_ui.pickerEmpty')"
      />
      <a-checkbox-group v-model:value="userPickerSelection" class="picker-list">
        <a-checkbox v-for="i in userCandidates" :key="memberKey(i)" :value="memberKey(i)">
          {{ i.nickname }}
        </a-checkbox>
      </a-checkbox-group>
    </a-modal>
  </a-modal>
</template>

<style lang="scss" scoped>
.order-unavailable .order-name {
  opacity: 0.55;
  font-style: italic;
}

.save-error {
  margin-bottom: 8px;
}

.members-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.members-count {
  font-size: var(--font-body2);
  opacity: 0.65;
  margin-right: auto;
}

.order-title {
  font-size: var(--font-body2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
  margin-bottom: 6px;
}

.order-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--card-border-color);
  min-height: 40px;
}

.order-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 10px;
  border-top: 1px solid var(--card-border-color);

  &:first-child {
    border-top: none;
  }
}

.order-index {
  flex: 0 0 22px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.order-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-empty {
  padding: 8px 0;
  opacity: 0.6;
}

.mode-radio {
  display: flex;
  margin-bottom: 4px;
}

.picker-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
}
</style>
