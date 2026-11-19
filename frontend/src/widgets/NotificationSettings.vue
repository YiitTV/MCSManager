<script setup lang="ts">
import { useSelectInstances } from "@/components/fc";
import {
  MAX_PANEL_NAME_LENGTH,
  notificationErrorText,
  useNotificationSettings
} from "@/hooks/useNotificationSettings";
import { t } from "@/lang/i18n";
import { toCopy } from "@/tools/copy";
import { reportErrorMsg } from "@/tools/validator";
import type { UserInstance } from "@/types/user";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import dayjs from "dayjs";
import { computed, onMounted, ref } from "vue";

defineProps<{
  maxHeight?: string;
}>();

const {
  form,
  status,
  loading,
  saving,
  rotating,
  testing,
  refreshing,
  revealedSecret,
  testResult,
  urlProblemText,
  tooManyExcluded,
  panelNameValid,
  secretIsSet,
  dirty,
  canSave,
  canTest,
  load,
  refreshStatus,
  save,
  rotate,
  dismissRevealedSecret,
  test,
  setSinkType
} = useNotificationSettings();

const EVENT_GROUPS = [
  { prefix: "instance.", title: "TXT_CODE_notification_ui.groupInstance" },
  { prefix: "backup.", title: "TXT_CODE_notification_ui.groupBackup" },
  { prefix: "group.", title: "TXT_CODE_notification_ui.groupGroup" }
] as const;

const eventLabel = (type: string) =>
  t(`TXT_CODE_notification_ui.event_${type.replace(/\./g, "_")}`);

const eventGroups = computed(() => {
  const keys = Object.keys(form.value.events);
  const groups = EVENT_GROUPS.map((g) => ({
    title: t(g.title),
    keys: keys.filter((k) => k.startsWith(g.prefix))
  }));
  const rest = keys.filter((k) => !EVENT_GROUPS.some((g) => k.startsWith(g.prefix)));
  if (rest.length) groups.push({ title: t("TXT_CODE_notification_ui.groupOther"), keys: rest });
  return groups.filter((g) => g.keys.length > 0);
});

const sinkOptions = computed(() => [
  { value: "bot_http", label: t("TXT_CODE_notification_ui.sinkBot") },
  { value: "discord_webhook", label: t("TXT_CODE_notification_ui.sinkWebhook") }
]);

const urlPlaceholder = computed(() =>
  form.value.sinkType === "discord_webhook"
    ? "https://discord.com/api/webhooks/123456789012345678/xxxxxxxxxxxxxxxxxxxx"
    : "https://bot.example.com/minefield"
);

const showUrlError = computed(() => !!urlProblemText.value);

// Excluded instances are stored as "<daemonId>::<instanceUuid>"; names are only known
// for instances picked in this session, others fall back to a short uuid.
const instanceNames = ref<Record<string, string>>({});
const excludedKey = (i: { daemonId: string; instanceUuid: string }) =>
  `${i.daemonId}::${i.instanceUuid}`;
const excludedLabel = (key: string) =>
  instanceNames.value[key] || key.split("::")[1]?.slice(0, 8) || key;

const toPickerItem = (key: string): UserInstance => {
  const [daemonId = "", instanceUuid = ""] = key.split("::");
  return {
    instanceUuid,
    daemonId,
    hostIp: "",
    status: 0,
    nickname: excludedLabel(key)
  };
};

const pickExcluded = async () => {
  try {
    const picked = await useSelectInstances(form.value.excludedInstances.map(toPickerItem));
    if (!picked) return;
    const names = { ...instanceNames.value };
    for (const item of picked) names[excludedKey(item)] = item.nickname;
    instanceNames.value = names;
    form.value.excludedInstances = picked.map(excludedKey);
  } catch (err: any) {
    reportErrorMsg(err);
  }
};

const removeExcluded = (key: string) => {
  form.value.excludedInstances = form.value.excludedInstances.filter((k) => k !== key);
};

const onSave = async () => {
  try {
    if (await save()) message.success(t("TXT_CODE_notification_ui.saved"));
  } catch (err: any) {
    reportErrorMsg(err);
  }
};

const doRotate = async () => {
  try {
    await rotate();
  } catch (err: any) {
    reportErrorMsg(err);
  }
};

const onRotate = () => {
  if (!secretIsSet.value) return doRotate();
  Modal.confirm({
    title: t("TXT_CODE_notification_ui.rotateConfirmTitle"),
    content: t("TXT_CODE_notification_ui.rotateConfirmDesc"),
    okText: t("TXT_CODE_notification_ui.rotate"),
    cancelText: t("TXT_CODE_AUTOUPDATE_BTN_CANCEL"),
    onOk: doRotate
  });
};

const onTest = async () => {
  await test();
};

const onRefresh = async () => {
  try {
    await refreshStatus();
  } catch (err: any) {
    reportErrorMsg(err);
  }
};

const formatTime = (at: number) => dayjs(at).format("YYYY-MM-DD HH:mm:ss");

onMounted(async () => {
  try {
    await load();
  } catch (err: any) {
    reportErrorMsg(err);
  }
});
</script>

