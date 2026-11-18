// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

const mocks = vi.hoisted(() => ({
  terminalOptions: [] as any[],
  webgl: vi.fn(),
  canvas: vi.fn(),
  touch: vi.fn(() => () => undefined),
  disconnect: vi.fn(),
  setUpChannel: vi.fn()
}));

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/config/const", () => ({ GLOBAL_INSTANCE_NAME: "__global__" }));
vi.mock("@/hooks/useCommandHistory", () => ({
  useCommandHistory: () => ({ setHistory: vi.fn() })
}));
vi.mock("@/services/apis/instance", () => ({
  setUpTerminalStreamChannel: () => ({ execute: mocks.setUpChannel })
}));
vi.mock("@/stores/useAppConfigStore", () => ({
  useAppConfigStore: () => ({ hasBgImage: { value: false } })
}));
vi.mock("@/tools/copy", () => ({ toCopy: vi.fn() }));
vi.mock("@/tools/protocol", () => ({
  mapDaemonAddress: vi.fn(),
  parseForwardAddress: (addr: string) => addr
}));
vi.mock("@/types/const", () => ({
  INSTANCE_STATUS_CODE: { BUSY: -1, STOPPED: 0, STOPPING: 1, STARTING: 2, RUNNING: 3 }
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(() => {
    mocks.webgl();
    return { onContextLoss: vi.fn(), dispose: vi.fn() };
  })
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn(() => {
    mocks.canvas();
    return {};
  })
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn(() => ({})) }));
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn((options: any) => {
    mocks.terminalOptions.push(options);
    return {
      cols: 80,
      rows: 24,
      unicode: { activeVersion: "" },
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn()
    };
  })
}));
vi.mock("../useSocketIo", () => ({
  makeSocketIo: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: mocks.disconnect,
    removeAllListeners: vi.fn()
  }))
}));
vi.mock("../useTerminalTouch", () => ({ attachTerminalTouchControls: mocks.touch }));

import { useTerminal, type UseTerminalOptions } from "../useTerminal";

function mountHook(options?: UseTerminalOptions) {
  let hook!: ReturnType<typeof useTerminal>;
  const wrapper = mount(
    defineComponent({
      setup() {
        hook = useTerminal(options);
        return () => h("div");
      }
    })
  );
  return { hook, wrapper };
}

describe("useTerminal options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.terminalOptions.length = 0;
    // WebGL2 available and a touch capable device: the defaults take both paths.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any;
    window.matchMedia = vi.fn(() => ({ matches: true })) as any;
  });

  it("keeps the full terminal behaviour with no options", () => {
    const { hook } = mountHook();
    hook.initTerminalWindow(document.createElement("div"));
    const opts = mocks.terminalOptions[0];
    expect(opts.fontSize).toBe(14);
    expect("scrollback" in opts).toBe(false);
    expect(mocks.webgl).toHaveBeenCalledTimes(1);
    expect(mocks.canvas).not.toHaveBeenCalled();
    expect(mocks.touch).toHaveBeenCalledTimes(1);
  });

  it("applies scrollback, the canvas renderer and compact mode", () => {
    const { hook } = mountHook({ scrollback: 1000, renderer: "canvas", compact: true });
    hook.initTerminalWindow(document.createElement("div"));
    const opts = mocks.terminalOptions[0];
    expect(opts.scrollback).toBe(1000);
    expect(opts.fontSize).toBe(12);
    expect(mocks.webgl).not.toHaveBeenCalled();
    expect(mocks.canvas).toHaveBeenCalledTimes(1);
    expect(mocks.touch).not.toHaveBeenCalled();
  });

  it("does not open a socket when unmounted while the stream channel request is in flight", async () => {
    let release!: (v: unknown) => void;
    mocks.setUpChannel.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { hook, wrapper } = mountHook();
    const pending = hook.execute({ instanceId: "i", daemonId: "d" });
    wrapper.unmount();
    release({ value: { addr: "a", prefix: "", password: "p", remoteMappings: [] } });
    expect(await pending).toBeUndefined();
  });
});
