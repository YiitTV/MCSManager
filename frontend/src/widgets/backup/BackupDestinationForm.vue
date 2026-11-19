<script setup lang="ts">
import {
  createDestinationFormState,
  destinationFormToPayload,
  destinationToFormState,
  validateDestinationForm
} from "@/hooks/useBackupDestinationForm";
import { t } from "@/lang/i18n";
import { BACKUP_LIMITS, type BackupDestination, type BackupTestResult } from "@/types/backup";
import { computed, reactive, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  destination?: BackupDestination;
  saving?: boolean;
  testing?: boolean;
  testResult?: BackupTestResult;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", payload: BackupDestination): void;
  (e: "test", payload: BackupDestination): void;
  (e: "connect", payload: BackupDestination): void;
}>();

const form = reactive(
  props.destination ? destinationToFormState(props.destination) : createDestinationFormState()
);
const touched = ref(false);

watch(
  () => [props.open, props.destination] as const,
  ([open]) => {
    if (!open) return;
    touched.value = false;
    Object.assign(
      form,
      props.destination ? destinationToFormState(props.destination) : createDestinationFormState()
    );
  }
);

const errors = computed(() => validateDestinationForm(form));
const err = (field: string) => (touched.value ? errors.value[field] : undefined);
const isEdit = computed(() => !!props.destination);
const redirectUri = computed(
  () => `${form.redirectBaseUrl.replace(/\/+$/, "")}/api/backup/gdrive/callback`
);
const connected = computed(() => form.hasSecret.refreshToken || !!form.connectedEmail);

const typeOptions = computed(() => [
  { value: "local", label: t("TXT_CODE_backup_ui.type_local") },
  { value: "s3", label: t("TXT_CODE_backup_ui.type_s3") },
  { value: "gdrive", label: t("TXT_CODE_backup_ui.type_gdrive") }
]);

const onSave = () => {
  touched.value = true;
  if (Object.keys(errors.value).length > 0) return;
  emit("save", destinationFormToPayload(form));
};
const onTest = () => {
  touched.value = true;
  if (Object.keys(errors.value).length > 0) return;
  emit("test", destinationFormToPayload(form));
};
const onConnect = () => {
  touched.value = true;
  if (Object.keys(errors.value).length > 0) return;
  emit("connect", destinationFormToPayload(form));
};

const readServiceAccountFile = (file: File) => {
  const reader = new FileReader();
  reader.onload = () => {
    form.secretInputs.serviceAccountJson = String(reader.result ?? "").trim();
  };
  reader.readAsText(file);
  return false; // never upload anywhere
};

const secretPlaceholder = (stored: boolean) =>
  stored ? t("TXT_CODE_backup_ui.secretKeep") : t("TXT_CODE_backup_ui.secretEnter");
</script>

