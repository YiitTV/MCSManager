import { Socket } from "socket.io";
import logger from "./log";
import { Packet } from "./protocol";

// Pushes small notification packets to the panel only.
// Only sockets that completed the top-level `auth` are tracked, so unauthenticated sockets
// and stream sockets never receive them (unlike `protocol.broadcast`).
const panelSockets = new Set<Socket>();

let shuttingDown = false;

export function registerPanelSocket(socket: Socket) {
  if (panelSockets.has(socket)) return;
  panelSockets.add(socket);
  socket.once("disconnect", () => {
    panelSockets.delete(socket);
  });
}

export function unregisterPanelSocket(socket: Socket) {
  panelSockets.delete(socket);
}

export function panelSocketCount() {
  return panelSockets.size;
}

// Mark that the daemon is exiting: instance exits caused by it are not crashes.
export function setDaemonShuttingDown(value = true) {
  shuttingDown = value;
}

export function isDaemonShuttingDown() {
  return shuttingDown;
}

// Synchronous, never throws.
export function notifyPanels(event: string, data: any) {
  try {
    if (panelSockets.size === 0) return;
    const packet = new Packet(null, 200, event, data);
    for (const socket of Array.from(panelSockets)) {
      if (!socket.connected) {
        panelSockets.delete(socket);
        continue;
      }
      try {
        socket.emit(event, packet);
      } catch (err: any) {
        logger.debug(`panel notifier emit failed: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    logger.debug(`panel notifier failed: ${err?.message ?? err}`);
  }
}

export type InstanceLifecycleKind = "started" | "stopped" | "crashed" | "auto_restarted";

export interface IInstanceLifecycle {
  instanceUuid: string;
  instanceName: string;
  kind: InstanceLifecycleKind;
  at: number;
  exitCode: number | null;
  willAutoRestart?: boolean;
  attempt?: number;
  maxAttempts?: number | null;
}

export function notifyInstanceLifecycle(data: IInstanceLifecycle) {
  notifyPanels("instance/lifecycle", data);
}
