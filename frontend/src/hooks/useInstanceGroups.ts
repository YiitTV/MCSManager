import {
  cancelInstanceGroupRun,
  createInstanceGroup,
  deleteInstanceGroup,
  getInstanceGroupRun,
  listInstanceGroups,
  startInstanceGroup,
  stopInstanceGroup,
  updateInstanceGroup
} from "@/services/apis/instanceGroup";
import {
  isRunActive,
  type GroupRun,
  type InstanceGroupInput,
  type InstanceGroupView
} from "@/types/instanceGroup";
import { computed, onScopeDispose, ref } from "vue";

// A run is polled no more often than every 2 seconds, and only while it is active.
export const RUN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_FAILURES = 3;

export interface UseInstanceGroupsOptions {
  pollIntervalMs?: number;
  onRunFinished?: (group: InstanceGroupView | undefined, run: GroupRun) => void;
}

export function useInstanceGroups(options: UseInstanceGroupsOptions = {}) {
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? RUN_POLL_INTERVAL_MS, 2000);

  const groups = ref<InstanceGroupView[]>([]);
  const runs = ref<Record<string, GroupRun | null>>({});
  const isLoading = ref(false);

  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let disposed = false;
  const failures = new Map<string, number>();

  const activeGroupIds = computed(() =>
    Object.keys(runs.value).filter((id) => isRunActive(runs.value[id]))
  );

  const getRun = (groupId: string) => runs.value[groupId] ?? null;
  const isActive = (groupId: string) => isRunActive(runs.value[groupId]);

  const stopPolling = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const ensurePolling = () => {
    if (disposed) return;
    if (activeGroupIds.value.length === 0) return stopPolling();
    if (timer === undefined) timer = setInterval(() => void tick(), pollIntervalMs);
  };

  const fetchGroups = async () => {
    const state = await listInstanceGroups().execute({ forceRequest: true });
    if (disposed) return;
    groups.value = state.value ?? [];
  };

  // Fetch one run. The run is also reported as finished here, on its first terminal state.
  const refreshRun = async (groupId: string) => {
    const previous = runs.value[groupId];
    try {
      const state = await getInstanceGroupRun().execute({
        params: { id: groupId },
        forceRequest: true
      });
      if (disposed) return;
      failures.delete(groupId);
      const run = state.value?.run ?? null;
      runs.value = { ...runs.value, [groupId]: run };
      if (run && isRunActive(previous) && !isRunActive(run)) {
        await fetchGroups().catch(() => undefined);
        options.onRunFinished?.(
          groups.value.find((g) => g.uuid === groupId),
          run
        );
      } else if (run && isRunActive(run) && progressOf(previous) !== progressOf(run)) {
        // A step changed: refresh the member statuses once.
        await fetchGroups().catch(() => undefined);
      }
    } catch (error) {
      if (disposed) return;
      const count = (failures.get(groupId) ?? 0) + 1;
      failures.set(groupId, count);
      if (count >= MAX_POLL_FAILURES) {
        failures.delete(groupId);
        runs.value = { ...runs.value, [groupId]: null };
      }
    }
  };

  const tick = async () => {
    if (ticking || disposed) return;
    ticking = true;
    try {
      for (const id of [...activeGroupIds.value]) {
        await refreshRun(id);
      }
    } finally {
      ticking = false;
      ensurePolling();
    }
  };

  // Load the groups and restore runs that are still active (for example after a page reload).
  // The list already carries each group's active or latest run, so no per-group request is made.
  const load = async () => {
    isLoading.value = true;
    try {
      await fetchGroups();
      if (disposed) return;
      const next: Record<string, GroupRun | null> = {};
      for (const g of groups.value) next[g.uuid] = g.run ?? null;
      for (const id of Object.keys(runs.value)) if (!(id in next)) failures.delete(id);
      runs.value = next;
      ensurePolling();
    } finally {
      isLoading.value = false;
    }
  };

  const saveGroup = async (groupId: string | undefined, input: InstanceGroupInput) => {
    if (groupId) {
      await updateInstanceGroup().execute({
        params: { id: groupId },
        data: input,
        forceRequest: true
      });
    } else {
      await createInstanceGroup().execute({ data: input, forceRequest: true });
    }
    await fetchGroups();
  };

  const removeGroup = async (groupId: string) => {
    await deleteInstanceGroup().execute({ params: { id: groupId }, forceRequest: true });
    const rest = { ...runs.value };
    delete rest[groupId];
    runs.value = rest;
    await fetchGroups();
  };

  const beginRun = async (api: typeof startInstanceGroup, groupId: string) => {
    await api().execute({ params: { id: groupId }, forceRequest: true });
    await refreshRunAfterStart(groupId);
  };

  const refreshRunAfterStart = async (groupId: string) => {
    const state = await getInstanceGroupRun().execute({
      params: { id: groupId },
      forceRequest: true
    });
    if (disposed) return;
    runs.value = { ...runs.value, [groupId]: state.value?.run ?? null };
    ensurePolling();
  };

  const startGroup = (groupId: string) => beginRun(startInstanceGroup, groupId);
  const stopGroup = (groupId: string) => beginRun(stopInstanceGroup, groupId);

  const cancelGroup = async (groupId: string) => {
    const state = await cancelInstanceGroupRun().execute({
      params: { id: groupId },
      forceRequest: true
    });
    if (disposed) return;
    // The cancel response already carries the final run state.
    runs.value = { ...runs.value, [groupId]: state.value?.run ?? null };
    ensurePolling();
  };

  onScopeDispose(() => {
    disposed = true;
    stopPolling();
  });

  return {
    groups,
    runs,
    isLoading,
    activeGroupIds,
    getRun,
    isActive,
    load,
    refresh: fetchGroups,
    saveGroup,
    removeGroup,
    startGroup,
    stopGroup,
    cancelGroup
  };
}

function progressOf(run: GroupRun | null | undefined): string {
  return run ? run.steps.map((s) => s.state).join(",") : "";
}