<template>
  <div class="content-box notification-settings" :style="{ maxHeight }">
    <a-typography-title :level="4" class="mb-24">
      {{ t("TXT_CODE_notification_ui.title") }}
    </a-typography-title>
    <a-spin :spinning="loading">
      <a-form :model="form" layout="vertical" class="notification-form">
        <a-form-item>
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.enable") }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t("TXT_CODE_notification_ui.enableDesc") }}
          </a-typography-paragraph>
          <a-switch v-model:checked="form.enabled" data-test="enable-switch" />
        </a-form-item>

        <a-form-item>
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.sinkType") }}
          </a-typography-title>
          <a-radio-group
            :value="form.sinkType"
            :options="sinkOptions"
            data-test="sink-type"
            @update:value="setSinkType"
          />
        </a-form-item>

        <a-form-item
          :validate-status="showUrlError ? 'error' : ''"
          :help="showUrlError ? urlProblemText : ''"
        >
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.url") }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{
              form.sinkType === "discord_webhook"
                ? t("TXT_CODE_notification_ui.urlWebhookDesc")
                : t("TXT_CODE_notification_ui.urlBotDesc")
            }}
          </a-typography-paragraph>
          <a-input
            v-model:value="form.url"
            :placeholder="urlPlaceholder"
            :maxlength="512"
            allow-clear
            data-test="url-input"
          />
        </a-form-item>

        <template v-if="form.sinkType === 'bot_http'">
          <a-form-item>
            <a-typography-title :level="5">
              {{ t("TXT_CODE_notification_ui.secret") }}
            </a-typography-title>
            <a-typography-paragraph type="secondary">
              {{ t("TXT_CODE_notification_ui.secretDesc") }}
            </a-typography-paragraph>
            <div class="row-flex">
              <a-input
                :value="secretIsSet ? '••••••••••••••••' : ''"
                :placeholder="t('TXT_CODE_notification_ui.secretNotSet')"
                disabled
                style="max-width: 320px"
                data-test="secret-input"
              />
              <a-button :loading="rotating" data-test="rotate-btn" @click="onRotate">
                {{
                  secretIsSet
                    ? t("TXT_CODE_notification_ui.rotate")
                    : t("TXT_CODE_notification_ui.generate")
                }}
              </a-button>
            </div>
            <div v-if="revealedSecret" class="secret-reveal mt-12" data-test="secret-reveal">
              <a-alert
                type="warning"
                show-icon
                :message="t('TXT_CODE_notification_ui.secretOnce')"
              />
              <div class="row-flex mt-12">
                <a-input :value="revealedSecret" readonly data-test="secret-plain" />
                <a-button data-test="copy-secret" @click="toCopy(revealedSecret)">
                  <CopyOutlined />
                  {{ t("TXT_CODE_notification_ui.copy") }}
                </a-button>
                <a-button data-test="hide-secret" @click="dismissRevealedSecret">
                  {{ t("TXT_CODE_notification_ui.hide") }}
                </a-button>
              </div>
            </div>
          </a-form-item>

          <a-form-item>
            <a-typography-title :level="5">
              {{ t("TXT_CODE_notification_ui.allowPrivate") }}
            </a-typography-title>
            <a-typography-paragraph type="secondary">
              {{ t("TXT_CODE_notification_ui.allowPrivateDesc") }}
            </a-typography-paragraph>
            <a-switch v-model:checked="form.allowPrivateAddress" data-test="allow-private" />
            <a-alert
              v-if="form.allowPrivateAddress"
              class="mt-12"
              type="warning"
              show-icon
              :message="t('TXT_CODE_notification_ui.allowPrivateWarn')"
            />
          </a-form-item>
        </template>

        <a-form-item
          :validate-status="panelNameValid ? '' : 'error'"
          :help="
            panelNameValid
              ? ''
              : t('TXT_CODE_notification_ui.panelNameInvalid', { max: MAX_PANEL_NAME_LENGTH })
          "
        >
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.panelName") }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t("TXT_CODE_notification_ui.panelNameDesc") }}
          </a-typography-paragraph>
          <a-input
            v-model:value="form.panelName"
            :maxlength="MAX_PANEL_NAME_LENGTH"
            style="max-width: 320px"
            data-test="panel-name"
          />
        </a-form-item>

        <a-form-item>
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.events") }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t("TXT_CODE_notification_ui.eventsDesc") }}
          </a-typography-paragraph>
          <div v-for="group in eventGroups" :key="group.title" class="event-group">
            <div class="event-group-title">{{ group.title }}</div>
            <div class="event-list">
              <label v-for="key in group.keys" :key="key" class="event-item">
                <a-switch
                  v-model:checked="form.events[key]"
                  size="small"
                  :data-test="`ev-${key}`"
                />
                <span>{{ eventLabel(key) }}</span>
              </label>
            </div>
          </div>
        </a-form-item>

        <a-form-item
          :validate-status="tooManyExcluded ? 'error' : ''"
          :help="tooManyExcluded ? t('TXT_CODE_notification_ui.excludedTooMany') : ''"
        >
          <a-typography-title :level="5">
            {{ t("TXT_CODE_notification_ui.excluded") }}
          </a-typography-title>
          <a-typography-paragraph type="secondary">
            {{ t("TXT_CODE_notification_ui.excludedDesc") }}
          </a-typography-paragraph>
          <div class="excluded-tags">
            <a-tag
              v-for="key in form.excludedInstances"
              :key="key"
              closable
              data-test="excluded-tag"
              @close.prevent="removeExcluded(key)"
            >
              {{ excludedLabel(key) }}
            </a-tag>
            <span v-if="!form.excludedInstances.length" class="text-muted">
              {{ t("TXT_CODE_notification_ui.excludedNone") }}
            </span>
          </div>
          <a-button class="mt-12" data-test="pick-excluded" @click="pickExcluded">
            {{ t("TXT_CODE_notification_ui.excludedPick") }}
          </a-button>
        </a-form-item>

        <a-form-item>
          <div class="row-flex">
            <a-button
              type="primary"
              :loading="saving"
              :disabled="!canSave"
              data-test="save-btn"
              @click="onSave"
            >
              {{ t("TXT_CODE_notification_ui.save") }}
            </a-button>
            <a-button :loading="testing" :disabled="!canTest" data-test="test-btn" @click="onTest">
              {{ t("TXT_CODE_notification_ui.test") }}
            </a-button>
          </div>
          <a-typography-paragraph
            v-if="dirty"
            type="secondary"
            class="mt-12"
            data-test="dirty-hint"
          >
            {{ t("TXT_CODE_notification_ui.saveFirst") }}
          </a-typography-paragraph>
          <a-alert
            v-if="testResult"
            class="mt-12"
            show-icon
            :type="testResult.ok ? 'success' : 'error'"
            data-test="test-result"
            :message="
              testResult.ok
                ? t('TXT_CODE_notification_ui.testOk', { status: testResult.status ?? 200 })
                : t('TXT_CODE_notification_ui.testFail', {
                  error: notificationErrorText(testResult.error)
                })
            "
          />
        </a-form-item>

        <a-form-item>
          <div class="row-flex">
            <a-typography-title :level="5" style="margin: 0">
              {{ t("TXT_CODE_notification_ui.status") }}
            </a-typography-title>
            <a-button size="small" :loading="refreshing" data-test="refresh-btn" @click="onRefresh">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </div>
          <a-typography-paragraph type="secondary" class="mt-12">
            {{ t("TXT_CODE_notification_ui.statusDesc") }}
          </a-typography-paragraph>
          <div class="status-grid" data-test="status-block">
            <div class="status-cell">
              <div class="status-num">{{ status.queued }}</div>
              <div>{{ t("TXT_CODE_notification_ui.statusQueued") }}</div>
            </div>
            <div class="status-cell">
              <div class="status-num">{{ status.sent }}</div>
              <div>{{ t("TXT_CODE_notification_ui.statusSent") }}</div>
            </div>
            <div class="status-cell">
              <div class="status-num">{{ status.failed }}</div>
              <div>{{ t("TXT_CODE_notification_ui.statusFailed") }}</div>
            </div>
            <div class="status-cell">
              <div class="status-num">{{ status.dropped }}</div>
              <div>{{ t("TXT_CODE_notification_ui.statusDropped") }}</div>
            </div>
          </div>
          <div class="mt-12" data-test="status-last">
            <template v-if="status.last">
              <a-tag :color="status.last.ok ? 'success' : 'error'">
                {{
                  status.last.ok
                    ? t("TXT_CODE_notification_ui.lastOk")
                    : t("TXT_CODE_notification_ui.lastFailed")
                }}
              </a-tag>
              <span>
                {{ status.last.type }} · {{ formatTime(status.last.at) }}
                <template v-if="status.last.httpStatus">
                  · HTTP {{ status.last.httpStatus }}</template>
                <template v-if="status.last.error">
                  · {{ notificationErrorText(status.last.error) }}
                </template>
              </span>
            </template>
            <span v-else class="text-muted">{{ t("TXT_CODE_notification_ui.lastNone") }}</span>
          </div>
        </a-form-item>
      </a-form>
    </a-spin>
  </div>
</template>

<style lang="scss" scoped>
.content-box {
  padding: 16px;
  overflow-y: auto;
}

.notification-settings {
  word-break: normal;
  overflow-wrap: anywhere;
}

.notification-settings :deep(.ant-alert-message),
.notification-settings :deep(.ant-form-item-explain-error) {
  word-break: normal;
  overflow-wrap: anywhere;
}

.notification-form {
  text-align: left;
  max-width: 720px;
}

.row-flex {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.event-group {
  margin-top: 12px;
}

.event-group-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.event-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
}

.event-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.excluded-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  max-width: 480px;
}

.status-cell {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--color-gray-2);
  border: 1px solid var(--color-gray-4);
  text-align: center;
}

.status-num {
  font-size: 20px;
  font-weight: 600;
}

.text-muted {
  opacity: 0.65;
}

@media (max-width: 576px) {
  .status-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
