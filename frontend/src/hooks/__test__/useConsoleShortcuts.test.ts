import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, type EffectScope } from "vue";
import { CONSOLE_SHORTCUT_SUGGESTIONS, useConsoleShortcuts } from "../useConsoleShortcuts";

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), run: vi.fn() }));
vi.mock("@/stores/useDefineApi", () => ({
  useDefineApi: (config: { method: "GET" | "PUT" | "POST" }) => () => ({
    execute: { GET: mocks.list, PUT: mocks.save, POST: mocks.run }[config.method]
  })
}));
vi.mock("@/tools/validator", () => ({ reportErrorMsg: vi.fn() }));

let scope: EffectScope;
const target = { daemonId: "node", uuid: "server" };
const shortcut = { id: "saved-id", name: "Save", command: "save-all" };

beforeEach(() => {
  scope = effectScope();
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ value: [] });
  mocks.save.mockResolvedValue({ value: [shortcut] });
  mocks.run.mockResolvedValue({ value: true });
});
afterEach(() => scope.stop());

describe("useConsoleShortcuts", () => {
  it("stages suggestions locally and runs saved shortcuts by ID", async () => {
    const hooks = scope.run(() => useConsoleShortcuts(() => target))!;
    await nextTick();
    await hooks.openEditor();
    expect(hooks.draft.value).toEqual([]);
    hooks.addShortcut(CONSOLE_SHORTCUT_SUGGESTIONS[0]);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(hooks.shortcuts.value).toEqual([]);

    await hooks.save();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        params: target,
        data: { shortcuts: [{ name: "save-all", command: "save-all" }] }
      })
    );
    expect(hooks.shortcuts.value).toEqual([shortcut]);
    await hooks.run(shortcut.id);
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        params: target,
        data: { id: shortcut.id }
      })
    );
  });

  it("discards results from a previous server", async () => {
    let complete: (result: { value: (typeof shortcut)[] }) => void = () => {};
    mocks.list.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const uuid = ref(target.uuid);
    const hooks = scope.run(() => useConsoleShortcuts(() => ({ ...target, uuid: uuid.value })))!;
    uuid.value = "another-server";
    await nextTick();
    complete({ value: [shortcut] });
    await nextTick();
    expect(hooks.shortcuts.value).toEqual([]);
  });
});
