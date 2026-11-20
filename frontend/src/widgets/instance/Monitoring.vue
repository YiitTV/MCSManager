<script setup lang="ts">
import { monitoringSeries, useInstanceMonitoring } from "@/hooks/useInstanceMonitoring";
import { t } from "@/lang/i18n";
import { formatMemoryUsage } from "@/tools/memory";
import { computed, defineAsyncComponent, ref, watchPostEffect } from "vue";

const MonitoringChart = defineAsyncComponent(() => import("./MonitoringChart.vue"));
const props = defineProps<{
  instanceId?: string;
  daemonId?: string;
  compact?: boolean;
}>();

const { data, unavailable } = useInstanceMonitoring(() => ({
  instanceId: props.instanceId,
  daemonId: props.daemonId,
  compact: props.compact
}));
const current = computed(() => data.value?.current);
const hasHistory = computed(
  () =>
    data.value?.history.some((sample) =>
      [sample.ramBytes, sample.cpuPercent, sample.tps, sample.mspt].some((value) => value !== null)
    )
);
const canvas = ref<HTMLCanvasElement>();

watchPostEffect(() => {
  const element = canvas.value;
  if (!element || !data.value) return;
  const points = monitoringSeries(data.value.history, "ramBytes");
  const ctx = element.getContext("2d");
  if (!ctx || points.length === 0) return;

  const { width, height } = element;
  const end = Math.max(Date.now(), points[points.length - 1][0]);
  const range = 60 * 60_000;
  const maximum = Math.max(1, ...points.map(([, value]) => value ?? 0));
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#3584e4";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let connected = false;
  for (const [timestamp, value] of points) {
    if (value === null) {
      connected = false;
      continue;
    }
    const x = 2 + ((range + timestamp - end) / range) * (width - 4);
    const y = height - 3 - (value / maximum) * (height - 6);
    if (connected) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    ctx.fillRect(x - 1, y - 1, 2, 2);
    connected = true;
  }
  ctx.stroke();
});
</script>

<template>
  <section v-if="hasHistory || !compact" class="instance-monitoring">
    <div v-if="current" class="metrics">
      <span v-if="current.ramBytes !== null">
        RAM {{ formatMemoryUsage(current.ramBytes, data?.memoryLimitBytes ?? undefined) }}
      </span>
      <span v-if="current.cpuPercent !== null"> CPU {{ current.cpuPercent.toFixed(1) }}% </span>
      <span v-if="current.tps !== null">TPS {{ current.tps.toFixed(1) }}</span>
      <span v-if="!compact && current.mspt !== null">MSPT {{ current.mspt.toFixed(1) }}</span>
      <a-tag v-if="data?.warnings.memory" color="red" class="warning">
        {{ t("TXT_CODE_instance_monitoring.memoryWarning") }}
      </a-tag>
      <a-tag v-if="data?.warnings.tps" color="red" class="warning">
        {{ t("TXT_CODE_instance_monitoring.tpsWarning") }}
      </a-tag>
    </div>
    <canvas
      v-if="compact && data?.history.some((sample) => sample.ramBytes !== null)"
      ref="canvas"
      class="sparkline"
      width="300"
      height="30"
      role="img"
      :aria-label="t('TXT_CODE_instance_monitoring.sparkline')"
      :title="t('TXT_CODE_instance_monitoring.sparkline')"
    />
    <template v-if="!compact">
      <MonitoringChart v-if="data && hasHistory" :samples="data.history" />
      <p v-else-if="unavailable">{{ t("TXT_CODE_instance_monitoring.unavailable") }}</p>
      <p v-else-if="data">{{ t("TXT_CODE_instance_monitoring.noSamples") }}</p>
      <a-spin v-else size="small" />
    </template>
  </section>
  <slot v-else />
</template>

<style scoped>
.instance-monitoring {
  margin-block: 8px;
}

.metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-variant-numeric: tabular-nums;
}

.warning {
  margin: 0;
}

.sparkline {
  display: block;
  width: 100%;
  height: 20px;
  margin-block: 4px;
  border-bottom: 1px solid var(--card-border-color);
}
</style>
