import { ref } from "vue";

export type InstanceListView = "normal" | "grouped";
export const INSTANCE_LIST_VIEW_KEY = "instance-list-view";

export function useInstanceListView() {
  const view = ref<InstanceListView>("normal");
  try {
    if (localStorage.getItem(INSTANCE_LIST_VIEW_KEY) === "grouped") view.value = "grouped";
  } catch {
    // Browsers can disable storage. The switch still works for this visit.
  }

  const selectView = (next: InstanceListView) => {
    view.value = next;
    try {
      localStorage.setItem(INSTANCE_LIST_VIEW_KEY, next);
    } catch {
      // Keep the in-memory selection.
    }
  };

  return { view, selectView };
}
