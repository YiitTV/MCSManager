// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  terminals: [] as any[],
  terminalOptions: [] as any[],
  handlers: {} as Record<string, (...args: any[]) => void>,
  socket: undefined as any,
  makeSocketIo: vi.fn(),
  setUpChannel: vi.fn(),
  getOutputLog: vi.fn(),
  webgl: vi.fn(),
  canvas: vi.fn()
}));

vi.mock("@/lang/i18n", () => ({ t: (key: string) => key, $t: (key: string) => key }));
vi.mock("@/config/const", () => ({ GLOBAL_INSTANCE_NAME: "__global__" }));
vi.mock("@/hooks/useCommandHistory", () => ({
  useCommandHistory: () => ({ setHistory: vi.fn() })
}));
vi.mock("@/services/apis/instance", () => ({
  setUpTerminalStreamChannel: () => ({ execute: mocks.setUpChannel }),
  getInstanceOutputLog: () => ({ execute: mocks.getOutputLog })
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
    const term = {
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
    mocks.terminals.push(term);
    return term;
  })
}));
vi.mock("@/hooks/useSocketIo", () => ({
  makeSocketIo: (...args: any[]) => {
    mocks.makeSocketIo(...args);
    return mocks.socket;
  }
}));
vi.mock("@/hooks/useTerminalTouch", () => ({ attachTerminalTouchControls: vi.fn() }));

import { MAX_MINI_CONSOLES, useMiniConsoles } from "@/hooks/useMiniConsoles";
import MiniConsoleHost from "../MiniConsoleHost.vue";

const target = (id: string) => ({ daemonId: "d", instanceUuid: id, title: `Server ${id}` });

beforeAll(() => {
  window.matchMedia = vi.fn(() => ({ matches: false })) as any;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.terminals.length = 0;
  mocks.terminalOptions.length = 0;
  for (const key of Object.keys(mocks.handlers)) delete mocks.handlers[key];
  mocks.socket = {
    connected: true,
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      mocks.handlers[event] = cb;
    }),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn()
  };
  mocks.setUpChannel.mockResolvedValue({
    value: { addr: "daemon:24444", prefix: "", password: "pw", remoteMappings: [] }
  });
  mocks.getOutputLog.mockResolvedValue({ value: "" });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any; // WebGL2 "available"
  window.innerWidth = 1280;
  window.innerHeight = 720;
  useMiniConsoles().closeAll();
});

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
  // The store is global: unmount every host so one test's windows never render in another.
  while (mounted.length) mounted.pop()!.unmount();
  useMiniConsoles().closeAll();
  document.body.innerHTML = "";
});

