## 1. Crash insights

- [ ] 1.1 Capture, securely read, parse, and persist crash history. Cover realistic Paper fixtures, bounded input, and path confinement. Run `cd daemon && npm test` with the approved test scope.
- [x] 1.2 Expose authorized history and show it on the instance page and cards. Run `cd panel && npm test` with the approved test scope and frontend type check and tests.

## 2. Drive restore

- [x] 2.1 Add Drive source selection and make the latest completion result available through jobs. Run focused backup tests via `npm test` in common, daemon, and panel.
- [x] 2.2 Show Drive copy, restore progress and outcome, and add English, Chinese, and Turkish text. Run `cd frontend && npm run type-check && npm test`.

## 3. Verification

- [x] 3.1 Validate the change and run `npm run build` in panel and daemon. Record any verification limits.

## Verification in this worktree

- Frontend type check and 274 tests passed. The successful test run was serial with Vitest's results cache disabled for the shared read-only dependency directory.
- Focused suites passed in common (186), daemon (56), and panel (33). The daemon and panel webpack builds and strict OpenSpec validation passed.
- The daemon's separate in-process lifecycle check did not pass. The startup fixture timed out waiting for `READY:` with both the changed and the original instance implementation. A Docker socket was unavailable. Task 1.1 remains open for the lifecycle gate.
- The common real daemon/panel integration runner was excluded as requested. The Drive-only restore test uses a fake Drive driver and exercises the restore queue and archive extraction.
