# Proposal

## Why

The operator runs a Discord community for the Minefield network and has their own Discord bot (Python, discord.py) on a different server than the panel. Today nobody learns that an instance crashed, that a backup failed, or that a group start finished unless they are looking at the panel. The operator wants the panel to push selected events to Discord. The integration is notifications only: nothing in Discord can command the panel, so the panel gains no new inbound attack surface.

## What Changes

- New admin-only "Notifications" settings section: enable/disable, sink type, target URL, shared secret (generate/rotate), per-event toggles, an optional list of excluded instances, a "send test notification" button, and the last delivery status.
- Two sink types sharing the same event toggles:
  - `bot_http`: the panel POSTs a versioned JSON event to an HTTPS URL on the operator's bot (a small aiohttp endpoint), signed with HMAC-SHA256 using a panel-generated shared secret.
  - `discord_webhook`: the panel POSTs a formatted embed straight to a Discord channel webhook URL (no bot needed).
- Selectable events: instance crashed (unexpected exit), instance started, instance stopped, instance auto-restarted after a crash, backup succeeded, backup failed, group run started, group run finished, group run failed. A test event is always available.
- The daemon pushes instance lifecycle events to the panel over the existing authenticated panel-to-daemon socket (new event `instance/lifecycle`). The panel is the single sender: it owns the configuration, the secret, and all daemons. Group runs (from `instance-groups`) and backups (from `instance-backups`, designed in parallel) emit through a small panel-internal function.
- Delivery is best effort and never blocks instance operations: bounded in-memory queue (200), 10 s request timeout, retries with backoff, drop-oldest when full, per-instance flood coalescing. The queue is not persisted.
- Outbound requests are SSRF-hardened: URL validation, DNS resolution with the validated address pinned for the connection, private/loopback/link-local ranges blocked unless the admin explicitly allows private addresses, no redirects, secrets masked in API responses and never logged.
- A ready-to-use receiver guide `docs/discord-bot-receiver.md` with a Python aiohttp + discord.py receiver that verifies the signature and timestamp and renders an embed per event type.

## Capabilities

### New Capabilities

- `notifications`: Admin-configured outbound notifications for instance lifecycle, backup, and group-run events to a Discord bot endpoint or Discord webhook, including event selection, signing, delivery guarantees, and outbound-request safety.

### Modified Capabilities

(none: existing requirements of `instance-management`, `user-management`, and the instance-groups change are unchanged; the new capability only observes their outcomes.)

## Impact

- `daemon/src/entity/instance/instance.ts` (classify and emit lifecycle notifications), a small daemon notifier that sends only to authenticated panel sockets, `daemon/src/routers/auth_router.ts` (track authenticated panel sockets) and the shutdown path (suppress events while the daemon is shutting down).
- `panel/src/app/service/` (notification service, sender, config), `panel/src/app/routers/notification_router.ts`, `panel/src/app/utils/` (outbound URL guard), `panel/src/app/entity/remote_service.ts` (subscribe to `instance/lifecycle`), a one-line hook in the group runner. New persisted record `data/NotificationConfig/config.json` holds a secret and, for webhooks, a token-bearing URL, so it is a sensitive file.
- `frontend/src/widgets/Settings.vue` plus a new notifications component, API service, and i18n keys.
- `docs/discord-bot-receiver.md`, `AGENTS.md` sensitive-files list gets the new data file.
- No new npm dependencies (Node `https`, `crypto`, `dns`, `net.BlockList`). RAM impact is a queue of at most 200 small objects plus one timer.
- Compatibility: older daemons never send `instance/lifecycle`, so instance events are absent for them until upgraded; group and backup events are unaffected. Other changes depend on the contract here: `instance-groups` calls the panel emit function when a run starts or ends, and `instance-backups` calls it for backup results.
