# Design

## Context

Instance groups already persist a per-owner ordered membership and run state. The mini console and full terminal target the same daemon and instance identifiers.

## Goals / Non-Goals

Keep the restart in the existing group runner and share shortcut controls between both consoles. Runs are manual and held in panel memory.

## Decisions

- Store warning offsets and the template on the group. Accept 1 to 10 unique integer offsets between 1 and 3600 seconds and sort descending. Strip controls and Unicode line separators before validating the message length. Reject shell operator characters in the template. Replace the literal `{seconds}` token at dispatch.
- Use daemon batch status with an opt-in type field. Use the daemon-configured type to select Paper and Purpur commands. Velocity and other types skip console commands. Check status again before saving and use a running-only option on automated command requests.
- Add the `warned-restart` action to the existing runner. Hold its normal concurrency slot throughout. Compute one deadline, expose it while warning, and reuse the step runner for the ordered stop and start phases. Fail on status lookup or command request errors instead of proceeding into lifecycle steps with incomplete preparation.
- Persist complete shortcut lists atomically through panel storage. Key them by a hash of the daemon and instance pair, the ownership boundary used by panel assignments. Administrators replace the list and each replacement receives new shortcut IDs so stale buttons cannot run a different command. Read and run require current instance access. Run accepts an ID only.
- Use `POST /api/instance_group/warned-restart?id=...`, existing cancel and run endpoints, and `GET` and `PUT /api/protected_instance/console_shortcuts` plus `POST /api/protected_instance/console_shortcuts/run`, scoped by `daemonId` and `uuid`.

## Risks / Trade-offs

Command delivery acknowledges the existing command path. The server controls when it completes a save. A panel shutdown ends the in-memory countdown. Older group records acquire defaults on load.
