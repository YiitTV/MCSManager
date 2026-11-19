import { t } from "@/lang/i18n";
import {
  NOTIFICATION_SECRET_PLACEHOLDER,
  getNotificationConfig,
  putNotificationConfig,
  rotateNotificationSecret,
  testNotification,
  type NotificationConfig,
  type NotificationConfigResponse,
  type NotificationStatus,
  type NotificationTestResult
} from "@/services/apis/notification";
import { computed, ref } from "vue";

export const MAX_EXCLUDED_INSTANCES = 200;
export const MAX_URL_LENGTH = 512;
export const MAX_PANEL_NAME_LENGTH = 40;

const TEST_ERROR_CODES = [
  "not_configured",
  "rate_limited",
  "timeout",
  "dns",
  "blocked_address",
  "invalid_url",
  "tls",
  "redirect",
  "http_4xx",
  "http_5xx",
  "network"
];

/** Translate a backend delivery error code; unknown codes fall back to a generic message. */
export function notificationErrorText(code?: string | number): string {
  const key = String(code ?? "");
  if (TEST_ERROR_CODES.includes(key)) return t(`TXT_CODE_notification_ui.err_${key}`);
  return t("TXT_CODE_notification_ui.err_unknown");
}

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];
const WEBHOOK_PATH = /^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;

export type UrlProblem = "required" | "format" | "webhook" | "https" | "tooLong" | "";

export function emptyConfig(): NotificationConfig {
  return {
    enabled: false,
    sinkType: "bot_http",
    url: "",
    secret: "",
    allowPrivateAddress: false,
    panelName: "Minefield Panel",
    events: {},
    excludedInstances: []
  };
}

/** Pure URL validation mirroring the backend rules (the backend stays authoritative). */
export function checkNotificationUrl(
  url: string,
  sinkType: NotificationConfig["sinkType"],
  allowPrivateAddress: boolean,
  enabled: boolean
): UrlProblem {
  const value = url.trim();
  if (!value) return enabled ? "required" : "";
  if (value === NOTIFICATION_SECRET_PLACEHOLDER) return "";
  if (value.length > MAX_URL_LENGTH) return "tooLong";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "format";
  }
  if (parsed.username || parsed.password) return "format";
  if (sinkType === "discord_webhook") {
    const hostOk = DISCORD_HOSTS.includes(parsed.hostname.toLowerCase());
    if (parsed.protocol !== "https:" || !hostOk || !WEBHOOK_PATH.test(parsed.pathname)) {
      return "webhook";
    }
    return "";
  }
  if (parsed.protocol === "https:") return "";
  if (parsed.protocol === "http:" && allowPrivateAddress) return "";
  return "https";
}

