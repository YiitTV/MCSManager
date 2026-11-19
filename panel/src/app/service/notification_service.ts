import {
  EventType,
  EVENT_TYPES,
  NotificationConfig
} from "../entity/notification_config";
import { getNotificationConfig } from "./notification_config_service";
import { logger } from "./log";
import {
  buildEvent,
  NotificationEvent,
  NotificationInput
} from "./notification_payload";
import { sendEvent, SendResult } from "./notification_sender";

export type { NotificationInput } from "./notification_payload";

export const QUEUE_CAPACITY = 200;
export const RETRY_DELAYS_SEC = [5, 30, 120];
export const COALESCE_MAX = 6;
export const COALESCE_WINDOW_MS = 60_000;
export const COALESCE_MAX_KEYS = 1000;
export const TEST_MIN_INTERVAL_MS = 5_000;

export interface NotificationStatus {
  queued: number;
  sent: number;
  failed: number;
  dropped: number;
  last?: { at: number; type: string; ok: boolean; error?: string; httpStatus?: number };
}

interface QueueItem {
  event: NotificationEvent;
  attempt: number; // number of attempts already made
  nextAttemptAt: number;
}

export interface TestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

type Sender = (event: NotificationEvent, config: NotificationConfig) => Promise<SendResult>;

export class NotificationService {
  private queue: QueueItem[] = [];
  private inFlight: QueueItem | null = null;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = 0;
  private stats = { sent: 0, failed: 0, dropped: 0 };
  private last: NotificationStatus["last"];
  private windows = new Map<string, { times: number[]; suppressed: number }>();
  private lastSweep = 0;
  private lastTestAt = 0;
  private testing = false;

  constructor(
    private readonly getConfig: () => NotificationConfig = getNotificationConfig,
    private readonly sender: Sender = (e, c) => sendEvent(e, c)
  ) {}

  /** Synchronous and never throws; a notification problem must never affect the caller. */
  emit(input: NotificationInput): void {
    try {
      this.doEmit(input);
    } catch (err: any) {
      try {
        logger.warn(`Notification emit failed: ${err?.name ?? "error"}`);
      } catch {}
    }
  }

  private doEmit(input: NotificationInput) {
    const config = this.getConfig();
    if (!config.enabled || !config.url) return;
    if (!(EVENT_TYPES as readonly string[]).includes(input.type)) return;
    if (!config.events[input.type as EventType]) return;
    // Exclusions cover events that carry an instance; group events are not affected.
    if (input.instance && !input.type.startsWith("group.")) {
      if (config.excludedInstances.includes(`${input.instance.daemonId}::${input.instance.uuid}`))
        return;
    }

    const now = Date.now();
    let suppressedBefore = 0;
    if (input.instance) {
      const verdict = this.coalesce(`${input.instance.daemonId}::${input.instance.uuid}`, now);
      if (verdict === "drop") return;
      suppressedBefore = verdict;
    }

    const details = suppressedBefore > 0 ? { ...input.details, suppressedBefore } : input.details;
    const event = buildEvent({ ...input, details }, { panelName: config.panelName, now });
    this.enqueue({ event, attempt: 0, nextAttemptAt: now });
    this.pump();
  }

