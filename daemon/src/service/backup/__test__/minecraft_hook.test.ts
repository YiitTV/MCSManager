import { describe, expect, it, vi } from "vitest";
import { BackupErrorCode } from "mcsmanager-common";
import { HookInstance, withMinecraftSaveHook } from "../minecraft_hook";

vi.mock("../../log", () => {
  const f: any = () => {};
  f.info = f.warn = f.error = f.debug = f;
  return { default: f };
});

class FakeInstance implements HookInstance {
  running = true;
  sent: string[] = [];
  listeners = new Set<(t: string) => void>();
  /** Output emitted in response to a command, or undefined for silence. */
  replies: Record<string, string | undefined> = { "save-all flush": "[Server] Saved the game\n" };
  failOn?: string;
  isRunning() {
    return this.running;
  }
  async sendCommand(c: string) {
    this.sent.push(c);
    if (this.failOn === c) throw new Error("instance not open");
    const reply = this.replies[c];
    if (reply) setImmediate(() => this.listeners.forEach((l) => l(reply)));
  }
  onOutput(l: (t: string) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

describe("withMinecraftSaveHook", () => {
  it("sends save-off, save-all flush, runs fn, then save-on", async () => {
    const inst = new FakeInstance();
    const order: string[] = [];
    const res = await withMinecraftSaveHook({ instance: inst, enabled: true }, async () => {
      order.push(...inst.sent);
      return 42;
    });
    expect(res).toBe(42);
    expect(order).toEqual(["save-off", "save-all flush"]);
    expect(inst.sent).toEqual(["save-off", "save-all flush", "save-on"]);
    expect(inst.listeners.size).toBe(0);
  });

  it("handles the save line split across chunks", async () => {
    const inst = new FakeInstance();
    inst.sendCommand = async (c: string) => {
      inst.sent.push(c);
      if (c === "save-all flush") {
        setImmediate(() => inst.listeners.forEach((l) => l("Saved th")));
        setTimeout(() => inst.listeners.forEach((l) => l("e game")), 5);
      }
    };
    const warnings: string[] = [];
    await withMinecraftSaveHook(
      { instance: inst, enabled: true, onWarning: (w) => warnings.push(w), timeoutMs: 500 },
      async () => undefined
    );
    expect(warnings).toEqual([]);
  });

  it("always sends save-on when fn throws", async () => {
    const inst = new FakeInstance();
    await expect(
      withMinecraftSaveHook({ instance: inst, enabled: true }, async () => {
        throw new Error("archive failed");
      })
    ).rejects.toThrow("archive failed");
    expect(inst.sent.at(-1)).toBe("save-on");
  });

  it("timeout is a warning and the backup continues", async () => {
    const inst = new FakeInstance();
    inst.replies = {};
    const warnings: string[] = [];
    const res = await withMinecraftSaveHook(
      { instance: inst, enabled: true, timeoutMs: 20, onWarning: (w) => warnings.push(w) },
      async () => "ok"
    );
    expect(res).toBe("ok");
    expect(warnings[0]).toMatch(/^save_hook_timeout/);
    expect(inst.sent).toEqual(["save-off", "save-all flush", "save-on"]);
  });

  it("save-all failure warns, still archives, still save-on", async () => {
    const inst = new FakeInstance();
    inst.failOn = "save-all flush";
    const warnings: string[] = [];
    const fn = vi.fn(async () => "ok");
    await withMinecraftSaveHook(
      { instance: inst, enabled: true, onWarning: (w) => warnings.push(w) },
      fn
    );
    expect(fn).toHaveBeenCalled();
    expect(warnings[0]).toMatch(/^save_hook_failed/);
    expect(inst.sent.at(-1)).toBe("save-on");
  });

  it("save-off failure warns and still attempts save-on", async () => {
    const inst = new FakeInstance();
    inst.failOn = "save-off";
    const fn = vi.fn(async () => "ok");
    await withMinecraftSaveHook({ instance: inst, enabled: true }, fn);
    expect(fn).toHaveBeenCalled();
    expect(inst.sent).toEqual(["save-off", "save-on"]);
  });

  it("cancel while waiting stops, rejects CANCELLED and sends save-on", async () => {
    const inst = new FakeInstance();
    inst.replies = {};
    const ac = new AbortController();
    const fn = vi.fn(async () => "ok");
    const p = withMinecraftSaveHook(
      { instance: inst, enabled: true, signal: ac.signal, timeoutMs: 5000 },
      fn
    );
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: BackupErrorCode.CANCELLED });
    expect(fn).not.toHaveBeenCalled();
    expect(inst.sent.at(-1)).toBe("save-on");
  });

  it("sends nothing for a stopped instance or a disabled hook", async () => {
    const stopped = new FakeInstance();
    stopped.running = false;
    const fn = vi.fn(async () => "ok");
    await withMinecraftSaveHook({ instance: stopped, enabled: true }, fn);
    expect(stopped.sent).toEqual([]);
    const off = new FakeInstance();
    await withMinecraftSaveHook({ instance: off, enabled: false }, fn);
    expect(off.sent).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("skips save-on if the server stopped during the archive", async () => {
    const inst = new FakeInstance();
    await withMinecraftSaveHook({ instance: inst, enabled: true }, async () => {
      inst.running = false;
    });
    expect(inst.sent).toEqual(["save-off", "save-all flush"]);
  });
});