<template>
  <a-modal
    :open="open"
    :title="
      isEdit ? t('TXT_CODE_backup_ui.editDestination') : t('TXT_CODE_backup_ui.newDestination')
    "
    :width="640"
    data-test="destination-form"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('TXT_CODE_backup_ui.destType')">
        <a-select
          v-model:value="form.type"
          :options="typeOptions"
          :disabled="isEdit"
          data-test="dest-type"
        />
      </a-form-item>
      <a-form-item
        :label="t('TXT_CODE_backup_ui.destName')"
        :validate-status="err('name') ? 'error' : ''"
        :help="err('name')"
      >
        <a-input
          v-model:value="form.name"
          :maxlength="BACKUP_LIMITS.MAX_NAME_LENGTH"
          data-test="dest-name"
        />
      </a-form-item>

      <template v-if="form.type === 'local'">
        <a-form-item
          :label="t('TXT_CODE_backup_ui.directory')"
          :extra="t('TXT_CODE_backup_ui.directoryHelp')"
          :validate-status="err('directory') ? 'error' : ''"
          :help="err('directory')"
        >
          <a-input
            v-model:value="form.directory"
            placeholder="/var/backups/mcsm"
            data-test="dest-directory"
          />
        </a-form-item>
        <a-form-item
          :label="t('TXT_CODE_backup_ui.maxSize')"
          :validate-status="err('maxTotalGb') ? 'error' : ''"
          :help="err('maxTotalGb')"
        >
          <a-input-number v-model:value="form.maxTotalGb" :min="1" addon-after="GB" />
        </a-form-item>
      </template>

      <template v-else-if="form.type === 's3'">
        <a-form-item
          :label="t('TXT_CODE_backup_ui.endpoint')"
          :validate-status="err('endpoint') ? 'error' : ''"
          :help="err('endpoint')"
        >
          <a-input
            v-model:value="form.endpoint"
            placeholder="https://s3.example.com"
            data-test="s3-endpoint"
          />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item
              :label="t('TXT_CODE_backup_ui.region')"
              :validate-status="err('region') ? 'error' : ''"
              :help="err('region')"
            >
              <a-input v-model:value="form.region" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item
              :label="t('TXT_CODE_backup_ui.bucket')"
              :validate-status="err('bucket') ? 'error' : ''"
              :help="err('bucket')"
            >
              <a-input v-model:value="form.bucket" data-test="s3-bucket" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item
          :label="t('TXT_CODE_backup_ui.prefix')"
          :validate-status="err('prefix') ? 'error' : ''"
          :help="err('prefix')"
        >
          <a-input v-model:value="form.prefix" placeholder="mcsm/" />
        </a-form-item>
        <a-form-item>
          <a-switch v-model:checked="form.pathStyle" data-test="s3-pathstyle" />
          <span class="ml-8">{{ t("TXT_CODE_backup_ui.pathStyle") }}</span>
        </a-form-item>
        <a-form-item>
          <a-switch v-model:checked="form.allowPrivateNetwork" data-test="s3-private" />
          <span class="ml-8">{{ t("TXT_CODE_backup_ui.allowPrivate") }}</span>
          <a-alert
            v-if="form.allowPrivateNetwork"
            class="mt-8"
            type="warning"
            show-icon
            :message="t('TXT_CODE_backup_ui.allowPrivateWarning')"
            data-test="s3-private-warning"
          />
        </a-form-item>
        <a-form-item
          :label="t('TXT_CODE_backup_ui.accessKey')"
          :validate-status="err('accessKeyId') ? 'error' : ''"
          :help="err('accessKeyId')"
        >
          <a-input v-model:value="form.accessKeyId" autocomplete="off" data-test="s3-access-key" />
        </a-form-item>
        <a-form-item
          :label="t('TXT_CODE_backup_ui.secretKey')"
          :validate-status="err('secretAccessKey') ? 'error' : ''"
          :help="err('secretAccessKey')"
        >
          <a-input-password
            v-model:value="form.secretInputs.secretAccessKey"
            autocomplete="new-password"
            :placeholder="secretPlaceholder(form.hasSecret.secretAccessKey)"
            data-test="s3-secret"
          />
        </a-form-item>
      </template>

      <template v-else>
        <a-form-item :label="t('TXT_CODE_backup_ui.authMethod')">
          <a-radio-group v-model:value="form.authMethod" data-test="gdrive-auth">
            <a-radio value="oauth">{{ t("TXT_CODE_backup_ui.authOauth") }}</a-radio>
            <a-radio value="service_account">
              {{
                t("TXT_CODE_backup_ui.authServiceAccount")
              }}
            </a-radio>
          </a-radio-group>
        </a-form-item>

        <template v-if="form.authMethod === 'oauth'">
          <a-alert
            class="mb-16"
            type="info"
            show-icon
            :message="t('TXT_CODE_backup_ui.oauthTestingNote')"
          />
          <a-form-item
            :label="t('TXT_CODE_backup_ui.clientId')"
            :validate-status="err('clientId') ? 'error' : ''"
            :help="err('clientId')"
          >
            <a-input v-model:value="form.clientId" data-test="gdrive-client-id" />
          </a-form-item>
          <a-form-item
            :label="t('TXT_CODE_backup_ui.clientSecret')"
            :validate-status="err('clientSecret') ? 'error' : ''"
            :help="err('clientSecret')"
          >
            <a-input-password
              v-model:value="form.secretInputs.clientSecret"
              autocomplete="new-password"
              :placeholder="secretPlaceholder(form.hasSecret.clientSecret)"
              data-test="gdrive-client-secret"
            />
          </a-form-item>
          <a-form-item
            :label="t('TXT_CODE_backup_ui.panelUrl')"
            :validate-status="err('redirectBaseUrl') ? 'error' : ''"
            :help="err('redirectBaseUrl')"
          >
            <a-input
              v-model:value="form.redirectBaseUrl"
              placeholder="https://panel.example.com"
              data-test="gdrive-panel-url"
            />
          </a-form-item>
          <a-form-item
            :label="t('TXT_CODE_backup_ui.redirectUri')"
            :extra="t('TXT_CODE_backup_ui.redirectUriHelp')"
          >
            <a-input :value="redirectUri" readonly />
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_backup_ui.connectStatus')">
            <a-tag :color="connected ? 'success' : 'default'" data-test="gdrive-status">
              {{
                connected
                  ? t("TXT_CODE_backup_ui.connected", { account: form.connectedEmail || "Google" })
                  : t("TXT_CODE_backup_ui.notConnected")
              }}
            </a-tag>
            <a-button class="ml-8" data-test="gdrive-connect" @click="onConnect">
              {{ t("TXT_CODE_backup_ui.connectGoogle") }}
            </a-button>
          </a-form-item>
        </template>

        <template v-else>
          <a-form-item
            :label="t('TXT_CODE_backup_ui.serviceAccountJson')"
            :extra="t('TXT_CODE_backup_ui.serviceAccountHelp')"
            :validate-status="err('serviceAccountJson') ? 'error' : ''"
            :help="err('serviceAccountJson')"
          >
            <a-textarea
              v-model:value="form.secretInputs.serviceAccountJson"
              class="masked-textarea"
              :rows="4"
              autocomplete="off"
              :placeholder="secretPlaceholder(form.hasSecret.serviceAccountJson)"
              data-test="gdrive-sa-json"
            />
            <a-upload
              :before-upload="readServiceAccountFile"
              :show-upload-list="false"
              accept=".json"
            >
              <a-button class="mt-8" size="small">
                {{
                  t("TXT_CODE_backup_ui.uploadJson")
                }}
              </a-button>
            </a-upload>
          </a-form-item>
        </template>

        <a-form-item
          :label="t('TXT_CODE_backup_ui.folderId')"
          :extra="
            form.authMethod === 'oauth'
              ? t('TXT_CODE_backup_ui.folderIdOauthHint')
              : t('TXT_CODE_backup_ui.folderIdSaHint')
          "
          :validate-status="err('folderId') ? 'error' : ''"
          :help="err('folderId')"
        >
          <a-input v-model:value="form.folderId" data-test="gdrive-folder" />
        </a-form-item>
      </template>

      <a-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        show-icon
        :message="
          testResult.ok ? t('TXT_CODE_backup_ui.testOk') : t('TXT_CODE_backup_ui.testFailed')
        "
        :description="testResult.ok ? undefined : testResult.error"
        data-test="test-result"
      />
    </a-form>
    <template #footer>
      <a-button @click="emit('update:open', false)">{{ t("TXT_CODE_backup_ui.cancel") }}</a-button>
      <a-button :loading="testing" data-test="test-btn" @click="onTest">
        {{ t("TXT_CODE_backup_ui.testConnection") }}
      </a-button>
      <a-button type="primary" :loading="saving" data-test="save-btn" @click="onSave">
        {{ t("TXT_CODE_backup_ui.save") }}
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.masked-textarea {
  -webkit-text-security: disc;
  font-family: monospace;
}
</style>
