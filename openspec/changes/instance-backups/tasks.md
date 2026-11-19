# Tasks

## Parallelization plan

Contract freeze first (Group 0), then Groups A-F run in parallel against the frozen contracts in `design.md` and `common/src/backup.ts`.

| Group | Depends on | Contract it consumes | Can run in parallel with |
|---|---|---|---|
| 0. Shared contracts | none | design.md Contracts | none (do first, small) |
| A. Daemon core: archive, queue, local, index, retention, restore, hook | 0 | types, `backup/*` events | B, C, D, E, F (uses a fake driver interface) |
| B. Daemon S3 uploader | 0 | `Destination driver` interface from 0 | A, C, D, E, F |
| C. Daemon Google Drive uploader | 0 | `Destination driver` interface from 0 | A, B, D, E, F |
| D. Panel config, API, secrets, OAuth, events | 0 | protocol table, API table | A, B, C, E, F (daemon stubbed) |
| E. Frontend | 0 (API table) | panel HTTP API | A, B, C, D (mock API) |
| F. Integration and security tests | A, B, C, D merged | everything | writes fake S3/Drive servers early, runs last |

Group 0 also defines the driver interface `DestinationDriver { test(), put(file, key, onProgress), get(key, destStream), remove(key) }` that A, B, C share.

## 0. Shared contracts

- [x] 0.1 Add `common/src/backup.ts` with the types in design D8 and D12, constants (limits, retention range, presets and default excludes, secret mask marker), and the `DestinationDriver` interface; export from `common/src/index.ts`. Verify with `cd common && npm run build && npm test`, then `cd daemon && npm run build && npm test` and `cd panel && npm run build && npm test` (common change affects both).
- [x] 0.2 Add pure validators in `common` for include paths (no absolute, no `..`, no NUL, length), exclude globs (bounded matcher), retention, ids, and S3 endpoint shape, with unit tests including traversal strings and pathological globs. Verify with `cd common && npm test`.

## 1. Group A: Daemon core (archive, local destination, queue, retention, restore)

- [x] 1.1 Add `daemon/src/service/backup/index_store.ts` (per-instance index via `StorageSubsystem`, 500-record limit, per-instance write serialisation) with unit tests for limits and persistence. Verify with `cd daemon && npm test`.
- [x] 1.2 Add `backup/archiver.ts`: bounded walker, exclude matching, symlink skipping, zip via `archiver` level 1 to a staging file, SHA-256 while writing, `setImmediate` yielding, and `os.setPriority` around the job; path validation through `FileManager`. Unit tests with a temp directory covering excludes, symlink escape, missing paths, and no whole-file buffering (large sparse file). Verify with `cd daemon && npm test`.
- [x] 1.3 Add `backup/queue.ts` (one running job, queue limit 20, cancel, job timeout, progress) and `backup/disk_check.ts` (estimate x 1.2, local max size). Unit tests with fake jobs and fake `statfs`. Verify with `cd daemon && npm test`.
- [x] 1.4 Add `backup/destinations/local.ts` driver and `backup/retention.ts` implementing D10 against the index, with unit tests: keep last N, failed destination does not prune, unknown files untouched, new backup protected. Verify with `cd daemon && npm test`.
- [x] 1.5 Add `backup/minecraft_hook.ts` (`save-off`, `save-all flush`, wait for save-complete line with 60 s timeout, `save-on` in `finally`) with unit tests using a fake instance for success, failure, timeout, cancel, and stopped instance. Verify with `cd daemon && npm test`.
- [x] 1.6 Add `backup/job_runner.ts` tying archive, hook, per-destination upload with retry/backoff, retention, temp cleanup, restart recovery, and `backup/finished` broadcast; and `backup/restore.ts` (sha256 verify, entry and symlink validation, rollback directory). Unit tests with fake drivers for partial failure, all failure, cancel, malicious entries (`../`, absolute, symlink out), and rollback. Verify with `cd daemon && npm test`.
- [x] 1.7 Add `daemon/src/routers/backup_router.ts` (events in design Contracts, input validation, instance existence checks) and the `backup` schedule action in `system_instance_control.ts` (payload validation, `backup/trigger` broadcast, `backup/pending_events` handshake). Because `system_instance_control.ts` changed, run the `mcsmanager-test` skill suites. Verify with `cd daemon && npm run build && npm test`.

## 2. Group B: Daemon S3 uploader

- [x] 2.1 Add `daemon/src/service/backup/destinations/s3_sigv4.ts` (canonical request, signing, path-style and virtual-hosted) with unit tests against AWS published SigV4 test vectors. Verify with `cd daemon && npm test`.
- [x] 2.2 Add `destinations/s3.ts` implementing `DestinationDriver`: multipart with one 8 MiB (16 MiB for huge files) buffer, abort on failure, `HeadObject`, `DeleteObject`, ranged `GetObject` stream, key generation from uuid/plan/backup ids, error sanitization, DNS-pinned connection via `resolveSafeUrl` (or the private-network path from D7). Unit tests with an in-process HTTP mock for success, retry on 503, abort on failure, key safety, private endpoint refusal, and rebind pinning. Verify with `cd daemon && npm test`.

## 3. Group C: Daemon Google Drive uploader

