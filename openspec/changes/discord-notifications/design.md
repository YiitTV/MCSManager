# Design

## Context

Observed in the repository:

- **Daemon events.** `Instance` (`daemon/src/entity/instance/instance.ts`) emits `open` from `started()`, `exit` from `stopped(code)`, and `failure`; `InstanceSubsystem` re-emits them with `{ instanceUuid, instanceName }` and `instance_event_router.ts` forwards them only to per-instance stream sockets (`forEachForward`). Status values: `STOPPED=0, STOPPING=1, STARTING=2, RUNNING=3, BUSY=-1`. `general_stop` sets `STOPPING` and calls `ignoreEventTaskOnce()`; `general_kill` calls `ignoreEventTaskOnce()` (sets `config.eventTask.ignore = true`). `stopped()` runs the auto-restart branch (`execPreset("start")`, `autoRestartCount++`, bounded by `autoRestartMaxTimes`) and resets `eventTask.ignore` at its end. So an exit is expected if `instanceStatus === STOPPING` or `eventTask.ignore === true` when `stopped()` begins; everything else (status `RUNNING`/`STARTING`) is a crash.
- **Daemon to panel push.** The panel holds one authenticated socket.io client per daemon (`RemoteService.socket`, entity `panel/src/app/entity/remote_service.ts`) and mostly uses request/response (`RemoteRequest`). The daemon already has `protocol.broadcast(event, obj)` (sends to every connected socket, currently unused) and packets are `{ uuid: null, status: 200, event, data }`. A daemon socket is trusted as the panel only after the `auth` event (`ctx.session.type === "TOP_LEVEL"`, `loginSuccessful`); stream sockets (browsers in direct data-plane mode, panel stream clients) are separate sessions of type `STREAM`. `broadcast` also reaches unauthenticated sockets, so it MUST NOT be used as is.
- **Panel storage and secrets.** `Storage.getStorage().store(category, uuid, obj)` (file or Redis). `GET /overview/setting` returns the whole `systemConfig`, so a secret placed in `SystemConfig` would leak; users already mask secrets with `"__MCSM_SECRET_DATA__"` and ignore that value on update (`manage_user_router.ts`, `user_service.ts`).
- **Existing SSRF guard.** `daemon/src/utils/url.ts` `resolveSafeUrl` resolves a host, refuses private addresses, and returns the validated address to pin through Axios' `lookup` (`download_manager.ts`). It rejects IP literals, `localhost`, single-label hosts, and `http` is allowed; it lives in the daemon package and cannot express an "allow private" option. The panel has no equivalent.
- **Groups.** `instance_group_runner.ts` owns run state (`running | succeeded | failed | cancelled`, steps with reasons, `startedAt`, `finishedAt`) and is being implemented now. `instance-backups` is designed in parallel and does not exist yet.
- **Memory budget.** OS + panel + daemon together stay near 1 GB: no new dependencies and no unbounded structures.

## Goals / Non-Goals

**Goals:**
- Admin chooses which events reach Discord; works with the operator's own off-box Python bot and, optionally, with a plain Discord webhook.
- Notifications only: no inbound command path from Discord.
- Never block or fail an instance, group, or backup operation because of notification problems.
- Safe by construction: admin-only config, SSRF-hardened outbound calls, secrets masked and never logged.
- A clear shared contract so daemon, panel, frontend, docs, and tests can be built in parallel.

**Non-Goals:**
- Commands or two-way control from Discord.
- Persisting the queue, delivery guarantees across panel restarts, or exactly-once semantics (receivers dedupe by `id` if they care).
- Per-user notification subscriptions, or non-Discord sinks (the sink type is an enum so more can be added later).
- Notifying about events while a daemon is disconnected from the panel (no replay).
- Translating payload `details` for bots; payloads are machine data.

## Decisions

### 1. Transport and sink types: support both, one shared event pipeline

Two sink types behind one `NotificationSink` interface (`send(event) -> {ok, status?, error?}`), selected by `sinkType`: `bot_http` and `discord_webhook`. Event selection, queueing, retries, coalescing, and exclusion are shared; only serialization and URL rules differ.

