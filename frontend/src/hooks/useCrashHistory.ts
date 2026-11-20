import { getInstanceCrashHistory } from "@/services/apis/instance";
import type { InstanceCrashSummary } from "@/types";
import { ref, watch, type Ref } from "vue";

export function useCrashHistory(
  daemonId: string,
  uuid: string,
  lastCrashAt: Ref<number | undefined>
) {
  const history = ref<InstanceCrashSummary[]>([]);
  const loading = ref(false);
  const failed = ref(false);

  watch(
    lastCrashAt,
    async (at, _, onCleanup) => {
      if (!at) return;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      loading.value = true;
      failed.value = false;
      try {
        const result = await getInstanceCrashHistory().execute({
          params: { uuid, daemonId },
          forceRequest: true,
          signal: controller.signal,
          timeout: 30_000
        });
        if (!controller.signal.aborted) history.value = result.value ?? [];
      } catch {
        if (!controller.signal.aborted) failed.value = true;
      } finally {
        if (!controller.signal.aborted) loading.value = false;
      }
    },
    { immediate: true }
  );

  return { history, loading, failed };
}