  // Returns "drop" or the number of events suppressed since the last accepted one.
  private coalesce(key: string, now: number): "drop" | number {
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w) {
      w = { times: [], suppressed: 0 };
      this.windows.set(key, w);
      if (this.windows.size > COALESCE_MAX_KEYS) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined && oldest !== key) this.windows.delete(oldest);
      }
    }
    w.times = w.times.filter((t) => now - t < COALESCE_WINDOW_MS);
    if (w.times.length >= COALESCE_MAX) {
      w.suppressed++;
      return "drop";
    }
    w.times.push(now);
    const n = w.suppressed;
    w.suppressed = 0;
    return n;
  }

  // Lazily remove windows that have emptied (at most once per second).
  private sweep(now: number) {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) {
      w.times = w.times.filter((t) => now - t < COALESCE_WINDOW_MS);
      if (w.times.length === 0 && w.suppressed === 0) this.windows.delete(key);
    }
  }

  private enqueue(item: QueueItem) {
    this.queue.push(item);
    while (this.queue.length > QUEUE_CAPACITY) {
      this.queue.shift();
      this.stats.dropped++;
    }
  }

  // Start the worker if idle: pick the first ready item, or re-arm the single timer.
  private pump() {
    if (this.inFlight) return;
    const now = Date.now();
    const idx = this.queue.findIndex((i) => i.nextAttemptAt <= now);
    if (idx < 0) {
      this.armTimer();
      return;
    }
    const [item] = this.queue.splice(idx, 1);
    this.inFlight = item;
    void this.deliver(item);
  }

  private armTimer() {
    if (this.queue.length === 0) {
      this.clearTimer();
      return;
    }
    const at = Math.min(...this.queue.map((i) => i.nextAttemptAt));
    if (this.timer && this.timerAt === at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = 0;
  }

  private async deliver(item: QueueItem) {
    let result: SendResult;
    try {
      const config = this.getConfig();
      if (!config.enabled || !config.url) {
        // Disabled while queued: drop silently.
        this.stats.dropped++;
        this.inFlight = null;
        this.pump();
        return;
      }
      result = await this.sender(item.event, config);
    } catch {
      result = { ok: false, error: "network", retryable: true };
    }
    this.inFlight = null;

    const at = Date.now();
    if (result.ok) {
      this.stats.sent++;
      this.last = { at, type: item.event.type, ok: true, httpStatus: result.status };
    } else if (result.retryable && item.attempt < RETRY_DELAYS_SEC.length) {
      const base = RETRY_DELAYS_SEC[item.attempt];
      const delaySec =
        result.retryAfterSec !== undefined ? Math.min(result.retryAfterSec, 120) : base;
      this.enqueue({
        event: item.event,
        attempt: item.attempt + 1,
        nextAttemptAt: at + Math.max(delaySec, 1) * 1000
      });
    } else {
      this.stats.failed++;
      this.last = {
        at,
        type: item.event.type,
        ok: false,
        error: result.error,
        httpStatus: result.status
      };
    }
    this.pump();
  }

  /** One attempt, no retry, bypasses toggles and the queue. Rate limited. */
  async sendTest(): Promise<TestResult> {
    const config = this.getConfig();
    if (!config.enabled || !config.url) return { ok: false, error: "not_configured" };
    const now = Date.now();
    if (this.testing || now - this.lastTestAt < TEST_MIN_INTERVAL_MS)
      return { ok: false, error: "rate_limited" };
    this.testing = true;
    this.lastTestAt = now;
    try {
      const event = buildEvent(
        { type: "notification.test", details: { message: "Test notification" } },
        { panelName: config.panelName }
      );
      const r = await this.sender(event, config);
      this.last = {
        at: Date.now(),
        type: event.type,
        ok: r.ok,
        error: r.error,
        httpStatus: r.status
      };
      return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: r.error };
    } catch {
      return { ok: false, error: "network" };
    } finally {
      this.testing = false;
    }
  }

  getStatus(): NotificationStatus {
    return {
      queued: this.queue.length + (this.inFlight ? 1 : 0),
      sent: this.stats.sent,
      failed: this.stats.failed,
      dropped: this.stats.dropped,
      ...(this.last ? { last: { ...this.last } } : {})
    };
  }

  /** Clear queue, timer and windows (tests, shutdown). */
  reset() {
    this.clearTimer();
    this.queue = [];
    this.inFlight = null;
    this.windows.clear();
    this.stats = { sent: 0, failed: 0, dropped: 0 };
    this.last = undefined;
    this.lastTestAt = 0;
    this.testing = false;
  }
}

const service = new NotificationService();
export default service;

/** Panel-internal emit API (groups, backups, lifecycle). Sync, never throws. */
export function emitNotification(input: NotificationInput): void {
  service.emit(input);
}

// ---------------------------------------------------------------------------
// Daemon lifecycle message

const KIND_TO_TYPE = {
  started: "instance.started",
  stopped: "instance.stopped",
  crashed: "instance.crashed",
  auto_restarted: "instance.auto_restarted"
} as const;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a daemon `instance/lifecycle` packet `data` and emit the matching event.
 * Anything malformed is ignored. Returns whether an event was emitted (for tests).
 */
export function onDaemonLifecycle(
  daemonId: string,
  daemonName: string | undefined,
  data: unknown,
  target: Pick<NotificationService, "emit"> = service
): boolean {
  try {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    if (typeof d.instanceUuid !== "string" || d.instanceUuid.length < 1 || d.instanceUuid.length > 64)
      return false;
    if (typeof d.instanceName !== "string" || d.instanceName.length > 256) return false;
    const kind = d.kind;
    if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(KIND_TO_TYPE, kind))
      return false;
    const type = KIND_TO_TYPE[kind as keyof typeof KIND_TO_TYPE];

    const exitCode = d.exitCode === undefined || d.exitCode === null ? null : d.exitCode;
    if (exitCode !== null && !isInt(exitCode)) return false;

    let details: Record<string, unknown> = {};
    if (kind === "stopped") details = { exitCode };
    else if (kind === "crashed") {
      if (d.willAutoRestart !== undefined && typeof d.willAutoRestart !== "boolean") return false;
      details = { exitCode, willAutoRestart: d.willAutoRestart === true };
    } else if (kind === "auto_restarted") {
      if (!isInt(d.attempt) || d.attempt < 0 || d.attempt > 1_000_000) return false;
      const max = d.maxAttempts === undefined ? null : d.maxAttempts;
      if (max !== null && !isInt(max)) return false;
      details = { attempt: d.attempt, maxAttempts: max };
    }

    target.emit({
      type,
      instance: {
        daemonId,
        uuid: d.instanceUuid,
        name: d.instanceName,
        ...(daemonName ? { daemonName } : {})
      },
      details
    });
    return true;
  } catch {
    return false;
  }
}
