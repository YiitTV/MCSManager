<script setup lang="ts">
import { useCrashHistory } from "@/hooks/useCrashHistory";
import { t } from "@/lang/i18n";
import { parseTimestamp } from "@/tools/time";
import { toRef } from "vue";

const props = defineProps<{ daemonId: string; uuid: string; lastCrashAt?: number }>();
const { history, loading, failed } = useCrashHistory(
  props.daemonId,
  props.uuid,
  toRef(props, "lastCrashAt")
);
</script>

<template>
  <section class="crash-insights" :aria-label="t('TXT_CODE_crash.title')">
    <a-typography-title :level="5">{{ t("TXT_CODE_crash.title") }}</a-typography-title>
    <a-spin v-if="loading" size="small" />
    <a-alert v-else-if="failed" type="error" :message="t('TXT_CODE_crash.loadFailed')" />
    <a-typography-text v-else-if="!history.length" type="secondary">
      {{ t("TXT_CODE_crash.empty") }}
    </a-typography-text>
    <details v-for="(crash, index) in history" :key="`${crash.at}-${index}`" class="crash-entry">
      <summary>
        {{ parseTimestamp(crash.at) }} · {{ crash.exception || t("TXT_CODE_crash.badge") }}
      </summary>
      <div v-if="crash.message">{{ crash.message }}</div>
      <div v-if="crash.exitCode !== null">
        {{ t("TXT_CODE_crash.exitCode", { code: crash.exitCode }) }}
      </div>
      <div v-if="crash.plugin">{{ t("TXT_CODE_crash.plugin", { plugin: crash.plugin }) }}</div>
      <pre v-if="crash.frames.length">{{ crash.frames.join("\n") }}</pre>
    </details>
  </section>
</template>

<style scoped>
.crash-entry {
  overflow-wrap: anywhere;
  margin-bottom: 8px;
}

.crash-entry pre {
  white-space: pre-wrap;
}
</style>
