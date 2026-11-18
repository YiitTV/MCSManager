# Design

## Context

- Instances live on daemons; the panel authorises users per instance with `isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)` (administrators pass automatically, regular users need an entry in `user.instances`). `instance_operate_router.ts` applies this check in a router-wide middleware to every `/protected_instance/*` call, including `open`, `stop`, and `stream_channel`.
- `instance_admin_router.ts` has admin-only `multi_open` / `multi_stop`. They fire all instances in parallel through `multiOperationForwarding`, with no ordering, no readiness check, and no result.
- Daemon status values: `STATUS_STOP=0`, `STOPPING=1`, `STARTING=2`, `RUNNING=3`, `BUSY=-1`. The daemon emits `open`, `exit`, `failure`, and `data` events and forwards them as `instance/opened`, `instance/stopped`, `instance/failure`, and `instance/stdout` to sockets that authenticated on the per-instance stream channel (`passport/register` with name `stream_channel`, then `stream/auth`). `terminal_bridge.ts` already shows the panel acting as such a stream client to a daemon.
- The daemon has `instance/detail` (heavy: runs process info) and `instance/select` (paged list with full config). Neither is a cheap batch status call.
- The panel persists JSON models through `Storage.getStorage().store(category, uuid, obj)` (file, or Redis when configured). Sensitive-file rules do not apply to groups.
- The browser terminal is `useTerminal.ts`: `stream_channel` request, socket.io client, xterm with WebGL or Canvas renderer.
- The deployment budget is about 1 GB RAM for OS, panel, and daemon together, so no new long-lived per-instance resources.
- `docs/integration-test-framework.md`, referenced by AGENTS.md, is not present in the repo at the time of writing. Integration tests follow the helpers in `common/test/integration/lib` and the suites `security_instance.test.ts` and `streams.test.ts`.

## Goals / Non-Goals

**Goals:**
- Per-user ordered groups with start and stop orders, three advance modes, timeouts, progress, cancellation.
- Authorisation re-checked server-side on every action and every step.
- Reuse the existing stream channel for both orchestration events and mini consoles; add no new transport.
- Minimal memory: no polling loops on the server, no persistent per-instance subscriptions, bounded in-memory state.

**Non-Goals:**
- Shared or team-wide groups, group-level permissions, or assigning groups to users.
- Persisting or resuming runs across panel restarts.
- Per-member advance settings, restart-group, kill-on-timeout, scheduled group actions.
- Regular-expression ready patterns.
- Changes to user roles, instance assignment, or daemon lifecycle code.

## Decisions

### 1. Orchestration runs in the panel

The panel owns the run. For each step it authorises the owner, sends the existing daemon `instance/open` or `instance/stop` through `RemoteRequest`, and waits for the daemon event it needs through a short-lived stream client to that daemon (the same passport and socket.io client flow as `terminal_bridge.ts`).

*Why:* the panel holds the user identity and assignment data, can span instances on different daemons (a group may mix nodes), and needs no new daemon state or protocol. The stream channel is already confined to one instance by its passport, so an event subscription cannot see other instances.

*Alternatives:*
- **Daemon-side orchestration.** Closer to the process and could read output without a socket, but a group can span daemons, so a daemon cannot own the whole sequence; it would also need user assignment data and a new run protocol. Rejected.
- **Frontend-driven sequence** (browser calls open, then waits, then calls the next). No server change, but the sequence dies if the tab closes and timing depends on the browser. Rejected.
- **Polling `instance/detail`.** Simple but costs a process-info command per poll. Rejected in favour of events.

The stream-client connect code is extracted into a small helper `daemon_event_stream.ts` used by the runner. `terminal_bridge.ts` is left unchanged to avoid regressions in proxy mode; consolidating it is a possible follow-up.

### 2. Per-user ownership

Each group has an `ownerUuid`. All reads and writes filter by the authenticated user; a lookup by id for another user's group returns not-found (no existence leak). Administrators see only their own groups.

*Why:* the simplest model whose authorisation is easy to reason about: the effective permission of a group is exactly the owner's instance assignment, re-evaluated at use time. A shared model would need rules for members that some viewers cannot operate.

*Alternative:* shared groups visible to all, with per-member filtering. Rejected as more surface for leaks (names of instances a viewer cannot see) with no stated need. When a user is deleted, their groups are dropped at panel start (owner not found) and when the user is deleted if a hook is available.

### 3. Data model

Stored under category `InstanceGroup`, one record per group at `data/InstanceGroup/<uuid>.json`, loaded into an in-memory map indexed by `ownerUuid` at panel start. The records are tiny (at most 30 members).