`bot_http`: HTTPS POST of the versioned JSON event to the admin's URL, signed with HMAC-SHA256 (algorithm below). The bot hosts a tiny aiohttp endpoint and posts to Discord with discord.py, so formatting, mentions, and channels stay under the operator's control and the Discord bot token never touches the panel.

`discord_webhook`: panel formats one embed per event and POSTs it directly to a Discord webhook. It costs about 60 lines on top of the shared pipeline and needs no hosting.

*Alternatives:*
- **Only `bot_http`.** Smallest surface, but the operator needs a running bot just to try notifications. Rejected as the only option.
- **Only `discord_webhook`.** Simplest, but cannot reach the operator's existing bot and gives the bot no structured data. Rejected as the only option.
- **Panel runs a Discord bot (discord.js) itself.** Heavy dependency and token on the panel host, against the RAM budget and the stated architecture. Rejected.
- **Bot connects to the panel (WebSocket/pull).** Needs an inbound listener and auth on the panel, contradicting the notifications-only, no-new-inbound-surface goal. Rejected.

For the webhook the URL contains a token, so it is treated as a secret (masked in API responses, never logged) and restricted to Discord hosts and the `/api/webhooks/<id>/<token>` path, which also removes SSRF risk for that sink.

### 2. Where events originate: daemon pushes lifecycle, panel is the single sender

Instance lifecycle knowledge (crash vs stop, auto-restart attempts) only exists in the daemon, while the configuration, secret, node list, group runs, and backups are in the panel. So the daemon pushes small lifecycle messages to the panel and the panel sends to Discord.

- The daemon keeps a `Set` of sockets that completed top-level `auth` (added in `auth_router.ts` after `loginSuccessful`, removed on `disconnect`). A new `notifyPanels(event, data)` sends only to that set. This avoids the unauthenticated-socket exposure of `protocol.broadcast`.
- Panel `RemoteService.connect()` registers `socket.on("instance/lifecycle", ...)` and forwards a validated copy to `notificationService.onDaemonLifecycle(daemonId, data)`. Re-registration on reconnect follows the existing listener lifecycle (listeners are removed in `disconnect()`).
- The daemon always emits (a few small packets per event, no config on the daemon); the panel filters. This keeps the daemon stateless and avoids config sync.

*Alternatives:*
- **Panel opens a per-instance stream client for every instance** (as the group runner does for one instance at a time). Standing subscriptions for every instance cost memory and sockets and can miss events on reconnect. Rejected.
- **Panel polls instance status.** Cannot see exit codes or distinguish crashes and costs process-info commands per poll. Rejected.
- **Each daemon sends to Discord.** Duplicates config and the secret on every node, and the daemon cannot know group runs or backups. Rejected.

Daemon classification, computed at the very start of `Instance.stopped(code)` before `eventTask.ignore` is reset and before the auto-restart branch:

```
expected = (status === STOPPING) || (config.eventTask.ignore === true) || daemonShuttingDown
kind     = expected ? "stopped" : "crashed"
```

`daemonShuttingDown` is a module flag set when `InstanceSubsystem.exit` / `softExit` or the signal handler begins, so terminating instances on daemon exit produces no notifications. `crashed` carries `willAutoRestart = autoRestart && !ignore && (max == -1 || count < max)`; the daemon then runs the existing auto-restart branch unchanged. Just before it calls `execPreset("start")` it records `pendingAutoRestart = { attempt: count + 1, max }`. On the next `open` the daemon emits `auto_restarted` (consuming the flag) instead of `started`; if the start fails the flag is cleared. `started` is emitted from `started()` otherwise. `exitCode` is the numeric exit code or `null`.

### 3. Delivery: bounded queue, one worker, delayed retries, coalescing

```
emit(input) -> filter(enabled, sink, toggle, exclusion) -> coalesce(per instance) -> enqueue
worker: one in flight; picks the first item whose nextAttemptAt <= now
```

