import { io } from "socket.io-client";
import type RemoteService from "../entity/remote_service";
import { STREAM_CONNECT_TIMEOUT_MS } from "../entity/instance_group";
import { logger } from "./log";
import { timeUuid } from "./password";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

// A short-lived panel -> daemon stream client for ONE instance, used by the
// instance group runner to wait for daemon events instead of polling.
//
// The flow mirrors terminal_bridge.ts (which is intentionally left unchanged):
//   1. passport/register { name: "stream_channel", password, parameter: { instanceUuid } }
//   2. socket.io connect -> emit stream/auth { data: { password } }
//   3. on stream/auth data === true -> emit stream/detail, the reply carries the status
// The passport confines the socket to that single instance, so the events it
// receives can never describe another instance.

export interface StreamEventMap {
  stdout: string;
  opened: void;
  stopped: void;
  failure: void;
  // Instance status from a stream/detail reply (daemon STATUS_* value)
  detail: number;
  // The socket was disconnected (daemon restart, network drop); also emitted by close()
  closed: void;
}

type Listener<E extends keyof StreamEventMap> = (payload: StreamEventMap[E]) => void;

// The minimal socket.io client surface used here (also implemented by test fakes).
export interface StreamSocket {
  connected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  removeAllListeners(): unknown;
  disconnect(): unknown;
}

export interface DaemonEventStreamDeps {
  // Resolve the daemon connection; undefined when the daemon is unknown
  getRemoteService: (daemonId: string) => RemoteService | undefined;
  // Register the one-instance stream_channel passport on the daemon
  registerPassport: (
    remoteService: RemoteService,
    password: string,
    instanceUuid: string
  ) => Promise<void>;
  connect: (remoteService: RemoteService) => StreamSocket;
  newPassword: () => string;
  connectTimeoutMs: number;
}

const defaultDeps: DaemonEventStreamDeps = {
  getRemoteService: (daemonId) => RemoteServiceSubsystem.getInstance(daemonId),
  registerPassport: async (remoteService, password, instanceUuid) => {
    await new RemoteRequest(remoteService).request("passport/register", {
      name: "stream_channel",
      password,
      parameter: { instanceUuid }
    });
  },
  connect: (remoteService) =>
    io(remoteService.realUrl, {
      path: remoteService.config.canonicalPrefix + "/socket.io",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true
    }) as unknown as StreamSocket,
  newPassword: () => timeUuid(),
  connectTimeoutMs: STREAM_CONNECT_TIMEOUT_MS
};

const DAEMON_EVENTS = {
  "instance/stdout": "stdout",
  "instance/opened": "opened",
  "instance/stopped": "stopped",
  "instance/failure": "failure"
} as const;

export class DaemonEventStream {
  // Status from the latest stream/detail reply (null until the first one)
  public status: number | null = null;

  private readonly listeners = new Map<keyof StreamEventMap, Set<Listener<any>>>();
  private detailWaiters = new Set<{
    resolve: (status: number) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;

  constructor(
    private readonly socket: StreamSocket,
    private readonly instanceUuid: string
  ) {}

  /** @internal wire daemon events to subscribers; called once by the opener. */
  attach() {
    for (const [daemonEvent, name] of Object.entries(DAEMON_EVENTS)) {
      this.socket.on(daemonEvent, (packet: any) => {
        if (this.closed) return;
        // Defensive: a stream_channel socket only carries its own instance
        const uuid = packet?.data?.instanceUuid;
        if (uuid !== undefined && uuid !== this.instanceUuid) return;
        if (name === "stdout") {
          const text = packet?.data?.text;
          if (typeof text === "string") this.emit("stdout", text);
        } else {
          this.emit(name as "opened" | "stopped" | "failure", undefined as never);
        }
      });
    }
    this.socket.on("stream/detail", (packet: any) => {
      if (this.closed) return;
      const status = packet?.data?.status;
      if (packet?.status !== 200 || typeof status !== "number") return;
      this.status = status;
      for (const waiter of [...this.detailWaiters]) {
        clearTimeout(waiter.timer);
        this.detailWaiters.delete(waiter);
        waiter.resolve(status);
      }
      this.emit("detail", status);
    });
    this.socket.on("disconnect", () => {
      if (!this.closed) this.close();
    });
  }

  on<E extends keyof StreamEventMap>(event: E, listener: Listener<E>): () => void {
    if (this.closed) return () => {};
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Ask the daemon for the current instance status (one request, bounded wait). */
  requestStatus(timeoutMs = 5000): Promise<number> {
    if (this.closed || !this.socket.connected)
      return Promise.reject(new Error("Daemon stream is closed"));
    return new Promise<number>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.detailWaiters.delete(waiter);
          reject(new Error("Timed out waiting for instance status"));
        }, timeoutMs)
      };
      this.detailWaiters.add(waiter);
      this.socket.emit("stream/detail", {});
    });
  }

  get isClosed() {
    return this.closed;
  }

  /** Remove every listener and timer and disconnect. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.detailWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Daemon stream is closed"));
    }
    this.detailWaiters.clear();
    const closedListeners = [...(this.listeners.get("closed") ?? [])];
    this.listeners.clear();
    try {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    } catch (err) {
      logger.warn("DaemonEventStream: error while closing socket:", err);
    }
    for (const listener of closedListeners) listener(undefined as never);
  }

  private emit<E extends keyof StreamEventMap>(event: E, payload: StreamEventMap[E]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (err) {
        logger.warn(`DaemonEventStream: listener for ${event} threw:`, err);
      }
    }
  }
}

/**
 * Open an authenticated stream client for one instance. Resolves once the
 * daemon accepted the passport AND the first stream/detail reply (instance
 * status) arrived; rejects after `connectTimeoutMs` in total, on auth failure,
 * or when `signal` aborts. The caller MUST call close().
 */
export async function openDaemonEventStream(
  daemonId: string,
  instanceUuid: string,
  options: { signal?: AbortSignal; deps?: Partial<DaemonEventStreamDeps> } = {}
): Promise<DaemonEventStream> {
  const deps: DaemonEventStreamDeps = { ...defaultDeps, ...options.deps };
  const { signal } = options;
  if (signal?.aborted) throw new Error("Aborted");

  const remoteService = deps.getRemoteService(daemonId);
  if (!remoteService) throw new Error(`Unknown daemon ${daemonId}`);

  const password = deps.newPassword();
  await deps.registerPassport(remoteService, password, instanceUuid);
  if (signal?.aborted) throw new Error("Aborted");

  const socket = deps.connect(remoteService);
  const stream = new DaemonEventStream(socket, instanceUuid);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out connecting to the daemon stream")),
        deps.connectTimeoutMs
      );
      if (signal) {
        onAbort = () => reject(new Error("Aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
      socket.on("connect", () => {
        socket.emit("stream/auth", { data: { password } });
      });
      socket.on("connect_error", () => reject(new Error("Daemon stream connection failed")));
      socket.on("disconnect", () => reject(new Error("Daemon stream disconnected")));
      socket.on("stream/auth", (packet: any) => {
        if (packet?.data !== true) return reject(new Error("Daemon stream auth failed"));
        // From here on, events are routed to subscribers
        stream.attach();
        stream.requestStatus(deps.connectTimeoutMs).then(
          () => resolve(),
          (err) => reject(err)
        );
      });
    });
    return stream;
  } catch (err) {
    stream.close();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
