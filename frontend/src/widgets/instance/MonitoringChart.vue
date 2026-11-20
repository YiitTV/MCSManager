<script setup lang="ts">
import { monitoringSeries, type MonitoringMetric } from "@/hooks/useInstanceMonitoring";
import { t } from "@/lang/i18n";
import { useResizeObserver } from "@vueuse/core";
import { init, type EChartsOption, type ECharts } from "echarts";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { InstanceMonitoringSample } from "../../../../common/src/instance_monitoring";

const props = defineProps<{ samples: InstanceMonitoringSample[] }>();
const root = ref<HTMLDivElement>();
let chart: ECharts | undefined;

const metrics: { key: MonitoringMetric; color: string; label: () => string; scale: number }[] = [
  {
    key: "ramBytes",
    color: "#3584e4",
    label: () => t("TXT_CODE_instance_monitoring.ramMib"),
    scale: 1024 ** 2
  },
  {
    key: "cpuPercent",
    color: "#078b83",
    label: () => t("TXT_CODE_instance_monitoring.cpuPercent"),
    scale: 1
  },
  { key: "tps", color: "#a45acd", label: () => "TPS", scale: 1 },
  { key: "mspt", color: "#c97122", label: () => "MSPT", scale: 1 }
];

function renderChart() {
  const selected = metrics.filter(({ key }) =>
    props.samples.some((sample) => sample[key] !== null)
  );
  const end = Date.now();
  const axisLabels = { color: "#8492a6" };
  const option: EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis", confine: true },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: selected.map((_, index) => ({ left: 58, right: 15, top: index * 92 + 24, height: 58 })),
    xAxis: selected.map((_, index) => ({
      type: "time",
      gridIndex: index,
      min: end - 24 * 60 * 60_000,
      max: end,
      axisLabel: { ...axisLabels, show: index === selected.length - 1 },
      axisTick: { show: false }
    })),
    yAxis: selected.map(({ label }, index) => ({
      type: "value",
      gridIndex: index,
      min: 0,
      name: label(),
      nameGap: 5,
      nameTextStyle: axisLabels,
      axisLabel: axisLabels,
      splitNumber: 2,
      splitLine: { lineStyle: { opacity: 0.2 } }
    })),
    series: selected.map(({ key, label, color, scale }, index) => ({
      name: label(),
      type: "line",
      xAxisIndex: index,
      yAxisIndex: index,
      showSymbol: props.samples.filter((sample) => sample[key] !== null).length === 1,
      symbolSize: 5,
      itemStyle: { color },
      lineStyle: { width: 1.5 },
      data: monitoringSeries(props.samples, key).map(([timestamp, value]) => [
        timestamp,
        value === null ? null : Math.round((value / scale) * 10) / 10
      ])
    }))
  };
  if (!chart || !root.value) return;
  root.value.style.height = `${Math.max(1, selected.length) * 92 + 14}px`;
  chart.resize();
  chart.setOption(option, true);
}

onMounted(() => {
  if (!root.value) return;
  chart = init(root.value);
  renderChart();
});
watch(() => props.samples, renderChart);
useResizeObserver(root, () => chart?.resize());
onBeforeUnmount(() => chart?.dispose());
</script>

<template>
  <div
    ref="root"
    class="monitoring-chart"
    role="img"
    :aria-label="t('TXT_CODE_instance_monitoring.title')"
  />
</template>

<style scoped>
.monitoring-chart {
  width: 100%;
  height: 106px;
}
</style>