- Queue capacity 200 items. When full, drop the oldest and `stats.dropped++`.
- One worker means at most one outbound connection and preserves roughly chronological order. Retries are not slept inside the worker: a failed item gets `nextAttemptAt = now + delay` and stays in the queue (so retries count against capacity), and a single re-armed `setTimeout` wakes the worker at the earliest `nextAttemptAt`. A stuck sink therefore cannot delay other ready events.
- Attempts: the initial attempt plus 3 retries after 5 s, 30 s, and 120 s. Retry on network error, timeout, 5xx, 408, 429 (using `Retry-After`, capped at 120 s). Other 4xx are permanent. After the last failure the event is dropped and `stats.failed++`.
- Request timeout 10 s total (connect plus response); at most 2 KB of response read; the socket is destroyed after.
- Coalescing: per instance key `daemonId::uuid`, keep the timestamps of the last sent events in a small array; if 6 were queued within 60 s, drop the event and increment `suppressed[key]`; the next accepted event for that key carries `details.suppressedBefore = n` and resets the counter. Map entries are removed once their window empties (swept lazily at emit time, plus a cap of 1000 keys). Group, backup (without instance), and test events are exempt.
- The queue is not persisted: a restart loses pending events. This is documented in the settings help text and the receiver doc. Persisting would add disk writes and replay duplicates for little value on a best-effort notification channel.
- `emit` is synchronous, wrapped in try/catch, and returns void so callers cannot be slowed or broken.

### 4. SSRF and secret handling

New panel utility `panel/src/app/utils/outbound_url.ts`:

