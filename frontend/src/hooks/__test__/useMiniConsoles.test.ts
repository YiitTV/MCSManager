// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clampToViewport,
  MAX_MINI_CONSOLES,
  MINI_CONSOLE_HEIGHT,
  MINI_CONSOLE_TITLE_HEIGHT,
  miniConsoleSize,
  useMiniConsoles
} from "../useMiniConsoles";

const target = (id: string) => ({ daemonId: "d", instanceUuid: id, title: id });

describe("clampToViewport", () => {
  it("keeps a window that is already inside", () => {
    expect(clampToViewport(100, 80, 440, 330, 1280, 720)).toEqual({ x: 100, y: 80 });
  });

  it("clamps to every edge", () => {
    expect(clampToViewport(-50, -20, 440, 330, 1280, 720)).toEqual({ x: 0, y: 0 });
    expect(clampToViewport(2000, 2000, 440, 330, 1280, 720)).toEqual({ x: 840, y: 390 });
  });

  it("pins to the origin when the window is larger than the viewport", () => {
    expect(clampToViewport(10, 10, 440, 330, 300, 200)).toEqual({ x: 0, y: 0 });
  });
});

describe("miniConsoleSize", () => {
  it("collapses to the title bar and shrinks on narrow screens", () => {
    expect(miniConsoleSize(true, 1280).height).toBe(MINI_CONSOLE_TITLE_HEIGHT);
    expect(miniConsoleSize(false, 1280).height).toBe(MINI_CONSOLE_HEIGHT);
    expect(miniConsoleSize(false, 360).width).toBe(344);
  });
});

describe("useMiniConsoles store", () => {
  const store = useMiniConsoles();

  beforeEach(() => {
    store.closeAll();
    window.innerWidth = 1280;
    window.innerHeight = 720;
  });

  it("opens windows and refuses the fifth", () => {
    for (let i = 0; i < MAX_MINI_CONSOLES; i++) expect(store.open(target(`i${i}`)).ok).toBe(true);
    expect(store.windows.value).toHaveLength(4);
    expect(store.open(target("i4"))).toEqual({ ok: false, reason: "limit" });
    expect(store.windows.value).toHaveLength(4);
  });

  it("re-opening an already open instance focuses it instead of duplicating", () => {
    const first = store.open(target("a"));
    store.open(target("b"));
    store.toggleMinimise((first as { id: string }).id);
    const again = store.open(target("a"));
    expect(store.windows.value).toHaveLength(2);
    const win = store.windows.value.find((w) => w.instanceUuid === "a")!;
    expect(again).toEqual({ ok: true, id: win.id });
    expect(win.minimised).toBe(false);
    expect(win.z).toBe(Math.max(...store.windows.value.map((w) => w.z)));
  });

  it("allows a fifth window once one is closed", () => {
    const ids = Array.from({ length: 4 }, (_, i) => (store.open(target(`i${i}`)) as any).id);
    store.close(ids[0]);
    expect(store.open(target("i9")).ok).toBe(true);
  });

  it("places new windows inside the viewport", () => {
    window.innerWidth = 400;
    window.innerHeight = 300;
    store.open(target("a"));
    store.open(target("b"));
    for (const w of store.windows.value) {
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps moves to the viewport", () => {
    const { id } = store.open(target("a")) as { id: string };
    store.moveTo(id, -500, -500);
    expect(store.windows.value[0]).toMatchObject({ x: 0, y: 0 });
    store.moveTo(id, 99999, 99999);
    expect(store.windows.value[0]).toMatchObject({ x: 1280 - 440, y: 720 - MINI_CONSOLE_HEIGHT });
  });

  it("minimise toggles and re-clamps with the smaller or larger height", () => {
    const { id } = store.open(target("a")) as { id: string };
    store.moveTo(id, 0, 720 - MINI_CONSOLE_HEIGHT);
    store.toggleMinimise(id);
    expect(store.windows.value[0].minimised).toBe(true);
    store.moveTo(id, 0, 720 - MINI_CONSOLE_TITLE_HEIGHT);
    store.toggleMinimise(id);
    expect(store.windows.value[0].minimised).toBe(false);
    expect(store.windows.value[0].y).toBe(720 - MINI_CONSOLE_HEIGHT);
  });

  it("focus raises the window and closeAll empties the store", () => {
    const a = store.open(target("a")) as { id: string };
    store.open(target("b"));
    store.focus(a.id);
    const zs = store.windows.value.map((w) => w.z);
    expect(store.windows.value.find((w) => w.id === a.id)!.z).toBe(Math.max(...zs));
    store.closeAll();
    expect(store.windows.value).toHaveLength(0);
  });
});
