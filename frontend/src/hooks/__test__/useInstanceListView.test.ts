// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_LIST_VIEW_KEY, useInstanceListView } from "../useInstanceListView";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useInstanceListView", () => {
  it("defaults to Normal and remembers both choices in a new instance", () => {
    const { view, selectView } = useInstanceListView();
    expect(view.value).toBe("normal");
    selectView("grouped");
    expect(useInstanceListView().view.value).toBe("grouped");
    selectView("normal");
    expect(localStorage.getItem(INSTANCE_LIST_VIEW_KEY)).toBe("normal");
    expect(useInstanceListView().view.value).toBe("normal");
  });

  it("keeps switching in memory when browser storage reads and writes fail", () => {
    const blocked = () => {
      throw new DOMException("Storage is disabled", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);

    const { view, selectView } = useInstanceListView();
    expect(view.value).toBe("normal");
    selectView("grouped");
    expect(view.value).toBe("grouped");
    selectView("normal");
    expect(view.value).toBe("normal");
  });
});
