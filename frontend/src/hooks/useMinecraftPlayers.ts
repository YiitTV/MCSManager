import {
  getPlayerRoster,
  submitPlayerAction,
  type PlayerRoster
} from "@/services/apis/minecraftOperations";
import type { GroupMemberRef } from "@/types/instanceGroup";
import { computed, ref, watch } from "vue";

export const PLAYER_ACTIONS = [
  "kick",
  "ban",
  "pardon",
  "op",
  "deop",
  "whitelistAdd",
  "whitelistRemove",
  "tell"
] as const;

export function validMinecraftName(value: string) {
  return value.length >= 3 && value.length <= 16 && !/[^A-Za-z0-9_]/u.test(value);
}

export function useMinecraftPlayers(target: () => GroupMemberRef, running: () => boolean) {
  const open = ref(false);
  const roster = ref<PlayerRoster>();
  const loading = ref(false);
  const error = ref(false);
  const result = ref<"submitted" | "failed">();
  const player = ref("");
  const action = ref<(typeof PLAYER_ACTIONS)[number]>("kick");
  const text = ref("");
  const sending = ref(false);
  const asksForText = computed(() => ["kick", "ban", "tell"].includes(action.value));
  const canSubmit = computed(
    () =>
      running() &&
      roster.value?.canManage &&
      validMinecraftName(player.value) &&
      (action.value !== "tell" || !!text.value.trim())
  );
  const { execute: read } = getPlayerRoster();
  const { execute: send } = submitPlayerAction();
  let session: AbortController | undefined;

  watch(action, () => {
    text.value = "";
    result.value = undefined;
  });

  watch(
    [open, running, () => target().daemonId, () => target().instanceUuid],
    ([visible, active, daemonId, uuid], _, onCleanup) => {
      roster.value = undefined;
      loading.value = false;
      error.value = false;
      sending.value = false;
      result.value = undefined;
      player.value = "";
      text.value = "";
      if (!visible || !active) return;

      const controller = new AbortController();
      session = controller;
      const { signal } = controller;
      let timer: ReturnType<typeof setTimeout>;
      const refresh = async () => {
        loading.value = true;
        try {
          const next = await read({ params: { daemonId, uuid }, forceRequest: true, signal });
          if (!signal.aborted) {
            roster.value = next.value;
            error.value = !next.value;
          }
        } catch {
          if (!signal.aborted) error.value = true;
        } finally {
          if (!signal.aborted) {
            loading.value = false;
            timer = setTimeout(refresh, 30_000);
          }
        }
      };
      onCleanup(() => {
        controller.abort();
        clearTimeout(timer);
        session = undefined;
      });
      void refresh();
    }
  );

  function selectPlayer(name: string) {
    player.value = name;
    result.value = undefined;
  }

  async function submit() {
    if (!canSubmit.value || sending.value || !session) return;
    const { signal } = session;
    const { daemonId, instanceUuid: uuid } = target();
    sending.value = true;
    result.value = undefined;
    try {
      const response = await send({
        params: { daemonId, uuid },
        data: {
          player: player.value,
          action: action.value,
          text: asksForText.value ? text.value : undefined
        },
        forceRequest: true,
        signal
      });
      if (!signal.aborted) {
        result.value = response.value?.accepted ? "submitted" : "failed";
        if (response.value?.accepted) text.value = "";
      }
    } catch {
      if (!signal.aborted) result.value = "failed";
    } finally {
      if (!signal.aborted) sending.value = false;
    }
  }

  return {
    open,
    roster,
    loading,
    error,
    player,
    action,
    text,
    sending,
    asksForText,
    canSubmit,
    result,
    selectPlayer,
    submit
  };
}