export function useNotificationSettings() {
  const form = ref<NotificationConfig>(emptyConfig());
  const saved = ref<string>(JSON.stringify(emptyConfig()));
  const status = ref<NotificationStatus>({ queued: 0, sent: 0, failed: 0, dropped: 0 });
  const loading = ref(false);
  const loaded = ref(false);
  const saving = ref(false);
  const rotating = ref(false);
  const testing = ref(false);
  const refreshing = ref(false);
  /** Plaintext secret from the latest rotation; shown once, then discarded by the UI. */
  const revealedSecret = ref("");
  const testResult = ref<NotificationTestResult | null>(null);

  const apply = (res: NotificationConfigResponse) => {
    const { status: newStatus, ...config } = res;
    form.value = {
      ...emptyConfig(),
      ...config,
      events: { ...(config.events ?? {}) },
      excludedInstances: [...(config.excludedInstances ?? [])]
    };
    saved.value = JSON.stringify(form.value);
    if (newStatus) status.value = newStatus;
  };

  const urlProblem = computed(() =>
    checkNotificationUrl(
      form.value.url,
      form.value.sinkType,
      form.value.allowPrivateAddress,
      form.value.enabled
    )
  );
  const urlProblemText = computed(() => {
    switch (urlProblem.value) {
      case "required":
        return t("TXT_CODE_notification_ui.urlRequired");
      case "webhook":
        return t("TXT_CODE_notification_ui.urlWebhookFormat");
      case "https":
        return t("TXT_CODE_notification_ui.urlHttps");
      case "tooLong":
        return t("TXT_CODE_notification_ui.urlTooLong", { max: MAX_URL_LENGTH });
      case "format":
        return t("TXT_CODE_notification_ui.urlFormat");
      default:
        return "";
    }
  });
  const tooManyExcluded = computed(
    () => form.value.excludedInstances.length > MAX_EXCLUDED_INSTANCES
  );
  const secretIsSet = computed(() => form.value.secret === NOTIFICATION_SECRET_PLACEHOLDER);
  const urlIsMasked = computed(() => form.value.url === NOTIFICATION_SECRET_PLACEHOLDER);
  const dirty = computed(() => JSON.stringify(form.value) !== saved.value);
  const panelNameValid = computed(() => {
    const len = form.value.panelName.trim().length;
    return len >= 1 && len <= MAX_PANEL_NAME_LENGTH;
  });
  const canSave = computed(
    () => !saving.value && !urlProblem.value && !tooManyExcluded.value && panelNameValid.value
  );
  const canTest = computed(
    () => !testing.value && !saving.value && !dirty.value && !!form.value.url && loaded.value
  );

  const load = async () => {
    loading.value = true;
    try {
      const res = (await getNotificationConfig().execute()).value;
      if (res) apply(res);
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  };

  /** Re-read only the delivery counters; never touches unsaved form edits. */
  const refreshStatus = async () => {
    refreshing.value = true;
    try {
      const res = (await getNotificationConfig().execute()).value;
      if (res?.status) status.value = res.status;
    } finally {
      refreshing.value = false;
    }
  };

  const save = async () => {
    if (!canSave.value) return false;
    saving.value = true;
    try {
      // Masked placeholders are sent back unchanged so the backend keeps the stored values.
      const res = (await putNotificationConfig().execute({ data: { ...form.value } })).value;
      if (res) apply(res);
      testResult.value = null;
      return true;
    } finally {
      saving.value = false;
    }
  };

  const rotate = async () => {
    rotating.value = true;
    try {
      const res = (await rotateNotificationSecret().execute()).value;
      if (!res?.secret) return false;
      revealedSecret.value = res.secret;
      // The server stores the new secret immediately; keep the form (and its baseline) masked.
      form.value.secret = NOTIFICATION_SECRET_PLACEHOLDER;
      const baseline = JSON.parse(saved.value) as NotificationConfig;
      baseline.secret = NOTIFICATION_SECRET_PLACEHOLDER;
      saved.value = JSON.stringify(baseline);
      return true;
    } finally {
      rotating.value = false;
    }
  };

  const dismissRevealedSecret = () => {
    revealedSecret.value = "";
  };

  const test = async () => {
    if (!canTest.value) return;
    testing.value = true;
    testResult.value = null;
    try {
      testResult.value = (await testNotification().execute()).value ?? {
        ok: false,
        error: "no_response"
      };
    } catch (err: any) {
      testResult.value = { ok: false, error: String(err?.message ?? err ?? "error") };
    } finally {
      testing.value = false;
    }
    await refreshStatus().catch(() => undefined);
  };

  const setSinkType = (sinkType: NotificationConfig["sinkType"]) => {
    if (form.value.sinkType === sinkType) return;
    form.value.sinkType = sinkType;
    // A masked URL belongs to the previous sink type; make the admin enter a fresh one.
    if (urlIsMasked.value) form.value.url = "";
  };

  return {
    form,
    status,
    loading,
    loaded,
    saving,
    rotating,
    testing,
    refreshing,
    revealedSecret,
    testResult,
    urlProblem,
    urlProblemText,
    tooManyExcluded,
    panelNameValid,
    secretIsSet,
    urlIsMasked,
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
  };
}
