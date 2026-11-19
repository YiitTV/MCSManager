import { remoteInstances, remoteInstancesGlobal, userInfoApi } from "@/services/apis";
import { getInstanceInfo } from "@/services/apis/instance";
import { sleep } from "@/tools/common";
import type { InstanceDetail } from "@/types";
import { memberKey, type GroupMemberRef } from "@/types/instanceGroup";
import { onScopeDispose, ref, shallowRef } from "vue";

export interface BoardInstance extends GroupMemberRef {
  detail: InstanceDetail;
}

const PAGE_SIZE = 50;
const DETAIL_BATCH_SIZE = 4;
const DETAIL_BATCH_INTERVAL_MS = 1000;

export function useInstanceBoardInventory() {
  const instances = shallowRef(new Map<string, BoardInstance>());
  const loading = ref(false);
  const controller = new AbortController();
  const request = { forceRequest: true, signal: controller.signal, timeout: 30_000 };
  onScopeDispose(() => controller.abort());
  let detailQueue = Promise.resolve();
  let nextDetailBatchAt = 0;

  const loadAdminInstances = async () => {
    const result = await remoteInstancesGlobal().execute({
      ...request,
      params: { page: 1, page_size: PAGE_SIZE }
    });
    const entries: BoardInstance[] = [];
    for (const [daemonId, firstPage] of Object.entries(result.value ?? {})) {
      entries.push(
        ...firstPage.instances.map((detail) => ({
          daemonId,
          instanceUuid: detail.instanceUuid,
          detail
        }))
      );
      const { execute } = remoteInstances();
      for (let page = firstPage.page + 1; page <= firstPage.maxPage; page++) {
        const next = await execute({
          ...request,
          params: { daemonId, page, page_size: PAGE_SIZE }
        });
        for (const detail of next.value?.data ?? []) {
          entries.push({ daemonId, instanceUuid: detail.instanceUuid, detail });
        }
      }
    }
    return entries;
  };

  const loadInstance = async (member: GroupMemberRef): Promise<BoardInstance | undefined> => {
    try {
      const result = await getInstanceInfo().execute({
        ...request,
        params: { daemonId: member.daemonId, uuid: member.instanceUuid }
      });
      const detail = result.value;
      if (detail?.instanceUuid === member.instanceUuid && detail.config) {
        return { daemonId: member.daemonId, instanceUuid: member.instanceUuid, detail };
      }
    } catch {
      // One unavailable or revoked assignment must not suppress other cards.
    }
  };

  const loadDetails = async (members: GroupMemberRef[]) => {
    const entries: BoardInstance[] = [];
    for (
      let index = 0;
      index < members.length && !controller.signal.aborted;
      index += DETAIL_BATCH_SIZE
    ) {
      const batch = members.slice(index, index + DETAIL_BATCH_SIZE);
      // Instance detail is rate-limited. Leave room for group polling and user actions.
      const fetching = detailQueue.then(async () => {
        if (controller.signal.aborted) return [];
        const delay = nextDetailBatchAt - Date.now();
        if (delay > 0) await sleep(delay);
        if (controller.signal.aborted) return [];
        nextDetailBatchAt = Date.now() + DETAIL_BATCH_INTERVAL_MS;
        return Promise.all(batch.map(loadInstance));
      });
      detailQueue = fetching.then(() => undefined);
      for (const instance of await fetching) {
        if (instance) entries.push(instance);
      }
    }
    return entries;
  };

  const loadAssignedInstances = async () => {
    const user = await userInfoApi().execute(request);
    const assigned = user.value?.instances ?? [];
    const deduplicated = new Map(assigned.map((member) => [memberKey(member), member]));
    return loadDetails([...deduplicated.values()]);
  };

  const loadInventory = async (isAdmin: boolean) => {
    if (loading.value) return;
    loading.value = true;
    try {
      const entries = await (isAdmin ? loadAdminInstances() : loadAssignedInstances());
      if (!controller.signal.aborted) {
        instances.value = new Map(entries.map((instance) => [memberKey(instance), instance]));
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      loading.value = false;
    }
  };

  const refreshInstances = async (members: GroupMemberRef[]) => {
    if (!members.length) return;
    const updated = await loadDetails(members);
    if (controller.signal.aborted) return;
    const next = new Map(instances.value);
    const updates = new Map(updated.map((instance) => [memberKey(instance), instance]));
    for (const member of members) {
      const key = memberKey(member);
      const instance = updates.get(key);
      if (instance) next.set(key, instance);
      else next.delete(key);
    }
    instances.value = next;
  };

  return { instances, loading, loadInventory, refreshInstances };
}
