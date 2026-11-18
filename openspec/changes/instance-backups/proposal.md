# Proposal

## Why

Game worlds are the most valuable data on a server and today the only protection is manual zipping through the file manager, which is slow, easy to forget, risks copying a world mid-write, and leaves the copy on the same disk that may fail. Operators want automatic, scheduled, off-machine backups of the parts of an instance that matter (worlds, plugins, configs), with a bounded number of copies kept, and a one-click restore. The deployment is memory-constrained (OS, panel, and daemon together stay near 1 GB so game servers keep their RAM), so backups must stream and never buffer whole archives.

## What Changes

- New **backup plans** per instance: an admin chooses which paths (relative to the instance working directory) to include, exclude globs, a preset (Minecraft worlds only, worlds + plugins + configs, whole directory), a schedule (interval or cron), a retention count N (1-100), and one or more destinations.
- New **backup destinations**, managed by administrators only: `local` (a directory on the daemon host, default and staging destination), `s3` (any S3-compatible storage: AWS S3, Cloudflare R2, Backblaze B2, MinIO), and `gdrive` (Google Drive, connected by the operator with their own Google Cloud OAuth client, or a service account JSON key).
- The **daemon** creates a streamed zip archive of the selected paths and uploads it to each destination directly from the daemon using bounded-size parts. Credentials are stored encrypted-at-rest on the panel, delivered to the daemon per job over the authenticated panel-daemon channel, and kept only in memory for the job. Secrets are never returned to the frontend after save.
- **Minecraft consistency**: for a running Minecraft instance the daemon can send `save-off` and `save-all flush`, wait for the save-complete line with a timeout, archive, and always send `save-on` afterward. Default on for Minecraft instance types.
- **Retention**: after a backup succeeds, the daemon deletes older backups beyond N on every destination of the plan, using only the backup index (never pattern matching), counting only successful copies per destination, and never deleting the backup just created.
- **Backup now**, a backup list (size, date, per-destination status), download of the local copy, and **restore** (admin only, instance must be stopped, remote copies are fetched to local staging first).
- A new schedule action type `backup` in the existing instance schedule system, so plans reuse the existing trigger machinery.
- Events `backup.succeeded` and `backup.failed` are emitted with a defined payload for the parallel `discord-notifications` change.
- Frontend: a per-instance **Backups** page (list, backup now, restore, download, plan editor) and an admin **Settings** section for destinations with a test-connection button. UI strings in `en_US`, `zh_CN`, and `tr_TR`.

## Capabilities

### New Capabilities

- `instance-backups`: Backup plans, destinations, streamed archiving with consistency hook, multi-destination upload, index and retention, restore, role permissions, secret handling, limits, and notification events.

### Modified Capabilities

- `instance-schedules`: adds a `backup` action type that runs a backup plan, with the same per-instance limits and access rules.

## Impact

- `daemon/src/`: new `service/backup/` (archiver, job queue, index, retention, destination drivers `local`, `s3`, `gdrive`, consistency hook), new `routers/backup_router.ts`, a `backup` branch in `service/system_instance_control.ts` schedule actions, reuse of `FileManager` path checks and `utils/url.ts` DNS-pinned URL resolution.
- `panel/src/app/`: new `entity/backup.ts`, `service/backup_service.ts` (destinations, plans, secret encryption and masking, job dispatch), `routers/backup_router.ts`, Google OAuth callback handling, registration in the router index.
- `common/`: shared backup types and the notification event interface.
- `frontend/src/`: Backups page and plan editor, Settings destinations section, API definitions, hooks, route and menu entry.
- `languages/`: new `TXT_CODE_` keys in `en_US.json`, `zh_CN.json`, `tr_TR.json`.
- New data: `panel/data/BackupDestination/*.json` (contains encrypted secrets, sensitive), `panel/data/BackupPlan/*.json`, `daemon/data/BackupIndex/<instanceUuid>.json`. No change to existing user, instance, or schedule formats; no migration needed.
- Dependencies: `archiver` (already declared in the daemon); no AWS SDK or `googleapis` package is added. S3 SigV4 and Google REST are implemented over the existing HTTP client to keep the bundle small.
