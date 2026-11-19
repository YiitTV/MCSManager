import { EventEmitter } from "events";
import { afterEach, describe, expect, it } from "vitest";

import {
  notifyPanels,
  panelSocketCount,
  registerPanelSocket,
  setDaemonShuttingDown
} from "../panel_notifier";

function fakeSocket(connected = true) {
  const s: any = new EventEmitter();
  s.connected = connected;
  s.sent = [] as any[];
  const origEmit = s.emit.bind(s);
  s.emit = (event: string, ...args: any[]) => {
    if (event === "disconnect") return origEmit(event, ...args);
    s.sent.push([event, ...args]);
    return true;
  };
  s.disconnectNow = () => origEmit("disconnect");
  return s;
}

afterEach(() => setDaemonShuttingDown(false));

describe("panel_notifier", () => {
  it("only delivers to sockets registered after auth", () => {
    const panel = fakeSocket();
    const unauth = fakeSocket();
    registerPanelSocket(panel);
    notifyPanels("instance/lifecycle", { a: 1 });
    expect(panel.sent).toHaveLength(1);
    expect(panel.sent[0][0]).toBe("instance/lifecycle");
    expect(panel.sent[0][1]).toMatchObject({ uuid: null, status: 200, data: { a: 1 } });
    expect(unauth.sent).toHaveLength(0);
    panel.disconnectNow();
  });

  it("removes the socket on disconnect and does not register twice", () => {
    const before = panelSocketCount();
    const s = fakeSocket();
    registerPanelSocket(s);
    registerPanelSocket(s);
    expect(panelSocketCount()).toBe(before + 1);
    s.disconnectNow();
    expect(panelSocketCount()).toBe(before);
    notifyPanels("x", {});
    expect(s.sent).toHaveLength(0);
  });

  it("prunes sockets that are no longer connected and never throws", () => {
    const before = panelSocketCount();
    const dead = fakeSocket(false);
    const bad = fakeSocket();
    bad.emit = () => {
      throw new Error("boom");
    };
    registerPanelSocket(dead);
    registerPanelSocket(bad);
    expect(() => notifyPanels("x", {})).not.toThrow();
    expect(dead.sent).toHaveLength(0);
    expect(panelSocketCount()).toBe(before + 1);
    bad.disconnectNow();
  });
});
