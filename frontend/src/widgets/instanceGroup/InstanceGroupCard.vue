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
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined
} from "@ant-design/icons-vue";
import { computed } from "vue";
import { stepReasonLabel } from "./status";

const props = defineProps<{
  group: InstanceGroupView;
  run: GroupRun | null;
  // A request (start, stop, cancel) for this group is in flight.
  pending?: boolean;
}>();

const emit = defineEmits<{
  start: [];
  stop: [];
  warnedRestart: [];
  cancel: [];
  edit: [];
  remove: [];
}>();

const active = computed(() => isRunActive(props.run));

defineSlots<{
  member(props: { member: GroupMemberView }): unknown;
}>();

const steps = computed(() => {
  const visible = new Map<string, GroupRunStep>();
  for (const step of props.run?.steps ?? []) {
    if (step.state !== "pending" || !visible.has(step.key)) visible.set(step.key, step);
  }
  return visible;
});
const countdownSeconds = computed(() => {
  const deadline = props.run?.countdownEndsAt;
  return deadline === undefined
    ? undefined
    : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
});
const rows = computed(() =>
  props.group.members.map((member) => {
    const key = memberKey(member);
    return { member, key, step: steps.value.get(key) };
  })
);

const finishedSteps = computed(
  () => props.run?.steps.filter((s) => s.state === "done" || s.state === "skipped").length ?? 0
);
const totalSteps = computed(() => props.run?.steps.length ?? 0);
const percent = computed(() =>
  totalSteps.value ? Math.round((finishedSteps.value / totalSteps.value) * 100) : 0
);

const runTitle = computed(() => {
  switch (props.run?.action) {
    case "stop":
      return t("TXT_CODE_instance_group_ui.runStop");
    case "warned-restart":
      return t("TXT_CODE_instance_group_ui.warnedRestart");
    default:
      return t("TXT_CODE_instance_group_ui.runStart");
  }
});

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
        <a-button
          data-test="btn-warned-restart"
          :disabled="active || pending || group.members.length === 0"
          @click="emit('warnedRestart')"
        >
          <template #icon><ReloadOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.warnedRestart") }}
        </a-button>
        <a-button
          v-if="active"
          danger
          data-test="btn-cancel"
          :disabled="pending"
          @click="emit('cancel')"
        >
          <template #icon><CloseCircleOutlined /></template>
          {{ t("TXT_CODE_instance_group_ui.cancel") }}
        </a-button>
        <a-button
          type="text"
          data-test="btn-edit"
          :disabled="active || pending"
          :title="t('TXT_CODE_instance_group_ui.edit')"
          :aria-label="t('TXT_CODE_instance_group_ui.edit')"
          @click="emit('edit')"
        >
          <template #icon><EditOutlined /></template>
        </a-button>
        <a-button
          type="text"
          danger
          data-test="btn-delete"
          :disabled="active || pending"
          :title="t('TXT_CODE_instance_group_ui.delete')"
          :aria-label="t('TXT_CODE_instance_group_ui.delete')"
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
        <span v-if="countdownSeconds !== undefined">
          {{ t("TXT_CODE_instance_group_ui.countdown", { seconds: countdownSeconds }) }}
        </span>
        <span v-else class="run-steps">{{ finishedSteps }} / {{ totalSteps }}</span>
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
      <li v-for="row in rows" :key="row.key" class="member-row" data-test="member-row">
        <slot name="member" :member="row.member" />
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
  padding: 12px;
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

.run-banner {
  border: 1px solid var(--card-border-color);
  border-left: 3px solid var(--color-primary);
  padding: 8px 12px;
  margin-bottom: 12px;

  .run-banner-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
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
  display: grid;
  gap: 12px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.member-step {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding-top: 4px;

  .ant-tag {
    margin: 0;
  }

  &:empty {
    display: none;
  }
}

.member-reason {
  font-size: var(--font-body2);
}
</style>
