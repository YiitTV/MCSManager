# Tasks

## 1. Panel data model, validation, and persistence

- [x] 1.1 Add `panel/src/app/entity/instance_group.ts` with the `InstanceGroup` types and constants (limits 20/30/40/200/5/4096/8 runs, defaults). Verify it compiles with `cd panel && npm run build`, then `cd panel && npm test`.
- [x] 1.2 Add the ready-pattern helper (`*` wildcard, ANSI stripping, line truncation, carry buffer) in `panel/src/app/service/instance_group_matcher.ts` with unit tests for `Done (*)!`, colour codes, long lines, regex-looking text, and a pathological line that must finish quickly. Verify with `cd panel && npm test`.
- [x] 1.3 Add `panel/src/app/service/instance_group_service.ts`: load all groups at start into a per-owner map, create/update/delete through `Storage.getStorage().store("InstanceGroup", ...)`, per-group write serialisation, validation (name, members, uniqueness, stop-order permutation, timeouts, delay <= timeout, pattern), limits, and drop groups whose owner no longer exists. Add unit tests with a stub storage covering each limit and validation scenario from the spec. Verify with `cd panel && npm test`.
- [x] 1.4 Add the member authorisation function (owner exists and `isHaveInstanceByUuid`) and a list-view builder that returns unassigned members as `unavailable` without name or status. Unit test with an admin, an assigned user, and an unassigned user. Verify with `cd panel && npm test`.

## 2. Daemon status batch

- [x] 2.1 Add the read-only `instance/status_batch` event to `daemon/src/routers/Instance_router.ts` (at most 30 uuids, returns uuid, nickname, status; unknown uuids omitted; reject non-array or oversized input). Add a unit test and run `cd daemon && npm test`.
- [x] 2.2 Because `Instance_router.ts` changed, run the `mcsmanager-test` skill suites (daemon lifecycle plus `cd common && npm test` integration runner) and confirm they pass.

## 3. Panel API (CRUD, listing, authorisation)