const mountHost = async () => {
  const wrapper = mount(MiniConsoleHost, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
};

const openOne = async (id = "a") => {
  const result = useMiniConsoles().open(target(id));
  await flushPromises();
  return result;
};

// Simulate the daemon stream: connected, authenticated, with a detail packet.
const connectStream = async (status = 3) => {
  mocks.handlers["connect"]?.();
  mocks.handlers["stream/auth"]?.({ data: true });
  mocks.handlers["stream/detail"]?.({ data: { status, config: { terminalOption: {} } } });
  await flushPromises();
};

describe("MiniConsole", () => {
  it("opens through the stream channel with a capped scrollback and the canvas renderer", async () => {
    const wrapper = await mountHost();
    await openOne();
    expect(wrapper.findAll('[data-test="mini-console"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="mini-title"]').text()).toContain("Server a");
    expect(mocks.setUpChannel).toHaveBeenCalledWith({ params: { daemonId: "d", uuid: "a" } });
    expect(mocks.makeSocketIo).toHaveBeenCalledTimes(1);
    expect(mocks.terminalOptions[0].scrollback).toBe(1000);
    expect(mocks.webgl).not.toHaveBeenCalled();
    expect(mocks.canvas).toHaveBeenCalledTimes(1);
  });

  it("refuses a fifth window", async () => {
    const wrapper = await mountHost();
    for (let i = 0; i < MAX_MINI_CONSOLES; i++) await openOne(`i${i}`);
    expect(wrapper.findAll('[data-test="mini-console"]')).toHaveLength(4);
    expect(useMiniConsoles().open(target("i9"))).toEqual({ ok: false, reason: "limit" });
    await flushPromises();
    expect(wrapper.findAll('[data-test="mini-console"]')).toHaveLength(4);
  });

  it("shows an error state and opens no stream when the channel is forbidden", async () => {
    mocks.setUpChannel.mockRejectedValue(new Error("Forbidden"));
    const wrapper = await mountHost();
    await openOne();
    expect(wrapper.find('[data-test="mini-error"]').text()).toContain("Forbidden");
    expect(mocks.makeSocketIo).not.toHaveBeenCalled();
    expect(mocks.terminals).toHaveLength(0);
    expect(wrapper.find('[data-test="mini-input"]').attributes("disabled")).toBeDefined();
  });

  it("drags by the title bar and stays inside the viewport", async () => {
    const wrapper = await mountHost();
    await openOne();
    const title = wrapper.find('[data-test="mini-title"]').element;
    const fire = (type: string, x: number, y: number) =>
      title.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    const style = () => (wrapper.find('[data-test="mini-console"]').element as HTMLElement).style;
    const start = { x: parseFloat(style().left), y: parseFloat(style().top) };

    fire("pointerdown", 500, 500);
    fire("pointermove", 450, 480);
    await flushPromises();
    expect(parseFloat(style().left)).toBe(start.x - 50);
    expect(parseFloat(style().top)).toBe(start.y - 20);

    fire("pointermove", -9000, -9000);
    await flushPromises();
    expect(style().left).toBe("0px");
    expect(style().top).toBe("0px");

    fire("pointermove", 90000, 90000);
    await flushPromises();
    expect(parseFloat(style().left)).toBe(1280 - 440);
    expect(parseFloat(style().top)).toBe(720 - 330);

    fire("pointerup", 90000, 90000);
    fire("pointermove", 0, 0);
    await flushPromises();
    expect(parseFloat(style().left)).toBe(1280 - 440); // no longer dragging
  });

  it("minimises to the title bar and restores with the stream and output intact", async () => {
    const wrapper = await mountHost();
    await openOne();
    await connectStream();
    const content = () => wrapper.find('[data-test="mini-content"]').element as HTMLElement;

    await wrapper.find('[data-test="mini-minimise"]').trigger("click");
    expect(wrapper.find('[data-test="mini-console"]').classes()).toContain("is-minimised");
    expect(content().style.display).toBe("none");
    expect(mocks.socket.disconnect).not.toHaveBeenCalled();
    expect(mocks.terminals[0].dispose).not.toHaveBeenCalled();

    await wrapper.find('[data-test="mini-minimise"]').trigger("click");
    expect(wrapper.find('[data-test="mini-console"]').classes()).not.toContain("is-minimised");
    expect(content().style.display).not.toBe("none");
    expect(mocks.terminals).toHaveLength(1); // same terminal, nothing re-created
  });

  it("closing disposes the terminal and disconnects the socket", async () => {
    const wrapper = await mountHost();
    await openOne();
    await connectStream();
    await wrapper.find('[data-test="mini-close"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="mini-console"]')).toHaveLength(0);
    expect(useMiniConsoles().windows.value).toHaveLength(0);
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.socket.removeAllListeners).toHaveBeenCalled();
    expect(mocks.terminals[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("closes a window that was closed while the stream channel request was in flight", async () => {
    let release!: (v: unknown) => void;
    mocks.setUpChannel.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const wrapper = await mountHost();
    const { id } = (await openOne()) as { id: string };
    useMiniConsoles().close(id);
    await flushPromises();
    release({ value: { addr: "daemon:24444", prefix: "", password: "pw", remoteMappings: [] } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="mini-console"]')).toHaveLength(0);
    expect(mocks.makeSocketIo).not.toHaveBeenCalled();
  });

  it("sends the typed line as a command to the instance", async () => {
    const wrapper = await mountHost();
    await openOne();
    await connectStream(3);
    const input = wrapper.find('[data-test="mini-input"]');
    expect(input.attributes("disabled")).toBeUndefined();
    await input.setValue("list");
    await input.trigger("keydown", { key: "Enter", keyCode: 13 });
    await flushPromises();
    expect(mocks.socket.emit).toHaveBeenCalledWith("stream/input", { data: { command: "list" } });
  });

  it("disables the input when the instance is stopped", async () => {
    const wrapper = await mountHost();
    await openOne();
    await connectStream(0);
    expect(wrapper.find('[data-test="mini-input"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-test="mini-input"]').attributes("placeholder")).toBe(
      "TXT_CODE_mini_console.stopped"
    );
  });

  it("closes every console when the host unmounts (leaving the page)", async () => {
    const wrapper = await mountHost();
    await openOne("a");
    await connectStream();
    await openOne("b");
    expect(useMiniConsoles().windows.value).toHaveLength(2);
    wrapper.unmount();
    expect(useMiniConsoles().windows.value).toHaveLength(0);
    expect(mocks.socket.disconnect).toHaveBeenCalled();
    for (const term of mocks.terminals) expect(term.dispose).toHaveBeenCalled();
  });
});
