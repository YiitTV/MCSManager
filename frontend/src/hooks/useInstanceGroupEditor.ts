import { t } from "@/lang/i18n";
import {
  DEFAULT_GROUP_ADVANCE,
  DEFAULT_RESTART_WARNING,
  GROUP_LIMITS,
  memberKey,
  type GroupAdvance,
  type GroupMemberRef,
  type InstanceGroupInput,
  type InstanceGroupView
} from "@/types/instanceGroup";
import { computed, reactive } from "vue";

export interface EditorMember extends GroupMemberRef {
  nickname: string;
  // The user may no longer operate this instance; it can only be removed from the group.
  unavailable?: boolean;
}

// Wildcards in a ready pattern; kept in sync with the panel limits.
function countWildcards(pattern: string): number {
  return pattern.split("*").length - 1;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function moveItem<T>(list: T[], index: number, delta: number) {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}

// Form state, ordering and client-side validation of the group editor. The server validates
// everything again; this only mirrors the limits so the user gets early feedback.
export function useInstanceGroupEditor() {
  const form = reactive({
    name: "",
    // Start order.
    members: [] as EditorMember[],
    // Stop order as "<daemonId>::<instanceUuid>" keys, always a permutation of the members.
    stopOrder: [] as string[],
    advance: { ...DEFAULT_GROUP_ADVANCE } as GroupAdvance,
    warningOffsets: "",
    warningMessage: ""
  });

  const reset = (group?: InstanceGroupView) => {
    form.name = group?.name ?? "";
    form.members = (group?.members ?? []).map((m) => ({
      daemonId: m.daemonId,
      instanceUuid: m.instanceUuid,
      nickname: m.nickname ?? "",
      unavailable: m.available === false
    }));
    form.stopOrder = group
      ? group.stopOrder.filter((key) => group.members.some((m) => memberKey(m) === key))
      : [];
    // Members missing from the stop order are appended so it stays a permutation.
    for (const m of form.members) {
      if (!form.stopOrder.includes(memberKey(m))) form.stopOrder.push(memberKey(m));
    }
    form.advance = { ...DEFAULT_GROUP_ADVANCE, ...(group?.advance ?? {}) };
    const warning = group?.restartWarning ?? DEFAULT_RESTART_WARNING;
    form.warningOffsets = warning.offsetsSec.join(", ");
    form.warningMessage = warning.message;
  };

  const memberByKey = (key: string) => form.members.find((m) => memberKey(m) === key);

  const stopMembers = computed(() =>
    form.stopOrder.map((key) => memberByKey(key)).filter((m): m is EditorMember => !!m)
  );

  // Adding appends to both orders. Duplicates are ignored, and the member limit is respected.
  // Returns how many members were added.
  const addMembers = (items: EditorMember[]) => {
    let added = 0;
    for (const item of items) {
      if (form.members.length >= GROUP_LIMITS.maxMembers) break;
      if (memberByKey(memberKey(item))) continue;
      form.members.push({
        daemonId: item.daemonId,
        instanceUuid: item.instanceUuid,
        nickname: item.nickname
      });
      form.stopOrder.push(memberKey(item));
      added++;
    }
    return added;
  };

  // Replace the selection with a picker result: keep the order of members that stay selected,
  // drop removed ones, append new ones.
  const syncMembers = (items: EditorMember[]) => {
    const keep = new Set(items.map(memberKey));
    for (const m of [...form.members]) if (!keep.has(memberKey(m))) removeMember(memberKey(m));
    return addMembers(items);
  };

  // Removing drops the member from both orders.
  const removeMember = (key: string) => {
    form.members = form.members.filter((m) => memberKey(m) !== key);
    form.stopOrder = form.stopOrder.filter((k) => k !== key);
  };

  const moveStart = (key: string, delta: -1 | 1) =>
    moveItem(
      form.members,
      form.members.findIndex((m) => memberKey(m) === key),
      delta
    );

  const moveStop = (key: string, delta: -1 | 1) =>
    moveItem(form.stopOrder, form.stopOrder.indexOf(key), delta);

  const warningOffsets = computed(() =>
    form.warningOffsets.split(",").map((part) => (/^\d+$/.test(part.trim()) ? Number(part) : NaN))
  );

  const errors = computed<string[]>(() => {
    const list: string[] = [];
    const name = form.name.trim();
    const adv = form.advance;
    if (name.length === 0) list.push(t("TXT_CODE_instance_group_ui.errNameRequired"));
    else if (name.length > GROUP_LIMITS.nameMax)
      list.push(t("TXT_CODE_instance_group_ui.errNameTooLong", { max: GROUP_LIMITS.nameMax }));

    if (form.members.length === 0) list.push(t("TXT_CODE_instance_group_ui.errMembersRequired"));
    if (form.members.length > GROUP_LIMITS.maxMembers)
      list.push(
        t("TXT_CODE_instance_group_ui.errTooManyMembers", { max: GROUP_LIMITS.maxMembers })
      );

    if (adv.mode === "pattern") {
      if (adv.pattern.trim().length === 0)
        list.push(t("TXT_CODE_instance_group_ui.errPatternRequired"));
      else if (adv.pattern.length > GROUP_LIMITS.patternMax)
        list.push(
          t("TXT_CODE_instance_group_ui.errPatternTooLong", { max: GROUP_LIMITS.patternMax })
        );
      else if (countWildcards(adv.pattern) > GROUP_LIMITS.patternMaxWildcards)
        list.push(
          t("TXT_CODE_instance_group_ui.errPatternWildcards", {
            max: GROUP_LIMITS.patternMaxWildcards
          })
        );
    }

    if (adv.mode === "delay" && !inRange(adv.delaySec, 0, GROUP_LIMITS.delayMax))
      list.push(t("TXT_CODE_instance_group_ui.errDelayRange", { max: GROUP_LIMITS.delayMax }));

    const timeoutError = t("TXT_CODE_instance_group_ui.errTimeoutRange", {
      min: GROUP_LIMITS.timeoutMin,
      max: GROUP_LIMITS.timeoutMax
    });
    const startOk = inRange(adv.startTimeoutSec, GROUP_LIMITS.timeoutMin, GROUP_LIMITS.timeoutMax);
    const stopOk = inRange(adv.stopTimeoutSec, GROUP_LIMITS.timeoutMin, GROUP_LIMITS.timeoutMax);
    if (!startOk || !stopOk) list.push(timeoutError);

    if (adv.mode === "delay" && startOk && adv.startTimeoutSec < adv.delaySec)
      list.push(t("TXT_CODE_instance_group_ui.errDelayExceedsTimeout"));

    const offsets = warningOffsets.value;
    if (
      offsets.length > 10 ||
      offsets.some((n) => !inRange(n, 1, 3600)) ||
      new Set(offsets).size !== offsets.length
    )
      list.push(t("TXT_CODE_instance_group_ui.warningOffsetsHelp"));
    if (
      !form.warningMessage.trim() ||
      form.warningMessage.length > 200 ||
      /[;&|<>`$\\]/.test(form.warningMessage)
    )
      list.push(t("TXT_CODE_instance_group_ui.warningMessageHelp", { token: "{seconds}" }));
    return list;
  });

  const isValid = computed(() => errors.value.length === 0);

  const toInput = (): InstanceGroupInput => {
    const advance: GroupAdvance = { ...form.advance, pattern: form.advance.pattern.trim() };
    // The delay is only used in delay mode; keep it consistent with the start timeout.
    if (advance.mode !== "delay")
      advance.delaySec = Math.min(advance.delaySec, advance.startTimeoutSec);
    return {
      name: form.name.trim(),
      members: form.members.map((m) => ({ daemonId: m.daemonId, instanceUuid: m.instanceUuid })),
      stopOrder: [...form.stopOrder],
      advance,
      restartWarning: { offsetsSec: warningOffsets.value, message: form.warningMessage.trim() }
    };
  };

  reset();

  return {
    form,
    stopMembers,
    errors,
    isValid,
    reset,
    addMembers,
    syncMembers,
    removeMember,
    moveStart,
    moveStop,
    toInput
  };
}