- [x] 3.1 Add `panel/src/app/routers/instance_group_router.ts` with `GET /list`, `POST /create`, `PUT /update`, `DELETE /delete` (all `ROLE.USER`, owner-filtered, not-found for others' groups, validator on every input) and register it in the router index. Member status resolution calls `instance/status_batch` once per daemon, falling back to `unknown` on error. Verify with `cd panel && npm run build && npm test`.
- [x] 3.2 Add the integration suite `common/test/integration/suites/instance_groups.test.ts` (using the `lib` helpers as in `security_instance.test.ts`) covering: create/list/update/delete as admin and as a regular user; regular user cannot add an unassigned instance (403, nothing stored); tampered ids, duplicates, bad order lists, and over-limit counts rejected; user B cannot read or modify user A's group; admin sees only own groups; unassigning an instance later makes the member `unavailable` with no name. Verify with `cd common && npm run test:integration` (or the filtered suite) and `cd panel && npm test`.

## 4. Orchestration

- [x] 4.1 Add `panel/src/app/service/daemon_event_stream.ts`: open a per-instance daemon stream client (passport register, `stream/auth`, `stream/detail`), expose typed events (stdout, opened, stopped, failure, detail), a 10 s connect timeout, and a `close()` that removes listeners and disconnects. Leave `terminal_bridge.ts` unchanged. Unit test with a fake socket (auth failure, timeout, close cleanup). Verify with `cd panel && npm test`.
- [x] 4.2 Add `panel/src/app/service/instance_group_runner.ts`: the run map, one-run-per-group check done before any await, global cap of 8, step loop for start (modes `pattern`, `running`, `delay`, already-running skip) and stop (stopped wait, already-stopped skip), per-step authorisation, timeouts, fail-fast on failure/exit, cancel via `AbortController`, `finally` cleanup, 10 minute retention timer, and operation-log entries. Unit tests with fake stream and remote request for: ordered start, ordered stop with a different order, each advance mode, timeout stops the sequence with later members untouched, instance exits during delay, unassigned member refused with no command sent, unassignment between steps, cancel, concurrent start conflict, global cap, and no listeners or timers left after each outcome. Verify with `cd panel && npm test`.
- [x] 4.3 Add `POST /start`, `POST /stop`, `POST /cancel`, `GET /run` to the router (ignore request bodies, 409 on active run, 429 at the cap) and make `DELETE /delete` and `PUT /update` of members return conflict while a run is active. Verify with `cd panel && npm run build && npm test`.
- [x] 4.4 Extend `instance_groups.test.ts` with real-daemon runs: create three instances whose start command prints a `Done (0.1s)!` line after a short delay, assert start order from timestamps and the stop order on stop; a never-ready instance fails with timeout (use the minimum timeout) and leaves later instances stopped; unassigned member skipped and reported; second start returns 409; cancel works; a regular user cannot start another user's group. Verify with `cd common && npm run test:integration` and `cd panel && npm test`.

## 5. Frontend groups page

- [x] 5.1 Add `frontend/src/services/apis/instanceGroup.ts` (typed API definitions for the endpoints) and `frontend/src/hooks/useInstanceGroups.ts` (load groups, mutate, start/stop/cancel, run polling every 2 s only while a run is active, stop polling on terminal state and on unmount). Unit test the polling lifecycle with fake timers. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 5.2 Add `InstanceGroups.vue` (vertical stack) and `InstanceGroupCard.vue` (header with Start group and Stop group, member rows with name and status, per-step progress, cancel, disabled buttons during a run, unavailable members shown muted), the route `/instance-groups`, and a menu entry for all logged-in users. Add a component test for layout, disabled state, and progress rendering. Verify with `cd frontend && npm run type-check && npm test` and a screenshot of the page in light and dark themes.
- [x] 5.3 Add `InstanceGroupEditor.vue`: name, member picker from the existing instance listing, up/down arrows for start order and stop order (optional drag-and-drop), advance mode radio with pattern, delay, and the two timeouts, client-side validation mirroring server limits. Add a component test for reorder and validation. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 5.4 Add i18n keys for all new UI text and server error messages to `languages/en_US.json`, `zh_CN.json`, and `tr_TR.json` (backend errors use `{{name}}` placeholders, frontend `{name}`; do not run the rewriting scanner without reviewing its diff). Verify with `cd frontend && npm run type-check && npm test` and `cd panel && npm test`.

## 6. Mini console

- [x] 6.1 Add `scrollback`, `renderer`, and `compact` options to `useTerminal.ts` with defaults that keep the full terminal page unchanged, and a unit test proving defaults are unchanged and the options are applied. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 6.2 Add `useMiniConsoles.ts` (store with the cap of 4, open/close/minimise/focus order) and `MiniConsole.vue` plus `MiniConsoleHost.vue` (title bar drag clamped to the viewport, minimise, close, xterm body with 1000-line scrollback, command input disabled when stopped, forbidden and error states). Closing disposes the terminal and disconnects the socket; leaving the page closes all. Component tests: open, cap refusal, drag clamp, minimise and restore, close disconnects, command sent. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 6.3 Wire the open-console control into the member rows and add the mini console i18n keys (en_US, zh_CN, tr_TR). Verify manually with a local run: open two consoles, drag, minimise, send `list`, close, and confirm the socket closes in the browser network panel; then `cd frontend && npm run type-check && npm run lint && npm test`.

## 7. Final verification

- [x] 7.1 Run all suites with the `mcsmanager-test` skill (`common`, `daemon`, `panel`, `frontend`, plus `npm run test:integration`) and `cd frontend && npm run type-check && npm run lint`; confirm all pass.
- [x] 7.2 Run the panel and daemon webpack builds (`cd panel && npm run build`, `cd daemon && npm run build`) and a manual end-to-end check as a regular user: unassign an instance mid-group and confirm it is refused and reported; measure panel RSS during an eight-instance run and confirm it does not grow after the run ends.

## Workflow follow-up

- Archive with `/openspec-archive-change` after review and merge.