```ts
interface InstanceGroup {
  uuid: string;            // group id
  ownerUuid: string;       // user uuid
  name: string;            // 1..40 chars
  members: { daemonId: string; instanceUuid: string }[];   // start order, max 30, unique
  stopOrder: string[];     // "<daemonId>::<instanceUuid>" keys, permutation of members
  advance: {
    mode: "pattern" | "running" | "delay";   // default "pattern"
    pattern: string;       // default "Done (*)!", <= 200 chars, <= 5 "*"
    delaySec: number;      // 0..3600, used when mode = "delay", default 15
    startTimeoutSec: number; // 5..3600, default 180
    stopTimeoutSec: number;  // 5..3600, default 180
  };
  createdAt: number;
  updatedAt: number;
}
```

No display data (names, status) is stored; it is resolved at read time from the daemon so renames and deletions are reflected and a client cannot forge it. Limits: 20 groups per user, 30 members per group. Writes use a per-group promise chain so concurrent updates apply in order.

### 4. HTTP API

New router `instance_group_router.ts`, prefix `/instance_group` (served as `/api/instance_group/...`). All endpoints require `permission({ level: ROLE.USER })` and operate only on the caller's groups. Instance authorisation is by `isHaveInstanceByUuid` against the group's stored members, never against client-sent lists.

| Method | Path | Params | Purpose |
|---|---|---|---|
| GET | `/list` | none | Caller's groups with resolved member name and status (unauthorised members returned as `unavailable`) |
| POST | `/create` | body: name, members, stopOrder?, advance? | Create a group; validates every member |
| PUT | `/update` | query `id`; body: name?, members?, stopOrder?, advance? | Replace fields; revalidates members |
| DELETE | `/delete` | query `id` | Delete a group (fails with conflict while a run is active) |
| POST | `/start` | query `id` | Begin ordered start; returns `{ runId }`; 409 if a run is active, 429 if 8 runs are active |
| POST | `/stop` | query `id` | Begin ordered stop; same responses |
| POST | `/cancel` | query `id` | Cancel the active run |
| GET | `/run` | query `id` | State of the active or latest run (or `null`) |

Member status resolution: the panel groups the caller's authorised members by daemon and sends one new daemon event `instance/status_batch` (`{ instanceUuids }`, at most 30) per daemon, returning `{ instanceUuid, nickname, status }` for each. If a daemon does not know the event (older version) or is offline, those members are returned with status `unknown`. This adds one small read-only handler to `daemon/src/routers/Instance_router.ts` and nothing else on the daemon.

Mini consoles need no new API: they call the existing `POST /api/protected_instance/stream_channel`, whose router-wide middleware already enforces assignment.

### 5. Run state and progress reporting

A run is an in-memory record in a `Map<groupId, Run>` (at most one per group, so the map is bounded by the number of groups):

```ts
interface Run {
  runId: string; groupId: string; ownerUuid: string; action: "start" | "stop";
  state: "running" | "succeeded" | "failed" | "cancelled";
  steps: { key: string; state: "pending" | "waiting" | "done" | "skipped" | "failed"; reason?: string }[];
  startedAt: number; finishedAt?: number;
}
```

The frontend polls `GET /run` every 2 s only while the group shows an active run; polling stops when the state is terminal. Finished runs are removed from memory 10 minutes after finishing (a single `setTimeout` per run, cleared on removal).

*Alternatives:* a socket.io event channel from the panel. In direct data-plane mode the browser does not connect to the panel's socket server, so it would need a second transport; polling a tiny JSON object at 0.5 Hz during a run is cheaper and simpler. Server-sent events were rejected for the same reason of extra surface.

### 6. Step algorithm and event waiting

For each member in the relevant order, the runner:
1. Re-checks that the owner exists and passes `isHaveInstanceByUuid`; otherwise marks the step `failed: not permitted`, sends nothing, and stops the run.
2. Opens a daemon stream client for that instance (passport + `stream/auth`) **before** sending the command, so no early output line or event is missed, and takes the current status from the stream's `stream/detail` reply (sent by the daemon after auth).
3. Start: if status is running, mark `skipped` and continue. Otherwise send `instance/open` and wait per mode:
   - `pattern`: wait for an `instance/stdout` line matching the pattern.
   - `running`: wait for `instance/opened` (the daemon emits `open` when it sets status running).
   - `delay`: one `setTimeout(delaySec)`; afterwards confirm status via `stream/detail` that the instance is still running.
   In all modes `instance/failure` or `instance/stopped` fails the step at once.
   Stop: if status is stopped, mark `skipped`. Otherwise send `instance/stop` and wait for `instance/stopped`.
