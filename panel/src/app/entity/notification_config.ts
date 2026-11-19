import { randomBytes } from "crypto";
import { OutboundSinkType, validateOutboundUrl } from "../utils/outbound_url";

export const MASKED_SECRET = "__MCSM_SECRET_DATA__";

export const EVENT_TYPES = [
  "instance.crashed",
  "instance.started",
  "instance.stopped",
  "instance.auto_restarted",
  "backup.succeeded",
  "backup.failed",
  "group.run_started",
  "group.run_finished",
  "group.run_failed"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type NotificationEventType = EventType | "notification.test";

export const SINK_TYPES: OutboundSinkType[] = ["bot_http", "discord_webhook"];
export const MAX_EXCLUDED_INSTANCES = 200;
export const MAX_PANEL_NAME_LENGTH = 40;
export const DEFAULT_PANEL_NAME = "Minefield Panel";

function defaultEvents() {
  const events = {} as Record<EventType, boolean>;
  for (const t of EVENT_TYPES) events[t] = false;
  return events;
}

// Persisted as its own record `NotificationConfig/config` (never part of SystemConfig, which is
// returned by GET /overview/setting). Contains secrets: never log it.
export class NotificationConfig {
  enabled: boolean = false;
  sinkType: OutboundSinkType = "bot_http";
  url: string = "";
  secret: string = "";
  allowPrivateAddress: boolean = false;
  panelName: string = DEFAULT_PANEL_NAME;
  events: Record<EventType, boolean> = defaultEvents();
  excludedInstances: string[] = [];
}

export type NotificationConfigErrorCode =
  | "invalid_body"
  | "invalid_field"
  | "unknown_event"
  | "too_many_exclusions"
  | "invalid_exclusion"
  | "panel_name"
  | "url_required";

export class NotificationConfigError extends Error {
  constructor(
    public readonly code: NotificationConfigErrorCode,
    public readonly field?: string
  ) {
    super(code);
    this.name = "NotificationConfigError";
  }
}

export function generateSecret() {
  return randomBytes(32).toString("hex");
}

export function cloneConfig(cfg: NotificationConfig): NotificationConfig {
  const copy = new NotificationConfig();
  copy.enabled = cfg.enabled;
  copy.sinkType = cfg.sinkType;
  copy.url = cfg.url;
  copy.secret = cfg.secret;
  copy.allowPrivateAddress = cfg.allowPrivateAddress;
  copy.panelName = cfg.panelName;
  copy.events = { ...cfg.events };
  copy.excludedInstances = [...cfg.excludedInstances];
  return copy;
}

export interface MaskedNotificationConfig {
  enabled: boolean;
  sinkType: OutboundSinkType;
  url: string;
  secret: string;
  allowPrivateAddress: boolean;
  panelName: string;
  events: Record<EventType, boolean>;
  excludedInstances: string[];
}

// Response shape: secret and the webhook URL (it contains a token) are masked when set.
export function maskConfig(cfg: NotificationConfig): MaskedNotificationConfig {
  return {
    enabled: cfg.enabled,
    sinkType: cfg.sinkType,
    url: cfg.sinkType === "discord_webhook" && cfg.url ? MASKED_SECRET : cfg.url,
    secret: cfg.secret ? MASKED_SECRET : "",
    allowPrivateAddress: cfg.allowPrivateAddress,
    panelName: cfg.panelName,
    events: { ...cfg.events },
    excludedInstances: [...cfg.excludedInstances]
  };
}

const EXCLUDED_RE = /^[A-Za-z0-9_-]{1,64}::[A-Za-z0-9_-]{1,64}$/;

/**
 * Merge a PUT body into the current config (pure). Returns a new config and the names of changed
 * fields (values are never reported). The masked placeholder keeps the stored url. `secret` is
 * managed only through rotation, so any `secret` in the body is ignored. Syntax of the URL is
 * validated here (throws OutboundUrlError); DNS resolution is the caller's job.
 */
export function applyConfigUpdate(
  current: NotificationConfig,
  body: unknown
): { config: NotificationConfig; changed: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new NotificationConfigError("invalid_body");
  const input = body as Record<string, unknown>;
  const next = cloneConfig(current);

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new NotificationConfigError("invalid_field", "enabled");
    next.enabled = input.enabled;
  }
  if (input.sinkType !== undefined) {
    if (typeof input.sinkType !== "string" || !SINK_TYPES.includes(input.sinkType as any))
      throw new NotificationConfigError("invalid_field", "sinkType");
    next.sinkType = input.sinkType as OutboundSinkType;
  }
  if (input.url !== undefined) {
    if (typeof input.url !== "string") throw new NotificationConfigError("invalid_field", "url");
    if (input.url !== MASKED_SECRET) next.url = input.url.trim();
  }
  if (input.allowPrivateAddress !== undefined) {
    if (typeof input.allowPrivateAddress !== "boolean")
      throw new NotificationConfigError("invalid_field", "allowPrivateAddress");
    next.allowPrivateAddress = input.allowPrivateAddress;
  }
  if (input.panelName !== undefined) {
    if (typeof input.panelName !== "string") throw new NotificationConfigError("invalid_field", "panelName");
    const name = input.panelName.trim();
    if (name.length < 1 || name.length > MAX_PANEL_NAME_LENGTH)
      throw new NotificationConfigError("panel_name");
    next.panelName = name;
  }
  if (input.events !== undefined) {
    const ev = input.events;
    if (!ev || typeof ev !== "object" || Array.isArray(ev))
      throw new NotificationConfigError("invalid_field", "events");
    for (const [key, value] of Object.entries(ev as Record<string, unknown>)) {
      if (!(EVENT_TYPES as readonly string[]).includes(key))
        throw new NotificationConfigError("unknown_event");
      if (typeof value !== "boolean") throw new NotificationConfigError("invalid_field", "events");
      next.events[key as EventType] = value;
    }
  }
  if (input.excludedInstances !== undefined) {
    const list = input.excludedInstances;
    if (!Array.isArray(list)) throw new NotificationConfigError("invalid_field", "excludedInstances");
    if (list.length > MAX_EXCLUDED_INSTANCES) throw new NotificationConfigError("too_many_exclusions");
    for (const item of list) {
      if (typeof item !== "string" || !EXCLUDED_RE.test(item))
        throw new NotificationConfigError("invalid_exclusion");
    }
    next.excludedInstances = Array.from(new Set(list as string[]));
  }

  // The private-address option applies to bot_http only.
  if (next.url) {
    validateOutboundUrl(next.url, {
      sinkType: next.sinkType,
      allowPrivate: next.sinkType === "bot_http" && next.allowPrivateAddress
    });
  }
  if (next.enabled && !next.url) throw new NotificationConfigError("url_required");

  const changed: string[] = [];
  for (const key of ["enabled", "sinkType", "url", "allowPrivateAddress", "panelName"] as const) {
    if (next[key] !== current[key]) changed.push(key);
  }
  if (JSON.stringify(next.events) !== JSON.stringify(current.events)) changed.push("events");
  if (JSON.stringify(next.excludedInstances) !== JSON.stringify(current.excludedInstances))
    changed.push("excludedInstances");
  return { config: next, changed };
}
