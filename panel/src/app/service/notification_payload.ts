import { createHmac } from "crypto";
import { v4 } from "uuid";
import { NotificationEventType } from "../entity/notification_config";
import { $t } from "../i18n";

// Event payload (version 1), HMAC signing and Discord embed rendering.
// Everything here is pure and has no network or storage access.

export const PAYLOAD_VERSION = 1;
export const MAX_BODY_BYTES = 8 * 1024;
const NAME_MAX = 100;
const ID_MAX = 64;
const TEXT_MAX = 200;

export type NotificationInput = {
  type: Exclude<NotificationEventType, "notification.test">;
  instance?: { daemonId: string; uuid: string; name: string; daemonName?: string };
  group?: { uuid: string; name: string; action: "start" | "stop"; runId: string };
  backup?: {
    id: string;
    name?: string;
    trigger: "manual" | "schedule";
    sizeBytes?: number;
    durationSec?: number;
  };
  details?: Record<string, unknown>;
};

export interface NotificationEvent {
  version: 1;
  id: string;
  type: NotificationEventType;
  timestamp: string;
  panel: { name: string };
  instance?: { daemonId: string; uuid: string; name: string; daemonName?: string };
  group?: { uuid: string; name: string; action: "start" | "stop"; runId: string };
  backup?: {
    id: string;
    name?: string;
    trigger: "manual" | "schedule";
    sizeBytes?: number;
    durationSec?: number;
  };
  details: Record<string, unknown>;
}

// Strip control characters and cut to `max` code points.
function clean(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const noCtl = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  const chars = Array.from(noCtl);
  return chars.length > max ? chars.slice(0, max).join("") : noCtl;
}

