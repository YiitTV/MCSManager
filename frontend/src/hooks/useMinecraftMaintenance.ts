import {
  getMaintenanceState,
  submitMaintenanceAction,
  type MaintenanceOperation,
  type MaintenanceState
} from "@/services/apis/minecraftOperations";
import type { GroupMemberRef } from "@/types/instanceGroup";
import { ref, watch } from "vue";

export function useMinecraftMaintenance(target: () => GroupMemberRef, running: () => boolean) {
  const open = ref(false);
  const state = ref<MaintenanceState>();
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<"unavailable" | "unconfirmed">();
  const player = ref("");
  const { execute: read } = getMaintenanceState();
  const { execute: write } = submitMaintenanceAction();
  let controller: AbortController;

  async function refresh() {
    if (loading.value || saving.value) return;
    const { daemonId, instanceUuid: uuid } = target();
    const { signal } = controller;
    loading.value = true;
    error.value = undefined;
    try {
      const response = await read({ params: { daemonId, uuid }, forceRequest: true, signal });
      if (!signal.aborted) state.value = response.value;
    } catch {
      if (!signal.aborted) {
        state.value = undefined;
        error.value = "unavailable";
      }
    } finally {
      if (!signal.aborted) loading.value = false;
    }
  }

  watch(
    [() => target().daemonId, () => target().instanceUuid, running],
    (_, __, onCleanup) => {
      controller = new AbortController();
      const current = controller;
      state.value = undefined;
      loading.value = false;
      saving.value = false;
      onCleanup(() => current.abort());
      void refresh();
    },
    { immediate: true }
  );

  function showAllowlist() {
    open.value = true;
    void refresh();
  }

  async function submit(data: MaintenanceOperation) {
    if (saving.value || loading.value || state.value?.status !== "ready" || !state.value.running)
      return;
    const { daemonId, instanceUuid: uuid } = target();
    const { signal } = controller;
    saving.value = true;
    error.value = undefined;
    try {
      const response = await write({
        params: { daemonId, uuid },
        data,
        forceRequest: true,
        signal
      });
      if (!signal.aborted && response.value) {
        state.value = response.value;
        if (!response.value.confirmed) error.value = "unconfirmed";
        if (response.value.confirmed && data.action === "add") player.value = "";
      }
    } catch {
      if (!signal.aborted) error.value = "unavailable";
    } finally {
      if (!signal.aborted) saving.value = false;
    }
  }

  return { open, player, state, loading, saving, error, refresh, showAllowlist, submit };
}
