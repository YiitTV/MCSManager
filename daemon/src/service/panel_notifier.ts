import { broadcast } from "./authenticated_sockets";

let shuttingDown = false;

// Mark that the daemon is exiting: instance exits caused by it are not crashes.
export function setDaemonShuttingDown(value = true) {
  shuttingDown = value;
}

export function isDaemonShuttingDown() {
  return shuttingDown;
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
  broadcast("instance/lifecycle", data);
}