// Payloads must not carry file system paths: replace anything that looks like one.
function redactPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"']*/g, "[path]")
    .replace(/\\\\[^\s"']+/g, "[path]")
    .replace(/(?:^|(?<=[\s("'=:]))(?:\/[\w.@+~-]+){2,}\/?/g, "[path]");
}

function nonNegInt(value: unknown): number | undefined {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

function sanitizeDetails(details: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {};
  if (!details || typeof details !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(details)) {
    if (count >= 20) break;
    if (!/^[A-Za-z0-9_]{1,30}$/.test(key)) continue;
    if (typeof value === "string") out[key] = redactPaths(clean(value, TEXT_MAX));
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
      else continue;
    } else if (typeof value === "boolean" || value === null) out[key] = value;
    else if (key === "failedStep" && value && typeof value === "object") {
      const step = value as Record<string, unknown>;
      const failedStep: Record<string, string> = {};
      if (step.instanceName !== undefined) failedStep.instanceName = clean(step.instanceName, NAME_MAX);
      failedStep.reason = redactPaths(clean(step.reason ?? "", TEXT_MAX));
      out[key] = failedStep;
    } else continue;
    count++;
  }
  return out;
}

export interface BuildOptions {
  panelName: string;
  id?: string;
  now?: number;
}

export function buildEvent(
  input: Omit<NotificationInput, "type"> & { type: NotificationEventType },
  options: BuildOptions
): NotificationEvent {
  const event: NotificationEvent = {
    version: PAYLOAD_VERSION,
    id: options.id ?? v4(),
    type: input.type,
    timestamp: new Date(options.now ?? Date.now()).toISOString(),
    panel: { name: clean(options.panelName, 40) },
    details: sanitizeDetails(input.details)
  };
  if (input.instance) {
    event.instance = {
      daemonId: clean(input.instance.daemonId, ID_MAX),
      uuid: clean(input.instance.uuid, ID_MAX),
      name: clean(input.instance.name, NAME_MAX)
    };
    if (input.instance.daemonName)
      event.instance.daemonName = clean(input.instance.daemonName, NAME_MAX);
  }
  if (input.group) {
    event.group = {
      uuid: clean(input.group.uuid, ID_MAX),
      name: clean(input.group.name, NAME_MAX),
      action: input.group.action === "stop" ? "stop" : "start",
      runId: clean(input.group.runId, ID_MAX)
    };
  }
  if (input.backup) {
    const b: NonNullable<NotificationEvent["backup"]> = {
      id: clean(input.backup.id, ID_MAX),
      trigger: input.backup.trigger === "schedule" ? "schedule" : "manual"
    };
    if (input.backup.name) b.name = clean(input.backup.name, NAME_MAX);
    const size = nonNegInt(input.backup.sizeBytes);
    const dur = nonNegInt(input.backup.durationSec);
    if (size !== undefined) b.sizeBytes = size;
    if (dur !== undefined) b.durationSec = dur;
    event.backup = b;
  }
  return enforceSizeLimit(event);
}

function byteLength(event: NotificationEvent) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function shrinkStrings(event: NotificationEvent, limit: number) {
  const cut = (s: string) => clean(s, limit);
  event.panel.name = cut(event.panel.name);
  if (event.instance) {
    event.instance.name = cut(event.instance.name);
    if (event.instance.daemonName) event.instance.daemonName = cut(event.instance.daemonName);
  }
  if (event.group) event.group.name = cut(event.group.name);
  if (event.backup?.name) event.backup.name = cut(event.backup.name);
  for (const [k, v] of Object.entries(event.details)) {
    if (typeof v === "string") event.details[k] = cut(v);
    else if (v && typeof v === "object") {
      const step = v as Record<string, string>;
      for (const sk of Object.keys(step)) step[sk] = cut(step[sk]);
    }
  }
}

// Truncate string fields progressively until the serialized body fits the cap.
function enforceSizeLimit(event: NotificationEvent): NotificationEvent {
  for (const limit of [100, 50, 25, 10, 0]) {
    if (byteLength(event) <= MAX_BODY_BYTES) return event;
    shrinkStrings(event, limit);
  }
  return event;
}

/** Serialize once; the caller signs and sends these exact bytes. */
export function serializeEvent(event: NotificationEvent): Buffer {
  return Buffer.from(JSON.stringify(event), "utf8");
}

/**
 * HMAC-SHA256 over `<timestamp>.` + raw body bytes, keyed with the secret as UTF-8 text.
 * `tsSec` must be the exact decimal string that is sent in X-Minefield-Timestamp.
 */
export function signBody(secret: string, tsSec: string | number, body: Buffer): string {
  const ts = String(tsSec);
  const hmac = createHmac("sha256", Buffer.from(secret, "utf8"));
  hmac.update(Buffer.from(`${ts}.`, "ascii"));
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Discord embed

type Translate = (key: string, params?: Record<string, any>) => string;

const COLORS = {
  red: 0xe74c3c,
  green: 0x2ecc71,
  grey: 0x95a5a6,
  orange: 0xe67e22,
  blue: 0x3498db
};

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 10 };

// Escape markdown and neutralise mentions in user-controlled names.
export function escapeDiscord(text: string): string {
  return text
    .replace(/([\\*_~`>|<\[\]()])/g, "\\$1")
    .replace(/@/g, "@​")
    .replace(/#/g, "#​");
}

function cutTo(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : text;
}

function keyOf(prefix: string, type: string) {
  return `TXT_CODE_notification.${prefix}_${type.replace(".", "_")}`;
}

function formatDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function colorFor(event: NotificationEvent): number {
  switch (event.type) {
    case "instance.crashed":
    case "backup.failed":
    case "group.run_failed":
      return COLORS.red;
    case "instance.started":
    case "backup.succeeded":
      return COLORS.green;
    case "group.run_finished":
      return event.details.result === "cancelled" ? COLORS.grey : COLORS.green;
    case "instance.stopped":
      return COLORS.grey;
    case "instance.auto_restarted":
      return COLORS.orange;
    default:
      return COLORS.blue; // notification.test, group.run_started
  }
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  fields: { name: string; value: string; inline?: boolean }[];
}

export function renderDiscordEmbed(event: NotificationEvent, t: Translate = $t): DiscordEmbed {
  const d = event.details;
  const subject =
    event.instance?.name ?? event.group?.name ?? event.backup?.name ?? event.panel.name;
  const fields: DiscordEmbed["fields"] = [];
  const add = (nameKey: string, value: unknown, inline = true) => {
    if (value === undefined || value === null || value === "") return;
    fields.push({
      name: cutTo(t(`TXT_CODE_notification.field_${nameKey}`), LIMITS.fieldName),
      value: cutTo(escapeDiscord(String(value)), LIMITS.fieldValue),
      inline
    });
  };
  const yesNo = (v: unknown) =>
    t(v ? "TXT_CODE_notification.yes" : "TXT_CODE_notification.no");

  if (event.instance) {
    add("instance", event.instance.name);
    add("node", event.instance.daemonName);
  }
  if (event.group) {
    add("group", event.group.name);
    add("action", event.group.action);
  }
  if (typeof d.exitCode === "number") add("exitCode", d.exitCode);
  if (typeof d.willAutoRestart === "boolean") add("willAutoRestart", yesNo(d.willAutoRestart));
  if (typeof d.attempt === "number") {
    const max =
      typeof d.maxAttempts === "number" ? String(d.maxAttempts) : t("TXT_CODE_notification.unlimited");
    add("attempt", `${d.attempt} / ${max}`);
  }
  if (event.backup) {
    add("trigger", event.backup.trigger);
    if (event.backup.sizeBytes !== undefined) add("size", formatSize(event.backup.sizeBytes));
    if (event.backup.durationSec !== undefined)
      add("duration", formatDuration(event.backup.durationSec));
  }
  if (typeof d.memberCount === "number") add("members", d.memberCount);
  if (typeof d.result === "string") add("result", d.result);
  if (event.group && typeof d.durationSec === "number") add("duration", formatDuration(d.durationSec));
  if (typeof d.reason === "string") add("reason", d.reason, false);
  const step = d.failedStep as { instanceName?: string; reason?: string } | undefined;
  if (step && typeof step === "object")
    add("failedStep", [step.instanceName, step.reason].filter(Boolean).join(": "), false);
  if (typeof d.message === "string") add("message", d.message, false);
  if (typeof d.suppressedBefore === "number") add("suppressed", d.suppressedBefore);

  return {
    title: cutTo(t(keyOf("title", event.type)), LIMITS.title),
    description: cutTo(t(keyOf("desc", event.type), { name: escapeDiscord(subject) }), LIMITS.description),
    color: colorFor(event),
    timestamp: event.timestamp,
    fields: fields.slice(0, LIMITS.fields)
  };
}

export function buildDiscordPayload(event: NotificationEvent, t: Translate = $t) {
  return {
    username: cutTo(event.panel.name, 80),
    allowed_mentions: { parse: [] as string[] },
    embeds: [renderDiscordEmbed(event, t)]
  };
}