`validateOutboundUrl(rawUrl, { allowPrivate, sinkType })` (save time, no network for syntax) and `resolveOutboundTarget(...)` (send time) apply:
- Length at most 512, parsed with `new URL`, no `username`/`password`, no fragment dependence.
- `discord_webhook`: scheme `https`, host in the Discord allowlist, path regex `^/api/webhooks/\d{5,25}/[A-Za-z0-9_-]{20,120}$`; private option is ignored.
- `bot_http`: scheme `https`. `http` is permitted only when `allowPrivate` is true and every resolved address is private (a bot on a LAN or the same host). Port 1-65535.
- Resolve with `dns.lookup(host, { all: true, verbatim: true })` (IP literals are classified directly). Classification uses `net.BlockList` with: IPv4 `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4`; IPv6 `::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96` and `64:ff9b::/96` (mapped or embedded IPv4 is re-classified). If `allowPrivate` is false and any answer is blocked, the target is refused. If `allowPrivate` is true no range is blocked (the admin accepted the risk), but `http` still requires the private address condition above.
- Connect with Node `https.request`/`http.request`, passing `lookup: (host, opts, cb) => cb(null, validatedAddress, family)` so the connection uses the exact validated address while TLS SNI and certificate checks still use the hostname. `maxRedirects` is not applicable (no redirect-following client). TLS verification stays on; no option to disable it.
- Validation runs at save and again before every attempt (a hostname's DNS can change).

*Alternatives:* reusing `daemon/src/utils/url.ts` (cross-package, rejects IPs and `http`, no allow-private); moving the helper into `common/` (would touch daemon behavior and force all suites for this change). Chosen: a small panel-local helper mirroring the daemon's pinning approach with stricter ranges; deduplicating into `common` is a possible follow-up and is out of scope. Using Axios (already a panel dependency) was considered, but built-in `https` keeps the pinned `lookup` and response cap simple and needs no behavior surprises such as redirects.

Secrets:
- Config record `NotificationConfig/config` is stored through `Storage.getStorage()`. It holds `secret` (bot) and the webhook `url`. It is added to the sensitive-file list in `AGENTS.md`; never logged.
- `POST /api/notification/secret/rotate` generates `crypto.randomBytes(32).toString("hex")` and returns it once. GET and PUT responses use `"__MCSM_SECRET_DATA__"` for `secret` (when set) and for the webhook `url` (when set); the bot `url` is returned in clear. PUT ignores the placeholder (as `user_service.ts` does).
- Rotation takes effect immediately; the admin must update the bot. A rotation or settings change is written to the operation log as "notification settings changed" without values.
- Logs: sender logs `sinkType`, host, HTTP status, or an error code only (`timeout`, `dns`, `blocked_address`, `tls`, `http_4xx`, `http_5xx`, `network`). Never the URL path, body, headers, or response body.

### 5. Payload schema (version 1)

```jsonc
{
  "version": 1,
  "id": "9b0c...-uuid",            // unique per event, stable across retries
  "type": "instance.crashed",
  "timestamp": "2026-11-18T12:00:00.000Z",
  "panel": { "name": "Minefield Panel" },
  "instance": { "daemonId": "...", "uuid": "...", "name": "Survival", "daemonName": "node-1" },
  "group":    { "uuid": "...", "name": "Network", "action": "start", "runId": "..." },
  "backup":   { "id": "...", "trigger": "manual", "sizeBytes": 123, "durationSec": 12 },
  "details":  { }
}
```

`instance` is present for `instance.*` and `backup.*`; `group` for `group.*`; `backup` for `backup.*`. Types and details:

| type | details |
|---|---|
| `instance.crashed` | `exitCode: number\|null`, `willAutoRestart: boolean` |
| `instance.started` | `{}` |
| `instance.stopped` | `exitCode: number\|null` |
| `instance.auto_restarted` | `attempt: number`, `maxAttempts: number\|null` (null = unlimited) |
| `backup.succeeded` | `{}` (data in `backup`: `id`, `name?`, `trigger: "manual"\|"schedule"`, `sizeBytes`, `durationSec`) |
| `backup.failed` | `reason: string` (at most 200 chars, no paths), `backup` as above with `sizeBytes`/`durationSec` optional |
| `group.run_started` | `memberCount: number` |
| `group.run_finished` | `result: "succeeded"\|"cancelled"`, `memberCount`, `durationSec` |
| `group.run_failed` | `memberCount`, `durationSec`, `failedStep?: { instanceName?: string, reason: string }` (reason is the machine code from the group runner) |
| `notification.test` | `message: string` |

Any event may add `details.suppressedBefore: number`. `panel.name` comes from a configurable `panelName` (default "Minefield Panel", at most 40 chars). All strings are truncated (names 100 chars). Cancelled group runs use `run_finished` with `result: "cancelled"` so the admin gets one "ended" toggle pair; adding a separate cancelled type later is a backward compatible change (new type string, `version` stays 1). Unknown fields MUST be ignored by receivers.

For `discord_webhook` the panel builds `{ username: panel.name, allowed_mentions: { parse: [] }, embeds: [ { title, description, color, timestamp, fields } ] }` from the same event via a pure `renderDiscordEmbed(event)` function. Colors: red crash/failed, green started/succeeded/finished, grey stopped, orange auto-restart, blue test/started group. Strings go through the panel's `$t` using the panel language, with new `TXT_CODE_` keys. Field values are truncated to Discord limits (title 256, description 4096, field value 1024, at most 10 fields) and markdown/mention characters in names are escaped.

### 6. Verification algorithm (shared by panel sender, tests, and receiver doc)

Headers sent by the panel (`bot_http`): `Content-Type: application/json`, `User-Agent: Minefield-Panel-Notifier/1`, `X-Minefield-Timestamp: <unix seconds, integer>`, `X-Minefield-Signature: sha256=<64 lowercase hex>`.

```
body       = UTF-8 bytes of the compact JSON (JSON.stringify, no extra whitespace), <= 8 KB
ts         = floor(now_ms / 1000) as decimal ASCII
message    = ascii(ts) + "." + body            // bytes, not re-serialized JSON
signature  = hex(HMAC_SHA256(key = ascii secret as UTF-8 bytes, message))
```

Receiver MUST:
1. Read the raw body bytes before parsing JSON; reject bodies over 8 KB.
2. Parse `X-Minefield-Timestamp` as an integer; reject (401) if missing, non-numeric, or `abs(now - ts) > 300`.
3. Require header `X-Minefield-Signature` starting with `sha256=`; compute the expected value with the same secret; compare with a constant-time comparison (`hmac.compare_digest`); reject (401) on mismatch.
4. Only then parse JSON; check `version == 1`; ignore unknown `type`s and fields (respond 2xx so the panel does not retry).
5. Optional: keep recently seen `id`s for 10 minutes and ignore duplicates (retries reuse the `id`).
6. Respond 2xx quickly (do the Discord post asynchronously). The panel retries on 5xx, 408, and 429 and does not retry other 4xx, so answer 5xx only for genuine temporary failures.

The secret is the hex string exactly as shown by the panel, used as UTF-8 text (not hex-decoded).

### 7. Settings model and HTTP API contract (admin only)

Stored record (`NotificationConfig`, id `config`):

```ts
interface NotificationConfig {
  enabled: boolean;                       // default false
  sinkType: "bot_http" | "discord_webhook";   // default "bot_http"
  url: string;                            // "" until set
  secret: string;                         // bot_http HMAC secret, "" until rotated
  allowPrivateAddress: boolean;           // default false; bot_http only
  panelName: string;                      // default "Minefield Panel", <= 40
  events: Record<EventType, boolean>;     // all default false
  excludedInstances: string[];            // "<daemonId>::<instanceUuid>", <= 200
}
```

All routes are `permission({ level: ROLE.ADMIN })`, prefix `/notification` (served as `/api/notification/...`), JSON bodies, using the project's standard response wrapper.

| Method | Path | Body / result |
|---|---|---|
| GET | `/config` | `{ enabled, sinkType, url, secret, allowPrivateAddress, panelName, events, excludedInstances, status }` with `secret` and (for webhook) `url` as `"__MCSM_SECRET_DATA__"` when set |
| PUT | `/config` | Same shape, all fields optional; masked placeholders keep stored values; validates URL/limits; returns the GET shape. 400 with a message on validation failure. Unknown event keys are rejected. |
| POST | `/secret/rotate` | `{ secret }` plaintext, once; also works for first generation |
| POST | `/test` | `{ ok: boolean, status?: number, error?: string }`; one attempt, no retry, rate limited with the existing `speedLimit` middleware (1 per 5 s) |

`status` is `{ queued: number, sent: number, failed: number, dropped: number, last?: { at: number, type: string, ok: boolean, error?: string, httpStatus?: number } }` (in-memory since process start). The `events` object keys are the server-defined event catalogue (the nine types); the frontend renders one toggle per key present, so adding a type needs no frontend contract change beyond its label.

Panel-internal emit API (used by group runner and the backup change):

```ts
// panel/src/app/service/notification_service.ts
export type NotificationInput = {
  type: EventType;                         // not "notification.test"
  instance?: { daemonId: string; uuid: string; name: string; daemonName?: string };
  group?: { uuid: string; name: string; action: "start" | "stop"; runId: string };
  backup?: { id: string; name?: string; trigger: "manual" | "schedule"; sizeBytes?: number; durationSec?: number };
  details?: Record<string, unknown>;
};
export function emitNotification(input: NotificationInput): void;   // sync, never throws
```

### 8. Daemon to panel message contract

Event name `instance/lifecycle`, packet `data`:

```ts
{
  instanceUuid: string;
  instanceName: string;          // config.nickname
  kind: "started" | "stopped" | "crashed" | "auto_restarted";
  at: number;                    // ms epoch on the daemon
  exitCode: number | null;       // stopped / crashed
  willAutoRestart?: boolean;     // crashed
  attempt?: number;              // auto_restarted
  maxAttempts?: number | null;   // auto_restarted (null = unlimited)
}
```

The panel validates types and string lengths, ignores anything malformed, and maps `kind` to `instance.started|stopped|crashed|auto_restarted`. `daemonId` is the `RemoteService` uuid; `daemonName` is its remarks. Only the panel emits to Discord, so panel timestamps (`new Date()` at receipt) are used for `timestamp`.

### 9. Group and backup hooks

- Group runner: call `emitNotification` when a run is accepted (`group.run_started`), and when the run reaches a terminal state (`group.run_finished` for `succeeded`/`cancelled`, `group.run_failed` for `failed` with the failing step's machine-coded reason). The hook is placed where the runner already sets terminal state, wrapped so a throw cannot affect the run. Because the group runner is being implemented in another change, this wiring is a separate, last task in the panel group.
- Backups: the `instance-backups` change calls `emitNotification` with `backup.succeeded|failed`. This change defines the shape (above) and ships the function; it does not touch backup code.

### 10. Settings UI

`Settings.vue` uses `LeftMenusPanel` with a `menus` array. Add a "Notifications" menu entry rendering a new `NotificationSettings.vue` (kept out of `Settings.vue` to keep that file from growing), with a composable `useNotificationSettings.ts` and an API module `services/apis/notification.ts`. Sections: master switch; sink type radio; URL input; for `bot_http` a secret row (masked, "Generate/Rotate" with a confirmation, one-time reveal modal with copy) and an "Allow private address" switch with a warning that plain HTTP on a LAN can be observed; event toggles from `config.events` (grouped Instance / Backup / Group); excluded-instances multi-select populated from the existing admin instance list (stores `daemonId::uuid`); Save; Send test; status line (last delivery, counters, queued). Strings use `t()`; keys are added to `en_US.json`, `zh_CN.json`, and `tr_TR.json` as the instance-groups change does. Backend-rendered strings (`renderDiscordEmbed`) use panel `$t` keys in `languages/en_US.json` and `zh_CN.json`.

### 11. Receiver documentation

`docs/discord-bot-receiver.md` ships a minimal, self-contained Python example: an `aiohttp` app with one `POST /minefield` route implementing section 6, an `asyncio.Queue` handing events to a discord.py client that posts an embed per type (colors and titles matching the panel's webhook embeds), deployment notes (reverse proxy with TLS, firewall to the panel IP, clock sync via NTP, secret in an environment variable, 5-minute window), and the delivery semantics (best effort, retries reuse `id`, queue lost on panel restart).

## Risks / Trade-offs

- [Crash misclassification, e.g. process killed by the OS OOM-killer during a stop] → Status `STOPPING` and `eventTask.ignore` are the same signals the daemon already trusts for auto-restart, so notifications and auto-restart agree. Edge cases may produce an extra or missing "stopped" notice; acceptable for a best-effort feed.
- [Admin points the URL at an internal service] → Admin-only setting; private ranges blocked by default with DNS pinning; explicit opt-in switch; no redirects; response not exposed (test returns only a code).
- [Compromised or malicious admin abusing the notifier for port scanning with `allowPrivateAddress`] → Admin already has host-level power via instance commands; the opt-in is explicit and the test endpoint returns only coarse error codes.
- [Notification storm from crash loops] → Per-instance 6/min coalescing, 200-item queue, single worker, drop-oldest.
- [Lost events on panel restart or daemon disconnect] → Documented; notifications are not an audit log (the operation log remains the record).
- [Secret in plaintext in `data/NotificationConfig`] → Needed to sign; same sensitivity class as the node apiKey files; masked in API, never logged, listed in sensitive files.
- [Older daemons lack `instance/lifecycle`] → Instance events absent for them; group and backup events still work. Upgrade nodes with the panel.
- [Unauthenticated daemon sockets seeing lifecycle data] → Push goes only to the authenticated-panel socket set; covered by a daemon test.

## Migration Plan

1. Deploy daemon, panel, and frontend from the same build. No data migration: with no `NotificationConfig` record the feature is disabled and nothing is sent.
2. Operator configures the bot per `docs/discord-bot-receiver.md`, rotates the secret in the panel, pastes it into the bot environment, and uses "Send test".
3. Rollback: deploy the previous build. `data/NotificationConfig/` is ignored by older versions and may be deleted.

## Open Questions

- Should crash notifications also include the last N lines of instance output? Deferred: it risks leaking secrets from game logs and needs a redaction design.
