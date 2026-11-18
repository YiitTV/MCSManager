<script setup lang="ts">
import { t } from "@/lang/i18n";
import {
  isRunActive,
  memberKey,
  type GroupMemberView,
  type GroupRun,
  type GroupRunStep,
  type InstanceGroupView
} from "@/types/instanceGroup";
import {
  CloseCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PoweroffOutlined
} from "@ant-design/icons-vue";
import { computed } from "vue";
import {
  isMemberUnavailable,
  memberStatusColor,
  memberStatusLabel,
  stepReasonLabel
} from "./status";

const props = defineProps<{
  group: InstanceGroupView;
  run: GroupRun | null;
  // A request (start, stop, cancel) for this group is in flight.
  pending?: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  cancel: [];
  edit: [];
  remove: [];
  openConsole: [member: GroupMemberView];
}>();

const active = computed(() => isRunActive(props.run));

// While a stop is running, rows follow the stop order, otherwise the start order.
const rows = computed(() => {
  const list = [...props.group.members];
  if (active.value && props.run?.action === "stop") {
    const index = new Map(props.group.stopOrder.map((key, i) => [key, i]));
    list.sort((a, b) => (index.get(memberKey(a)) ?? 0) - (index.get(memberKey(b)) ?? 0));
  }
  return list.map((member) => {
    const key = memberKey(member);
    return {
      member,
      key,
      startPos: props.group.members.findIndex((m) => memberKey(m) === key) + 1,
      stopPos: props.group.stopOrder.indexOf(key) + 1,
      step: props.run?.steps.find((s) => s.key === key)
    };
  });
});

const finishedSteps = computed(
  () => props.run?.steps.filter((s) => s.state === "done" || s.state === "skipped").length ?? 0
);
const totalSteps = computed(() => props.run?.steps.length ?? 0);
const percent = computed(() =>
  totalSteps.value ? Math.round((finishedSteps.value / totalSteps.value) * 100) : 0
);

const runTitle = computed(() =>
  props.run?.action === "stop"
    ? t("TXT_CODE_instance_group_ui.runStop")
    : t("TXT_CODE_instance_group_ui.runStart")
);

const runStateText = computed(() => {
  switch (props.run?.state) {
    case "running":
      return t("TXT_CODE_instance_group_ui.runRunning");
    case "succeeded":
      return t("TXT_CODE_instance_group_ui.runSucceeded");
    case "failed":
      return t("TXT_CODE_instance_group_ui.runFailed");
    case "cancelled":
      return t("TXT_CODE_instance_group_ui.runCancelled");
    default:
      return "";
  }
});

const runStateColor = computed(() => {
  switch (props.run?.state) {
    case "running":
      return "orange";
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    default:
      return "";
  }
});

const progressStatus = computed(() => {
  if (props.run?.state === "failed") return "exception";
  if (props.run?.state === "succeeded") return "success";
  return active.value ? "active" : "normal";
});

// Follow the theme primary colour while running; ant uses red and green for the end states.
const progressColor = computed(() =>
  props.run?.state === "failed" || props.run?.state === "succeeded"
    ? undefined
    : "var(--color-primary)"
);

const stepText = (step: GroupRunStep | undefined) => {
  switch (step?.state) {
    case "waiting":
      return t("TXT_CODE_instance_group_ui.stepWaiting");
    case "done":
      return t("TXT_CODE_instance_group_ui.stepDone");
    case "skipped":
      return t("TXT_CODE_instance_group_ui.stepSkipped");
    case "failed":
      return t("TXT_CODE_instance_group_ui.stepFailed");
    case "pending":
      return t("TXT_CODE_instance_group_ui.stepPending");
    default:
      return "";
  }
};

const stepColor = (step: GroupRunStep | undefined) => {
  switch (step?.state) {
    case "waiting":
      return "orange";
    case "done":
      return "green";
    case "failed":
      return "red";
    default:
      return "";
  }
};
</script>

