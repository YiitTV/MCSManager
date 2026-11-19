import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonEventStreamDeps, openDaemonEventStream } from "../daemon_event_stream";

// A fake socket.io client socket. `serverEmit` plays the daemon.
class FakeSocket extends EventEmitter {
  connected = false;
  sent: { event: string; args: any[] }[] = [];
  disconnected = false;

  override emit(event: string, ...args: any[]): boolean {
    // client -> daemon
    this.sent.push({ event, args });
    return true;
  }
  serverEmit(event: string, ...args: any[]) {
    super.emit(event, ...args);
  }
  removeAllListeners(...args: [string?]): this {
    return super.removeAllListeners(...args);
  }
  disconnect() {
    this.connected = false;
    this.disconnected = true;
    return this;
  }
  // test helpers
  accept() {
    this.connected = true;
    this.serverEmit("connect");
  }
  listenerTotal() {
    return this.eventNames().reduce((n, name) => n + this.listenerCount(name), 0);
  }
}

const UUID = "inst-1";

function setup(overrides: Partial<DaemonEventStreamDeps> = {}) {
  const socket = new FakeSocket();
  const passports: string[] = [];
  const deps: Partial<DaemonEventStreamDeps> = {
    getRemoteService: () => ({}) as any,
    registerPassport: async (_rs, password, instanceUuid) => {
      expect(instanceUuid).toBe(UUID);
      passports.push(password);
    },
    connect: () => socket as any,
    newPassword: () => "pw-123",
    connectTimeoutMs: 10_000,
    ...overrides
  };
  return { socket, deps, passports };
}

