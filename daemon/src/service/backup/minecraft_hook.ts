import { BACKUP_TIMING } from "mcsmanager-common";
import { abortError, throwIfAborted } from "./errors";
import logger from "../log";

/** The slice of Instance the hook needs (a fake in tests). */
export interface HookInstance {
  /** True while the server process accepts commands. */
  isRunning(): boolean;
  sendCommand(command: string): Promise<unknown>;
  /** Subscribe to console output; returns an unsubscribe function. */
  onOutput(listener: (text: string) => void): () => void;
}

export interface SaveHookOptions {
  instance: HookInstance;
  enabled: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives non-fatal notes for the record. */
  onWarning?: (warning: string) => void;
}

/** Lines printed by Minecraft when `save-all flush` completes. */
const SAVE_COMPLETE = /Saved the (game|world)|Save complete|Saved game/i;

export const SAVE_HOOK_WARNINGS = {
  TIMEOUT: "save_hook_timeout: Minecraft did not confirm the save in time",
  SAVE_OFF_FAILED: "save_hook_failed: could not send save-off",
  SAVE_ALL_FAILED: "save_hook_failed: could not send save-all flush",
  SAVE_ON_FAILED: "save_on_failed: could not re-enable world saving"
} as const;

function waitForSave(
  instance: HookInstance,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  send: () => Promise<unknown>
): Promise<"saved" | "timeout"> {
  return new Promise((resolve, reject) => {
    let tail = "";
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(abortError(signal)));
    const timer = setTimeout(() => done(() => resolve("timeout")), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = instance.onOutput((text) => {
      tail = (tail + text).slice(-1024);
      if (SAVE_COMPLETE.test(tail)) done(() => resolve("saved"));
    });
    send().catch((err) => done(() => reject(err)));
  });
}

/**
 * Run `fn` with the Minecraft world flushed and auto-save disabled.
 * `save-off` + `save-all flush` run first for a running instance; `save-on` is ALWAYS sent in a
 * finally block when `save-off` was attempted (and the server is still running).
 */
export async function withMinecraftSaveHook<T>(
  options: SaveHookOptions,
  fn: () => Promise<T>
): Promise<T> {
  const { instance, enabled, signal } = options;
  if (!enabled || !instance.isRunning()) return fn();
  const warn = (w: string) => options.onWarning?.(w);
  let saveOffAttempted = false;
  try {
    throwIfAborted(signal);
    saveOffAttempted = true;
    try {
      await instance.sendCommand("save-off");
    } catch (err) {
      logger.warn(`Backup save hook: save-off failed: ${(err as Error)?.message ?? err}`);
      warn(SAVE_HOOK_WARNINGS.SAVE_OFF_FAILED);
      return await fn();
    }
    try {
      const result = await waitForSave(
        instance,
        options.timeoutMs ?? BACKUP_TIMING.SAVE_HOOK_TIMEOUT_MS,
        signal,
        () => instance.sendCommand("save-all flush")
      );
      if (result === "timeout") warn(SAVE_HOOK_WARNINGS.TIMEOUT);
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      logger.warn(`Backup save hook: save-all failed: ${(err as Error)?.message ?? err}`);
      warn(SAVE_HOOK_WARNINGS.SAVE_ALL_FAILED);
    }
    throwIfAborted(signal);
    return await fn();
  } finally {
    if (saveOffAttempted && instance.isRunning()) {
      try {
        await instance.sendCommand("save-on");
      } catch (err) {
        logger.error(`Backup save hook: save-on failed: ${(err as Error)?.message ?? err}`);
        warn(SAVE_HOOK_WARNINGS.SAVE_ON_FAILED);
      }
    }
  }
}
