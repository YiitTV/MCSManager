import { vi } from "vitest";

// A fake daemon for panel tests: RemoteRequest is replaced by a call recorder that dispatches to
// per-event handlers. Used together with a mocked `remote_service` that "knows" the daemon ids.

export type FakeHandler = (data: any, daemonId: string) => any;

export const fakeDaemon = {
  handlers: new Map<string, FakeHandler>(),
  calls: [] as { daemonId: string; event: string; data: any }[],
  knownDaemons: new Set<string>(["d1"]),
  reset() {
    this.handlers.clear();
    this.calls.length = 0;
    this.knownDaemons = new Set(["d1"]);
  },
  on(event: string, handler: FakeHandler) {
    this.handlers.set(event, handler);
  },
  callsOf(event: string) {
    return this.calls.filter((c) => c.event === event);
  }
};

export const remoteCommandMock = {
  default: class FakeRemoteRequest {
    constructor(public readonly rService?: { uuid: string }) {
      if (!rService) throw new Error("no socket");
    }
    async request(event: string, data?: any) {
      const daemonId = this.rService!.uuid;
      fakeDaemon.calls.push({ daemonId, event, data: JSON.parse(JSON.stringify(data ?? null)) });
      const handler = fakeDaemon.handlers.get(event);
      if (!handler) throw new Error(`fake daemon: no handler for ${event}`);
      return handler(data, daemonId);
    }
  },
  INSTANCE_KILL_TIMEOUT: 30000
};

const fakeService = (id: string) => ({
  uuid: id,
  available: true,
  config: { fullAddr: "ws://daemon.test:24444", getConvertedRemoteMappings: () => [] }
});

export const remoteServiceMock = {
  default: {
    getInstance: (id: string) => (fakeDaemon.knownDaemons.has(id) ? fakeService(id) : undefined),
    get services() {
      return new Map([...fakeDaemon.knownDaemons].map((id) => [id, fakeService(id)]));
    }
  }
};

/** In-memory replacement of `Storage.getStorage()`. */
export const memoryStore = new Map<string, any>();
export const sysStorageMock = {
  default: {
    getStorage: () => ({
      store: async (c: string, id: string, obj: any) =>
        void memoryStore.set(`${c}/${id}`, JSON.parse(JSON.stringify(obj))),
      load: async (c: string, _cls: any, id: string) => {
        const v = memoryStore.get(`${c}/${id}`);
        return v === undefined ? null : JSON.parse(JSON.stringify(v));
      },
      list: async (c: string) =>
        [...memoryStore.keys()]
          .filter((k) => k.startsWith(c + "/"))
          .map((k) => k.slice(c.length + 1)),
      delete: async (c: string, id: string) => void memoryStore.delete(`${c}/${id}`)
    })
  }
};

export const logMock = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
};
