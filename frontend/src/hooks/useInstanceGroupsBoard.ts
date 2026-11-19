import { useInstanceBoardInventory, type BoardInstance } from "@/hooks/useInstanceBoardInventory";
import { useInstanceGroups } from "@/hooks/useInstanceGroups";
import { MAX_MINI_CONSOLES, useMiniConsoles } from "@/hooks/useMiniConsoles";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { getValidatorErrorMsg, reportErrorMsg } from "@/tools/validator";
import {
  memberKey,
  type GroupMemberRef,
  type GroupMemberView,
  type GroupRun,
  type InstanceGroupInput,
  type InstanceGroupView
} from "@/types/instanceGroup";
import { isMemberUnavailable } from "@/widgets/instanceGroup/status";
import { message } from "ant-design-vue";
import { computed, onMounted, reactive, ref } from "vue";

export function useInstanceGroupsBoard() {
  const { isAdmin } = useAppStateStore();
  const { instances, loading, loadInventory, refreshInstances } = useInstanceBoardInventory();
  const groupsLoaded = ref(false);

  const refreshMembers = (members: GroupMemberRef[]) =>
    refreshInstances(members.filter((member) => instances.value.has(memberKey(member))));

  const onRunFinished = (group: InstanceGroupView | undefined, run: GroupRun) => {
    const name = group?.name ?? "";
    if (group) void refreshMembers(group.members);
    if (run.state === "succeeded") {
      message.success(t("TXT_CODE_instance_group_ui.finishedOk", { name }));
    } else if (run.state === "cancelled") {
      message.info(t("TXT_CODE_instance_group_ui.finishedCancelled", { name }));
    } else {
      message.error(t("TXT_CODE_instance_group_ui.finishedFailed", { name }));
    }
  };

  const {
    groups,
    runs,
    activeGroupIds,
    isActive,
    refresh,
    isLoading,
    load,
    startGroup,
    stopGroup,
    cancelGroup,
    removeGroup,
    saveGroup
  } = useInstanceGroups({ onRunFinished });

  // Group ids with a request in flight, so buttons cannot be double-clicked.
  const pending = reactive<Record<string, boolean>>({});

  const guarded = async (groupId: string, task: () => Promise<unknown>) => {
    if (pending[groupId]) return;
    pending[groupId] = true;
    try {
      await task();
    } catch (error) {
      reportErrorMsg(error);
    } finally {
      delete pending[groupId];
    }
  };

  const runGroup = async (group: InstanceGroupView, operation: typeof startGroup) =>
    guarded(group.uuid, async () => {
      await operation(group.uuid);
      if (!isActive(group.uuid)) await refreshMembers(group.members);
    });

  const onStart = (group: InstanceGroupView) => runGroup(group, startGroup);
  const onStop = (group: InstanceGroupView) => runGroup(group, stopGroup);
  const onCancel = (group: InstanceGroupView) =>
    guarded(group.uuid, async () => {
      await cancelGroup(group.uuid);
      await refreshMembers(group.members);
    });
  const onRemove = (group: InstanceGroupView) => guarded(group.uuid, () => removeGroup(group.uuid));

  const editorOpen = ref(false);
  const editingGroup = ref<InstanceGroupView>();
  const saving = ref(false);
  const saveError = ref("");

  const openEditor = (group?: InstanceGroupView) => {
    editingGroup.value = group;
    saveError.value = "";
    editorOpen.value = true;
  };

  const onSave = async (input: InstanceGroupInput) => {
    saving.value = true;
    saveError.value = "";
    try {
      await saveGroup(editingGroup.value?.uuid, input);
      editorOpen.value = false;
    } catch (error) {
      // The panel answers with a translated reason (403 member no longer assigned, 409 run active).
      saveError.value = getValidatorErrorMsg(error, t("TXT_CODE_6a365d01"));
    } finally {
      saving.value = false;
    }
  };

  const miniConsoles = useMiniConsoles();

  const openConsole = (instance: BoardInstance) => {
    const result = miniConsoles.open({
      daemonId: instance.daemonId,
      instanceUuid: instance.instanceUuid,
      title: instance.detail.config.nickname || instance.instanceUuid
    });
    if (!result.ok) {
      message.warning(t("TXT_CODE_mini_console.limitReached", { max: MAX_MINI_CONSOLES }));
    }
  };

  const reload = async () => {
    try {
      await Promise.all([
        load().then(() => (groupsLoaded.value = true)),
        loadInventory(isAdmin.value)
      ]);
    } catch (error) {
      reportErrorMsg(error);
    }
  };

  const onRefreshInstance = async (instance: BoardInstance) => {
    try {
      await Promise.all([refreshInstances([instance]), refresh()]);
    } catch (error) {
      reportErrorMsg(error);
    }
  };

  const ungrouped = computed(() => {
    if (!groupsLoaded.value) return [];
    const groupedKeys = new Set(groups.value.flatMap((group) => group.members.map(memberKey)));
    return [...instances.value]
      .filter(([key]) => !groupedKeys.has(key))
      .map(([, instance]) => instance);
  });

  const activeMemberStatuses = computed(() => {
    const activeIds = new Set(activeGroupIds.value);
    const statuses = new Map<string, BoardInstance["detail"]["status"]>();
    for (const group of groups.value) {
      if (!activeIds.has(group.uuid)) continue;
      for (const member of group.members) {
        if (!isMemberUnavailable(member) && typeof member.status === "number") {
          statuses.set(memberKey(member), member.status);
        }
      }
    }
    return statuses;
  });

  const getMemberInstance = (member: GroupMemberView) => {
    if (isMemberUnavailable(member)) return;
    const key = memberKey(member);
    const instance = instances.value.get(key);
    const status = activeMemberStatuses.value.get(key);
    if (instance && status !== undefined && instance.detail.status !== status) {
      return { ...instance, detail: { ...instance.detail, status } };
    }
    return instance;
  };

  onMounted(reload);

  return {
    groups,
    runs,
    pending,
    isLoading: computed(() => isLoading.value || loading.value),
    isAdmin,
    ungrouped,
    getMemberInstance,
    reload,
    onStart,
    onStop,
    onCancel,
    onRemove,
    editorOpen,
    editingGroup,
    saving,
    saveError,
    openEditor,
    onSave,
    openConsole,
    onRefreshInstance
  };
}
