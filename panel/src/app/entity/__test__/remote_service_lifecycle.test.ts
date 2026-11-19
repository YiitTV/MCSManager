import { beforeEach, describe, expect, it, vi } from "vitest";

const sockets: any[] = [];
vi.mock("socket.io-client", () => {
  return {
    io: () => {
      const handlers = new Map<string, Function[]>();
      const s: any = {
        connected: false,
        on: (e: string, f: Function) => {
          handlers.set(e, [...(handlers.get(e) ?? []), f]);
          return s;
        },
        hasListeners: (e: string) => (handlers.get(e) ?? []).length > 0,
        listenerCount: (e: string) => (handlers.get(e) ?? []).length,
        trigger: (e: string, ...a: any[]) => (handlers.get(e) ?? []).forEach((f) => f(...a)),
        removeAllListeners: () => handlers.clear(),
        removeListener: () => s,
        disconnect: () => {},
        close: () => {},
        emit: () => {}
      };
      sockets.push(s);
      return s;
    }
  };
});
vi.mock("../../service/log", () => {
  const n = () => {};
  return { logger: { info: n, warn: n, error: n, debug: n } };
});
const lifecycle = vi.fn();
vi.mock("../../service/notification_service", () => ({
  onDaemonLifecycle: (...a: any[]) => lifecycle(...a)
}));

import RemoteService from "../remote_service";
import { RemoteServiceConfig } from "../entity_interface";

function make() {
  const cfg = new RemoteServiceConfig();
  cfg.ip = "127.0.0.1";
  cfg.port = 24444;
  cfg.remarks = "node-1";
  return new RemoteService("daemon-1", cfg);
}

beforeEach(() => {
  sockets.length = 0;
  lifecycle.mockClear();
});

describe("RemoteService instance/lifecycle listener", () => {
  it("registers exactly one listener and forwards a valid daemon packet", () => {
    const rs = make();
    rs.connect();
    const s = sockets[0];
    expect(s.listenerCount("instance/lifecycle")).toBe(1);
    const data = { instanceUuid: "u", kind: "started" };
    s.trigger("instance/lifecycle", { uuid: null, status: 200, event: "instance/lifecycle", data });
    expect(lifecycle).toHaveBeenCalledWith("daemon-1", "node-1", data);
  });
  it("ignores request-response packets and errors", () => {
    const rs = make();
    rs.connect();
    const s = sockets[0];
    s.trigger("instance/lifecycle", { uuid: "abc123", status: 200, data: {} });
    s.trigger("instance/lifecycle", { uuid: null, status: 500, data: {} });
    s.trigger("instance/lifecycle", null);
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it("does not duplicate on repeated connect or reconnect", () => {
    const rs = make();
    rs.connect();
    rs.connect(); // guard: existing socket has listeners -> refreshReconnect
    const last = sockets[sockets.length - 1];
    expect(last.listenerCount("instance/lifecycle")).toBe(1);
    expect(sockets[0].listenerCount("instance/lifecycle")).toBe(0); // old socket cleaned up
    last.trigger("instance/lifecycle", { uuid: null, status: 200, data: { a: 1 } });
    expect(lifecycle).toHaveBeenCalledTimes(1);
  });
  it("removes the listener on disconnect", () => {
    const rs = make();
    rs.connect();
    const s = sockets[0];
    rs.disconnect();
    expect(s.listenerCount("instance/lifecycle")).toBe(0);
  });
});
