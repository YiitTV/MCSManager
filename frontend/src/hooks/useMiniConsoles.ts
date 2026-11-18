import { createGlobalState } from "@vueuse/core";
import { ref } from "vue";

// Browser memory guard: each console owns an xterm instance and a socket.
export const MAX_MINI_CONSOLES = 4;

// Only the most recent lines are kept in browser memory.
export const MINI_CONSOLE_SCROLLBACK = 1000;

export const MINI_CONSOLE_WIDTH = 440;
export const MINI_CONSOLE_HEIGHT = 330;
export const MINI_CONSOLE_TITLE_HEIGHT = 36;
const VIEWPORT_MARGIN = 8;

export interface MiniConsoleTarget {
  daemonId: string;
  instanceUuid: string;
  title: string;
}

export interface MiniConsoleWindow extends MiniConsoleTarget {
  id: string;
  minimised: boolean;
  x: number;
  y: number;
  // Stacking order: the highest value is on top.
  z: number;
}

export type OpenMiniConsoleResult = { ok: true; id: string } | { ok: false; reason: "limit" };

export function miniConsoleSize(minimised: boolean, viewportWidth: number) {
  return {
    width: Math.min(MINI_CONSOLE_WIDTH, Math.max(viewportWidth - VIEWPORT_MARGIN * 2, 0)),
    height: minimised ? MINI_CONSOLE_TITLE_HEIGHT : MINI_CONSOLE_HEIGHT
  };
}

// Keep a window fully inside the viewport.
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
) {
  const maxX = Math.max(viewportWidth - width, 0);
  const maxY = Math.max(viewportHeight - height, 0);
  return {
    x: Math.min(Math.max(x, 0), maxX),
    y: Math.min(Math.max(y, 0), maxY)
  };
}

export const windowKey = (target: Pick<MiniConsoleTarget, "daemonId" | "instanceUuid">) =>
  `${target.daemonId}::${target.instanceUuid}`;

// Open mini consoles. Each window component owns its terminal and socket, so removing a window
// from this list unmounts it and disposes both.
export const useMiniConsoles = createGlobalState(() => {
  const windows = ref<MiniConsoleWindow[]>([]);
  let zCounter = 1;

  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

  const find = (id: string) => windows.value.find((w) => w.id === id);

  const focus = (id: string) => {
    const win = find(id);
    if (win) win.z = ++zCounter;
  };

  const open = (target: MiniConsoleTarget): OpenMiniConsoleResult => {
    const existing = windows.value.find((w) => windowKey(w) === windowKey(target));
    if (existing) {
      existing.minimised = false;
      focus(existing.id);
      return { ok: true, id: existing.id };
    }
    if (windows.value.length >= MAX_MINI_CONSOLES) return { ok: false, reason: "limit" };

    const { w, h } = viewport();
    const size = miniConsoleSize(false, w);
    const offset = windows.value.length * 32;
    const pos = clampToViewport(
      w - size.width - 24 - offset,
      h - size.height - 24 - offset,
      size.width,
      size.height,
      w,
      h
    );
    const win: MiniConsoleWindow = {
      ...target,
      id: `mini-${Date.now().toString(36)}-${++zCounter}`,
      minimised: false,
      ...pos,
      z: ++zCounter
    };
    windows.value.push(win);
    return { ok: true, id: win.id };
  };

  const close = (id: string) => {
    windows.value = windows.value.filter((w) => w.id !== id);
  };

  const closeAll = () => {
    windows.value = [];
  };

  const setMinimised = (id: string, minimised: boolean) => {
    const win = find(id);
    if (!win) return;
    win.minimised = minimised;
    // The collapsed and expanded windows differ in height, so re-clamp after toggling.
    const { w, h } = viewport();
    const size = miniConsoleSize(minimised, w);
    Object.assign(win, clampToViewport(win.x, win.y, size.width, size.height, w, h));
    focus(id);
  };

  const toggleMinimise = (id: string) => {
    const win = find(id);
    if (win) setMinimised(id, !win.minimised);
  };

  const moveTo = (id: string, x: number, y: number) => {
    const win = find(id);
    if (!win) return;
    const { w, h } = viewport();
    const size = miniConsoleSize(win.minimised, w);
    Object.assign(win, clampToViewport(x, y, size.width, size.height, w, h));
  };

  // After a viewport resize, pull windows that fell outside back in.
  const clampAll = () => {
    for (const win of windows.value) moveTo(win.id, win.x, win.y);
  };

  return { windows, open, close, closeAll, focus, toggleMinimise, moveTo, clampAll };
});