- [x] 3.1 Add `destinations/gdrive_auth.ts` (refresh-token grant and service-account JWT with `crypto`, in-memory token cache per job, hardcoded Google hosts) with unit tests against a fake token endpoint (injected base URL for tests only). Verify with `cd daemon && npm test`.
- [x] 3.2 Add `destinations/gdrive.ts` implementing `DestinationDriver`: folder create/lookup, resumable upload in 8 MiB chunks with offset recovery, list restricted to the folder, delete by recorded file id, download stream for restore, error sanitization. Unit tests with a fake Drive server for chunking, 308/5xx recovery, 429 backoff, and deletion limited to recorded ids. Verify with `cd daemon && npm test`.

## 4. Group D: Panel

- [x] 4.1 Add `panel/src/app/service/backup_secret.ts` (AES-256-GCM, key file creation with mode 0600, mask and unmask helpers) with unit tests for round trip, tamper detection, masking, and key never in output. Verify with `cd panel && npm test`.
- [x] 4.2 Add `entity/backup.ts` use and `service/backup_service.ts`: destination and plan CRUD through `Storage.getStorage().store`, validators from Group 0, limits, in-use delete conflict, schedule sync (`schedule/register` for `backup-<planId8>`), default local destination. Unit tests with stub storage. Verify with `cd panel && npm test`.
- [x] 4.3 Add `routers/backup_router.ts` per the API table with role checks (`ROLE.ADMIN` vs assigned via `isHaveInstanceByUuid`), record redaction for users, run rate limit (60 s per user per plan), download tickets, restore precondition (stopped), and operation log entries without secrets. Verify with `cd panel && npm run build && npm test`.
- [x] 4.4 Add Google OAuth connect and callback (`state` store with 10 minute expiry, single use, admin-session binding, redirect URI from the configured public URL), token exchange over HTTPS to the hardcoded Google host. Unit tests for bad, reused, and expired state, non-admin, and secret not logged. Verify with `cd panel && npm test`.
- [x] 4.5 Add the daemon push listener (`backup/trigger` to credential-bearing `backup/run`, `backup/finished` to `backupEvents` publishing `backup.succeeded` or `backup.failed`) and `service/backup_events.ts`. Unit tests with a fake remote. Verify with `cd panel && npm test`.

## 5. Group E: Frontend

- [x] 5.1 Add `services/apis/backup.ts` (typed API) and `hooks/useBackups.ts` (list, run, cancel, restore, download, polling every 3 s only while a job is active, cleared on unmount) with fake-timer tests. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 5.2 Add the per-instance Backups page (record list with size, date, per-destination status chips; Backup now; Restore with confirm and stopped-state notice; Download; hidden admin-only controls for regular users), route, and instance menu entry. Component tests for admin vs user rendering. Verify with `cd frontend && npm run type-check && npm test` and screenshots in light and dark themes.
- [x] 5.3 Add the plan editor (preset picker, include and exclude lists, schedule, retention 1-100, destination multi-select, Minecraft hook toggle, client validation mirroring server rules). Component tests for presets and validation. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 5.4 Add the admin Settings "Backup destinations" section (local, S3 form with path-style and private-network warning, Google Drive with OAuth connect and service account modes, masked secret fields, Test connection button). Component tests for masked fields never being sent as plain text. Verify with `cd frontend && npm run type-check && npm test`.
- [x] 5.5 Add i18n keys to `languages/en_US.json`, `zh_CN.json`, `tr_TR.json` (frontend `{name}`, backend `{{name}}` placeholders; do not run the rewriting scanner without reviewing its diff). Verify with `cd frontend && npm run type-check && npm run lint && npm test` and `cd panel && npm test`.

## 6. Group F: Integration and security tests (after A-D are merged)

- [ ] 6.1 Add test fixtures under `common/test/integration/fixtures/`: an in-process S3 mock (multipart, Head, Delete, Get) and a fake Google token and Drive server, plus helper wiring a test-only endpoint override that is compiled only with the integration test mode flag. Verify with `cd common && npm run test:integration` (fixtures load).
- [ ] 6.2 Add `common/test/integration/suites/instance_backups.test.ts`: real daemon and panel, create plan with local plus S3 plus Drive destinations, Backup now, verify archive contents on each, run N+2 backups and assert exactly N remain on every destination, partial failure (Drive fake returns 500) yields local ok and gdrive failed with `backup.succeeded` event and a warning, all fail emits `backup.failed`, restore into a stopped instance reproduces files, rollback on corrupted archive. Verify with `cd common && npm run test:integration`.
- [ ] 6.3 Add `common/test/integration/suites/backups_security.test.ts`: include path traversal (`../`, absolute, symlink) rejected; regular user cannot list, read, create, update, delete, or test destinations, cannot create plans or restore, can Backup now and list for an assigned instance only, cannot for unassigned; destination responses never contain real secrets (scan every response and the stored daemon data and logs); non-admin and bad `state` OAuth callbacks rejected; private S3 endpoint refused by default; restore refuses malicious archive. Verify with `cd common && npm run test:integration` and `cd panel && npm test`.
- [ ] 6.4 Memory check: back up a generated 1 GiB tree and record daemon RSS before, during, and after; assert growth under 150 MB and that no staging files remain. Verify with `cd common && npm run test:integration`.

## 7. Final verification

- [ ] 7.1 Run all suites with the `mcsmanager-test` skill (`common`, `daemon`, `panel`, `frontend`, `npm run test:integration`) and `cd frontend && npm run type-check && npm run lint`; confirm all pass.
- [ ] 7.2 Run `cd panel && npm run build` and `cd daemon && npm run build`, then a manual check against a real MinIO and a real Google account: scheduled backup, retention on both, restore, and `save-on` after a forced failure.

## Workflow follow-up

- Archive with `/openspec-archive-change` after review and merge.