// Drive the happy path: connect, auth ok, detail reply with `status`
async function complete(socket: FakeSocket, status = 0) {
  await vi.advanceTimersByTimeAsync(0);
  socket.accept();
  socket.serverEmit("stream/auth", { status: 200, data: true });
  socket.serverEmit("stream/detail", { status: 200, data: { status } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("openDaemonEventStream", () => {
  it("registers the passport, authenticates, and resolves with the status from stream/detail", async () => {
    const { socket, deps, passports } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    await complete(socket, 3);
    const stream = await promise;
    expect(passports).toEqual(["pw-123"]);
    expect(socket.sent.map((s) => s.event)).toEqual(["stream/auth", "stream/detail"]);
    expect(socket.sent[0].args[0]).toEqual({ data: { password: "pw-123" } });
    expect(stream.status).toBe(3);
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on auth failure and releases the socket", async () => {
    const { socket, deps } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    const assertion = expect(promise).rejects.toThrow("auth failed");
    await vi.advanceTimersByTimeAsync(0);
    socket.accept();
    socket.serverEmit("stream/auth", { status: 200, data: false });
    await assertion;
    expect(socket.disconnected).toBe(true);
    expect(socket.listenerTotal()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects after the connect timeout (10s) when the daemon never answers", async () => {
    const { socket, deps } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    const assertion = expect(promise).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(socket.disconnected).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(socket.disconnected).toBe(true);
    expect(socket.listenerTotal()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when auth succeeds but the detail reply never arrives", async () => {
    const { socket, deps } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    socket.accept();
    socket.serverEmit("stream/auth", { status: 200, data: true });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(socket.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on connection errors", async () => {
    const { socket, deps } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    const assertion = expect(promise).rejects.toThrow("connection failed");
    await vi.advanceTimersByTimeAsync(0);
    socket.serverEmit("connect_error", new Error("ECONNREFUSED"));
    await assertion;
    expect(socket.disconnected).toBe(true);
  });

  it("rejects for an unknown daemon without creating a socket", async () => {
    const { deps } = setup({ getRemoteService: () => undefined });
    const connect = vi.fn();
    await expect(
      openDaemonEventStream("nope", UUID, { deps: { ...deps, connect } })
    ).rejects.toThrow("Unknown daemon");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects without creating a socket when the passport registration fails", async () => {
    const connect = vi.fn();
    const { deps } = setup({
      registerPassport: async () => {
        throw new Error("daemon offline");
      },
      connect
    });
    await expect(openDaemonEventStream("d1", UUID, { deps })).rejects.toThrow("daemon offline");
    expect(connect).not.toHaveBeenCalled();
  });

  it("aborts while connecting", async () => {
    const { socket, deps } = setup();
    const controller = new AbortController();
    const promise = openDaemonEventStream("d1", UUID, { deps, signal: controller.signal });
    const assertion = expect(promise).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(socket.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not even start when the signal is already aborted", async () => {
    const { deps } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      openDaemonEventStream("d1", UUID, { deps, signal: controller.signal })
    ).rejects.toThrow("Aborted");
  });
});

describe("DaemonEventStream events", () => {
  async function open() {
    const { socket, deps } = setup();
    const promise = openDaemonEventStream("d1", UUID, { deps });
    await complete(socket, 2);
    return { socket, stream: await promise };
  }

  it("dispatches stdout, opened, stopped and failure to subscribers", async () => {
    const { socket, stream } = await open();
    const seen: string[] = [];
    stream.on("stdout", (t) => seen.push(`out:${t}`));
    stream.on("opened", () => seen.push("opened"));
    stream.on("stopped", () => seen.push("stopped"));
    stream.on("failure", () => seen.push("failure"));
    socket.serverEmit("instance/stdout", { data: { instanceUuid: UUID, text: "hello" } });
    socket.serverEmit("instance/opened", { data: { instanceUuid: UUID } });
    socket.serverEmit("instance/stopped", { data: { instanceUuid: UUID } });
    socket.serverEmit("instance/failure", { data: { instanceUuid: UUID } });
    expect(seen).toEqual(["out:hello", "opened", "stopped", "failure"]);
    stream.close();
  });

  it("ignores events for a different instance and malformed packets", async () => {
    const { socket, stream } = await open();
    const seen: string[] = [];
    stream.on("stdout", (t) => seen.push(t));
    stream.on("stopped", () => seen.push("stopped"));
    socket.serverEmit("instance/stdout", { data: { instanceUuid: "other", text: "x" } });
    socket.serverEmit("instance/stdout", { data: { instanceUuid: UUID, text: 5 } });
    socket.serverEmit("instance/stdout", undefined);
    socket.serverEmit("instance/stopped", { data: { instanceUuid: "other" } });
    expect(seen).toEqual([]);
    stream.close();
  });

  it("unsubscribes through the returned function", async () => {
    const { socket, stream } = await open();
    const seen: string[] = [];
    const off = stream.on("stdout", (t) => seen.push(t));
    socket.serverEmit("instance/stdout", { data: { instanceUuid: UUID, text: "a" } });
    off();
    socket.serverEmit("instance/stdout", { data: { instanceUuid: UUID, text: "b" } });
    expect(seen).toEqual(["a"]);
    stream.close();
  });

  it("requestStatus returns the next detail reply and cleans up its timer", async () => {
    const { socket, stream } = await open();
    const p = stream.requestStatus();
    expect(socket.sent.at(-1)?.event).toBe("stream/detail");
    socket.serverEmit("stream/detail", { status: 200, data: { status: 3 } });
    await expect(p).resolves.toBe(3);
    expect(stream.status).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    stream.close();
  });

  it("requestStatus times out and rejects pending requests when closed", async () => {
    const { stream } = await open();
    const timeout = expect(stream.requestStatus(1000)).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(1001);
    await timeout;
    const pending = expect(stream.requestStatus(60_000)).rejects.toThrow("closed");
    stream.close();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() removes all listeners, disconnects, notifies 'closed' once and is idempotent", async () => {
    const { socket, stream } = await open();
    const closed = vi.fn();
    stream.on("closed", closed);
    stream.close();
    stream.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(socket.disconnected).toBe(true);
    expect(socket.listenerTotal()).toBe(0);
    expect(stream.isClosed).toBe(true);
    // events after close go nowhere
    const late = vi.fn();
    stream.on("stdout", late);
    socket.serverEmit("instance/stdout", { data: { instanceUuid: UUID, text: "x" } });
    expect(late).not.toHaveBeenCalled();
  });

  it("closes itself when the daemon drops the connection", async () => {
    const { socket, stream } = await open();
    const closed = vi.fn();
    stream.on("closed", closed);
    socket.serverEmit("disconnect");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(stream.isClosed).toBe(true);
    expect(socket.listenerTotal()).toBe(0);
  });

  it("a throwing listener does not break other listeners", async () => {
    const { socket, stream } = await open();
    const ok = vi.fn();
    stream.on("opened", () => {
      throw new Error("boom");
    });
    stream.on("opened", ok);
    socket.serverEmit("instance/opened", { data: { instanceUuid: UUID } });
    expect(ok).toHaveBeenCalled();
    stream.close();
  });
});
