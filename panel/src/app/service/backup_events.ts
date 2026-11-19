import { EventEmitter } from "node:events";
import { BACKUP_EVENT_NAMES, BackupEventPayload } from "mcsmanager-common";
import { logger } from "./log";

// In-process typed event bus for finished backup jobs (design D12). The notifications change
// subscribes with `backupEvents.on("backup.succeeded" | "backup.failed", handler)`.
// Exactly one event is published per job; payloads never carry secrets, keys, paths or URLs.

type Handler = (payload: BackupEventPayload) => void | Promise<void>;
type EventName = (typeof BACKUP_EVENT_NAMES)[keyof typeof BACKUP_EVENT_NAMES];

class BackupEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on(event: EventName, handler: Handler) {
    this.emitter.on(event, handler);
    return this;
  }

  off(event: EventName, handler: Handler) {
    this.emitter.off(event, handler);
    return this;
  }

  once(event: EventName, handler: Handler) {
    this.emitter.once(event, handler);
    return this;
  }

  /** Publish an event. A failing handler never affects other handlers or the caller. */
  publish(payload: BackupEventPayload) {
    for (const handler of this.emitter.listeners(payload.event) as Handler[]) {
      try {
        const r = handler(payload);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) =>
            logger.warn(`[Backup] event handler failed: ${(err as Error)?.message}`)
          );
        }
      } catch (err) {
        logger.warn(`[Backup] event handler failed: ${(err as Error)?.message}`);
      }
    }
  }

  removeAllListeners() {
    this.emitter.removeAllListeners();
  }
}

export const backupEvents = new BackupEvents();