<template>
  <section class="instance-group-card" data-test="group-card">
    <header class="group-header">
      <div class="group-title">
        <a-typography-title :level="5" class="group-name" :title="group.name">
          {{ group.name }}
        </a-typography-title>
        <span class="group-count">
          {{ t("TXT_CODE_instance_group_ui.membersCount", { count: group.members.length }) }}
        </span>
      </div>
      <div class="group-actions">
        <a-button
          type="primary"
          data-test="btn-start"
          :disabled="active || pending || group.members.length === 0"
          @click="emit('start')"
        >
          <template #icon><PlayCircleOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.start") }}
        </a-button>
        <a-button
          data-test="btn-stop"
          :disabled="active || pending || group.members.length === 0"
          @click="emit('stop')"
        >
          <template #icon><PoweroffOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.stop") }}
        </a-button>
        <a-button v-if="active" danger data-test="btn-cancel" @click="emit('cancel')">
          <template #icon><CloseCircleOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.cancel") }}
        </a-button>
        <span class="group-actions-divider" />
        <a-button
          type="text"
          data-test="btn-edit"
          :disabled="active"
          :title="t('TXT_CODE_instance_group_ui.edit')"
          @click="emit('edit')"
        >
          <template #icon><EditOutlined /></template>
        </a-button>
        <a-button
          type="text"
          danger
          data-test="btn-delete"
          :disabled="active"
          :title="t('TXT_CODE_instance_group_ui.delete')"
          @click="emit('remove')"
        >
          <template #icon><DeleteOutlined /></template>
        </a-button>
      </div>
    </header>

    <div v-if="run" class="run-banner" data-test="run-banner">
      <div class="run-banner-line">
        <strong>{{ runTitle }}</strong>
        <a-tag :color="runStateColor" class="run-state">{{ runStateText }}</a-tag>
        <span class="run-steps">{{ finishedSteps }} / {{ totalSteps }}</span>
      </div>
      <a-progress
        :percent="percent"
        :status="progressStatus"
        :stroke-color="progressColor"
        :show-info="false"
        size="small"
      />
    </div>

    <ol class="member-list">
      <li
        v-for="row in rows"
        :key="row.key"
        class="member-row"
        :class="{ 'member-unavailable': isMemberUnavailable(row.member) }"
        data-test="member-row"
      >
        <span class="member-order" :title="t('TXT_CODE_instance_group_ui.orderHint')">
          {{ t("TXT_CODE_instance_group_ui.startShort") }} {{ row.startPos }}
          <span class="member-order-sep">/</span>
          {{ t("TXT_CODE_instance_group_ui.stopShort") }} {{ row.stopPos }}
        </span>
        <span class="member-name" data-test="member-name">
          {{
            isMemberUnavailable(row.member)
              ? t("TXT_CODE_instance_group_ui.unavailable")
              : row.member.nickname || row.member.instanceUuid
          }}
        </span>
        <a-tag
          v-if="!isMemberUnavailable(row.member)"
          :color="memberStatusColor(row.member)"
          class="member-status"
          data-test="member-status"
        >
          {{ memberStatusLabel(row.member) }}
        </a-tag>
        <span class="member-step">
          <a-tag
            v-if="row.step && run"
            :color="stepColor(row.step)"
            :title="stepReasonLabel(row.step.reason)"
            data-test="member-step"
          >
            {{ stepText(row.step) }}
          </a-tag>
          <span v-if="row.step?.reason" class="member-reason" data-test="member-reason">{{
            stepReasonLabel(row.step.reason)
          }}</span>
        </span>
        <a-button
          size="small"
          data-test="btn-console"
          :disabled="isMemberUnavailable(row.member)"
          :title="t('TXT_CODE_instance_group_ui.openConsole')"
          @click="emit('openConsole', row.member)"
        >
          <template #icon><CodeOutlined /></template>
          <span class="console-btn-text">{{ t("TXT_CODE_instance_group_ui.openConsole") }}</span>
        </a-button>
      </li>
    </ol>
  </section>
</template>

<style lang="scss" scoped>
.instance-group-card {
  border: 1px solid var(--card-border-color);
  background-color: var(--background-color-white);
  color: var(--text-color);
  box-shadow: 0 1px 2px 1px var(--card-shadow-color);
  padding: 16px;
}

.group-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.group-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.group-name {
  margin: 0 !important;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  font-size: var(--font-body2);
  opacity: 0.65;
  white-space: nowrap;
}

.group-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.group-actions-divider {
  width: 1px;
  height: 20px;
  background: var(--card-border-color);
  margin: 0 4px;
}

.run-banner {
  border: 1px solid var(--card-border-color);
  border-left: 3px solid var(--color-primary);
  padding: 8px 12px;
  margin-bottom: 12px;

  .run-banner-line {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .run-state {
    margin: 0;
  }
  .run-steps {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--card-border-color);

  &:first-child {
    border-top: none;
  }
}

.member-order {
  flex: 0 0 74px;
  font-size: var(--font-body2);
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
  white-space: nowrap;
}

.member-order-sep {
  opacity: 0.5;
}

.member-name {
  flex: 1 1 140px;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-status,
.member-step :deep(.ant-tag) {
  margin: 0;
}

.member-step {
  flex: 0 1 220px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.member-reason {
  font-size: var(--font-body2);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-unavailable {
  opacity: 0.5;
  font-style: italic;

  .member-name {
    font-weight: 400;
  }
}

@media (max-width: 992px) {
  .member-row {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .member-order {
    flex-basis: 100%;
  }
  .member-step {
    flex-basis: 100%;
    order: 5;
  }
  .console-btn-text {
    display: none;
  }
  .group-name {
    max-width: 200px;
  }
}
</style>