4. A second timer (`startTimeoutSec` or `stopTimeoutSec`) bounds the wait. On timeout the step is `failed: timeout`, the run fails, and nothing further is touched. No kill is issued.
5. In a `finally`, clears timers, removes listeners, and disconnects the stream client, then proceeds to the next step.

The `delay` mode uses the delay timer plus the timeout only as a safety bound (timeout shorter than the delay is rejected at validation: `startTimeoutSec >= delaySec`). Operation-log entries are written with the same `operationLogger.log("instance_start"/"instance_stop", ...)` calls as the single-instance routes.

Cancel sets a flag and aborts the current wait through an `AbortController`, which triggers the same `finally` cleanup.

### 7. Concurrency and restart

`Map<groupId, Run>` gives the one-run-per-group rule: `start`/`stop` check the map synchronously before awaiting anything, so two simultaneous requests cannot both pass. A global counter caps active runs at 8. Runs are never persisted: on panel restart the map is empty, no sequence resumes, and already started instances keep running (documented in the UI help text). On panel shutdown the process exit releases sockets; no extra handling is required.

### 8. Ready pattern matching

Plain text with a `*` wildcard instead of a regex: split the pattern on `*` into literal segments and match them in order with `indexOf` (first segment anchored by position only when the pattern does not start with `*`; matching is a "contains" search, so `Done (*)!` matches anywhere in the line). This is linear in line length and cannot backtrack. Limits: pattern at most 200 characters, at most 5 wildcards, lines truncated to 4096 characters, partial-line carry buffer capped at 8 KB, ANSI escape sequences stripped first. The default `Done (*)!` covers Paper, Spigot, Purpur, and Velocity ("Done (1.2s)!").

*Alternatives:* user regex with a timeout or a safe-regex library (new dependency, still risky); plain substring only (cannot express `Done (` ... `)!` because of the variable time). Rejected.

### 9. Frontend

- A new full-width page `InstanceGroups.vue` (route `/instance-groups`, menu entry visible to all logged-in users) rather than a dashboard card, since the vertical stack needs the full width. State is in a composable `useInstanceGroups.ts`; one section per group is a `InstanceGroupCard.vue`; the editor is a dialog `InstanceGroupEditor.vue` with up/down arrow buttons for both orders (drag-and-drop is optional polish using native HTML drag events, no new dependency).
- The member picker reuses the existing instance listing APIs, which already return only what the user may see; the server re-validates regardless.
- Mini console: `MiniConsole.vue` (title bar with name, status dot, minimise and close; xterm body; input line) hosted by a `MiniConsoleHost.vue` and a small store `useMiniConsoles.ts` that enforces the cap of 4. Dragging uses pointer events and clamps to the viewport. It reuses `useTerminal.ts` for `stream_channel`, socket, and stdout handling, with new options: `scrollback` (1000), `renderer: "canvas"` (the WebGL context limit makes WebGL unsuitable for several windows), and `compact` (no touch controls). Closing calls the hook's existing disconnect and `terminal.dispose()`. Minimised windows keep their stream (and capped scrollback) so output is not lost.
- All strings go through `t()` with `TXT_CODE_` keys, added to `en_US.json`, `zh_CN.json`, and `tr_TR.json` in this change; other locales fall back to English.

## Risks / Trade-offs

- [Unassigned instance still in a group] → The server re-checks at list, save, start, stop, and before every step; unauthorised members are shown as unavailable with no name and are never operated.
- [Group ids or members tampered by clients] → Ownership filter on every lookup, member validation on every write, run targets taken only from the stored group.
- [Ready line never printed, e.g. a custom server] → Per-step timeout fails the run visibly; users can switch to `running` or `delay` mode.
- [Panel restart mid-sequence] → Not resumed; partial progress is visible from instance statuses. Accepted for simplicity and memory.
- [Daemon event stream adds load] → One stream client at a time per run, at most 8 runs, closed after each step; no standing subscriptions.
- [Mini consoles use browser memory] → Cap of 4 windows, 1000-line scrollback, canvas renderer, streams closed on close and on page leave.
- [Older daemon lacks `instance/status_batch`] → Statuses show as unknown; start and stop still work because they use existing events. Upgrade nodes together with the panel.
- [Panel-side status and event ordering races] → Stream is opened before the command is sent and status is taken from the authenticated stream's detail reply.

## Migration Plan

1. Deploy panel, daemon, and frontend from the same build. No data migration: with no `InstanceGroup` records the feature is empty.
2. Rollback: deploy the previous build. `data/InstanceGroup/` is ignored by older versions and can be deleted or left in place.
3. Enable no flags; the page is available to all users after upgrade.

## Open Questions

- Should the group page also appear as a dashboard card in the layout editor later? Deferred; it does not affect specs or tasks.
