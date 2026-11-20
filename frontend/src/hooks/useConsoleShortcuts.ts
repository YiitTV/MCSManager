import { useDefineApi } from "@/stores/useDefineApi";
import { reportErrorMsg } from "@/tools/validator";
import { computed, onScopeDispose, ref, watch } from "vue";

interface ShortcutInput {
  name: string;
  command: string;
}

interface Shortcut extends ShortcutInput {
  id: string;
}

interface ShortcutScope {
  daemonId: string;
  uuid: string;
}

const url = "/api/protected_instance/console_shortcuts";
const list = useDefineApi<{ params: ShortcutScope }, Shortcut[]>({ url, method: "GET" });
const update = useDefineApi<
  { params: ShortcutScope; data: { shortcuts: ShortcutInput[] } },
  Shortcut[]
>({ url, method: "PUT" });
const send = useDefineApi<{ params: ShortcutScope; data: { id: string } }, boolean>({
  url: `${url}/run`,
  method: "POST"
});

export const MAX_CONSOLE_SHORTCUTS = 20;
export const CONSOLE_SHORTCUT_SUGGESTIONS = [
  { name: "save-all", command: "save-all" },
  { name: "spark tps", command: "spark tps" },
  { name: "lp sync", command: "lp sync" },
  { name: "say …", command: "say " }
];

export function useConsoleShortcuts(scope: () => ShortcutScope) {
  const shortcuts = ref<Shortcut[]>([]);
  const draft = ref<ShortcutInput[]>([]);
  const editing = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const running = ref<string>();
  let generation = 0;

  const load = async () => {
    const current = generation;
    loading.value = true;
    try {
      const data = await list().execute({ params: scope(), forceRequest: true, timeout: 10000 });
      if (current !== generation) return false;
      shortcuts.value = data.value ?? [];
      return true;
    } catch (error) {
      if (current === generation) reportErrorMsg(error);
      return false;
    } finally {
      if (current === generation) loading.value = false;
    }
  };

  watch(
    () => {
      const { daemonId, uuid } = scope();
      return [daemonId, uuid] as const;
    },
    () => {
      generation++;
      shortcuts.value = [];
      editing.value = false;
      running.value = undefined;
      saving.value = false;
      void load();
    },
    { immediate: true }
  );
  onScopeDispose(() => generation++);

  const openEditor = async () => {
    if (loading.value || !(await load())) return;
    draft.value = shortcuts.value.map(({ name, command }) => ({ name, command }));
    editing.value = true;
  };

  const addShortcut = (input: ShortcutInput = { name: "", command: "" }) => {
    if (draft.value.length < MAX_CONSOLE_SHORTCUTS) draft.value.push({ ...input });
  };

  const canSave = computed(() =>
    draft.value.every(({ name, command }) => {
      const nonPrinting = /[\p{Cc}\p{Zl}\p{Zp}]/u;
      return name.trim() && command.trim() && !nonPrinting.test(name) && !nonPrinting.test(command);
    })
  );

  const save = async () => {
    if (saving.value || !canSave.value) return;
    const current = generation;
    saving.value = true;
    try {
      const data = await update().execute({
        params: scope(),
        data: { shortcuts: draft.value.map((shortcut) => ({ ...shortcut })) },
        forceRequest: true,
        timeout: 10000
      });
      if (current !== generation) return;
      shortcuts.value = data.value ?? [];
      editing.value = false;
    } catch (error) {
      if (current === generation) reportErrorMsg(error);
    } finally {
      if (current === generation) saving.value = false;
    }
  };

  const run = async (id: string) => {
    if (running.value) return;
    const current = generation;
    running.value = id;
    try {
      await send().execute({ params: scope(), data: { id }, forceRequest: true, timeout: 10000 });
    } catch (error) {
      if (current !== generation) return;
      reportErrorMsg(error);
      // Another console may have replaced the saved list.
      await load();
    } finally {
      if (current === generation) running.value = undefined;
    }
  };

  return {
    shortcuts,
    draft,
    editing,
    loading,
    saving,
    running,
    canSave,
    openEditor,
    addShortcut,
    save,
    run
  };
}
