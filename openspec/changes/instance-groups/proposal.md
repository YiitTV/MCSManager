# Proposal

## Why

Operators of multi-server networks (for example a Minecraft network with a lobby, a main server, and a Velocity proxy) must start and stop several instances in a strict order, and today they do it one instance at a time through separate pages. The admin-only `multi_open` / `multi_stop` endpoints fire all instances at once with no ordering and no readiness check, so a proxy can start before its backends. The team also wants to watch several consoles side by side without leaving the page. Every user of this panel (admins and trusted staff) should be able to do this for the instances they are allowed to operate.

## What Changes

- Users can create named **instance groups**: an ordered collection of instances they are allowed to operate. Groups are per-user (each user owns and sees only their own groups).
- A new **Instance groups** page shows groups stacked vertically. Each group is a card with a header holding **Start group** and **Stop group** buttons, followed by one row per member showing the instance name and status.
- Each group has an editable **start order** and a separate editable **stop order** (up/down arrows; drag-and-drop where available).
- **Ordered start** advances to the next instance by one of three per-group modes: console output matches a ready pattern (default `Done (*)!`), the instance reports running, or a fixed delay in seconds. Every wait has a timeout (default 180 s); on timeout or failure the sequence stops and reports which step failed. **Ordered stop** waits for each instance to reach stopped before stopping the next, with a timeout; it never force-kills automatically.
- Group runs report per-step progress to the UI and can be cancelled. Only one run per group may be active.
- Each member row can open a **mini console**: a small floating, draggable, minimisable window with live output and a command input, using the existing instance stream channel. Several can be open at once (capped), each with a bounded scrollback, and each closes its stream when closed.
- Server-side authorisation is enforced per instance on every group action. Nothing the client sends is trusted: assignments are re-checked when saving, when starting or stopping, and before each step of a run.
- Resource limits protect the small-RAM deployment: at most 20 groups per user, 30 instances per group, 8 concurrent group runs panel-wide, 4 open mini consoles per browser tab.

## Capabilities

### New Capabilities

- `instance-groups`: Per-user instance groups, their start/stop ordering and advance modes, ordered start/stop orchestration with progress, timeout, cancellation and concurrency rules, per-instance authorisation, and resource limits. The mini console is kept separate because it is a purely client-side viewing/command surface that does not depend on groups and could later be opened from other pages.
- `instance-mini-console`: Floating, draggable, minimisable consoles that show live instance output and accept commands over the existing instance stream, with a scrollback cap, an open-window cap, and stream cleanup.

### Modified Capabilities

(none)

## Impact

- `panel/src/app/`: new `entity/instance_group.ts`, `service/instance_group_service.ts` (persistence, validation, limits), `service/instance_group_runner.ts` (orchestration, daemon event stream helper, matcher), `routers/instance_group_router.ts`, registration in the router index. Reuses `Storage.getStorage().store("InstanceGroup", ...)`, `isHaveInstanceByUuid`, `RemoteRequest`, and the operation logger.
- `daemon/src/routers/Instance_router.ts`: one new read-only event `instance/status_batch` (uuid, nickname, status for at most 30 instances). No change to instance lifecycle code.
- `frontend/src/`: new `views`/`widgets` for the group page and editor, a `hooks/useInstanceGroups.ts`, `services/apis/instanceGroup.ts`, a mini console component and manager store, a small option set added to `useTerminal.ts` (compact mode, scrollback, renderer), route and menu entry.
- `languages/`: new `TXT_CODE_` keys in `en_US.json`, `zh_CN.json`, and `tr_TR.json` (other locales fall back to English).
- New data: `panel/data/InstanceGroup/<uuid>.json` (non-sensitive). No change to user, instance, or daemon config formats; no migration needed. Memory cost is small: groups are tiny JSON records, runs are in-memory records with a bounded lifetime, and a run holds at most one daemon stream connection at a time.
