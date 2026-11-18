# Design

## Context

MCSManager has a panel (Koa) that owns users, nodes, and settings, and a daemon that owns instance files and processes. Files live on the daemon, and the daemon already has: `FileManager` path containment (`daemon/src/service/system_file.ts`, `isOutsideWorkspace` + `resolvePhysicalPath`, covered by `daemon/src/routers/__test__/file_router.security.test.ts`), a schedule engine (`daemon/src/service/system_instance_control.ts`, actions delay/start/stop/restart/command/kill), `archiver` declared in `daemon/package.json`, a DNS-pinning SSRF helper (`daemon/src/utils/url.ts`, `resolveSafeUrl`, from commit 390ae23), `protocol.broadcast` for daemon-to-panel pushes, and the `__MCSM_SECRET_DATA__` masking pattern in `panel/src/app/routers/manage_user_router.ts`. The deployment budget is OS + panel + daemon near 1 GB, so every data path must stream.

Existing `daemon/src/common/compress.ts` compresses by spawning a Go `zip` binary (`daemon/lib`) that writes a file; it cannot be piped, cannot be niced per entry, and is not suitable for exclude globs and symlink skipping. It is reused only as a pattern for subprocess limits.

## Decisions

### D1. Where it runs
Archiving and uploading run in the **daemon**. The panel never receives archive bytes except a user download, which streams through the existing authenticated daemon download channel. Rejected: archive on daemon and upload from panel (moves GBs through the panel, doubles bandwidth and memory pressure).

### D2. Credential flow
Alternatives:
1. Panel stores secrets, sends them per job over the authenticated panel-daemon channel, daemon keeps them in memory only (chosen).
2. Daemon stores secrets: rejected, secrets would sit on every node, and a multi-node setup needs the same destination on many nodes.
3. Secrets only in env/config files: rejected, not editable in the UI.

Panel storage: `AES-256-GCM` with a random 32-byte key in `panel/data/Config/backup_secret.key` (created at first use, file mode 0600, treated as sensitive in AGENTS.md section 5 terms). Secrets are stored as `{iv, tag, ciphertext}` base64. The key file is not returned by any API. This is defense in depth against data-directory leaks (backups of `panel/data`), not against a panel host compromise. Redis storage mode stores the same ciphertext.

Scheduled jobs: the daemon cannot read panel storage and the panel is the socket client, so the `backup` schedule action calls `protocol.broadcast("backup/trigger", { instanceUuid, planId })` to connected panels. The panel (a listener registered in `backup_service`) validates plan and instance existence, then calls `backup/run` on that daemon with the credentials. If no panel socket is connected, the daemon records a failed run (`panel_unreachable`) in the index and sends the failure event on the next panel connection (`backup/pending_events` handshake). This keeps one credential path.

### D3. Google Drive authentication
| | OAuth 2.0 (operator's client) | Service account + shared folder |
|---|---|---|
| Setup | Create Cloud project, OAuth client, consent screen, connect in UI | Create service account, share a folder to its email |
| Storage quota | Uses the operator's own Drive quota | Service accounts have no personal quota; works for Shared Drives, or a folder shared from a user (quota is then the owner's only in some cases; frequently fails with `storageQuotaExceeded` on My Drive) |
| Scope | `drive.file` (only files the app created) | Folder-level access by sharing |
| Token upkeep | Refresh token (Testing-mode consent screens expire tokens after 7 days; must publish the app) | None |

Decision: support **both**, OAuth as the primary documented path (works with a normal personal Drive) and service account as the option for Shared Drives and for operators who do not want the consent screen. Both are plain REST: `POST https://oauth2.googleapis.com/token` (refresh_token grant, or JWT-bearer grant with RS256 signed by `crypto` for service accounts), `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`, `GET /drive/v3/files?q=...` (list inside the folder), `DELETE /drive/v3/files/{id}`. The panel callback route `GET /api/backup/gdrive/callback` is on the panel's HTTPS host; `redirect_uri` is derived from the configured panel public URL (reusing the existing SSO redirect URI resolution, which must not trust forwarded headers), and `state` is a 128-bit random value bound to the admin session and destination id, single use, 10 minute expiry. Rejected: loopback/device flow (device flow does not support the Drive scopes for custom clients; loopback does not work for a remote panel). Rejected: `googleapis` package (tens of MB installed, large bundle).

A Drive upload creates a folder `MCSManager/<instance-name>-<uuid8>` inside the configured parent (or the app root for `drive.file`), stores its id on the destination state, and tracks every uploaded file id in the index. Deletion only uses ids from the index.

### D4. S3 library
Alternatives: `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (about 10-20 MB installed, many transitive packages, memory spikes of parts x concurrency, large webpack bundle, conflicts with the `BUNDLE=1` single-file release) versus a minimal SigV4 client over the daemon's HTTP stack. Decision: **minimal SigV4** in `daemon/src/service/backup/destinations/s3.ts` (about 300 lines): `CreateMultipartUpload`, `UploadPart` (payload sha256 computed per part while the part is held, one part in memory), `CompleteMultipartUpload`, `AbortMultipartUpload`, `DeleteObject`, `HeadObject`, `GetObject` (stream, for restore), and path-style or virtual-hosted addressing. Verified against MinIO, R2, B2 in manual checks and against an in-process S3 mock in tests. The signing code uses only `crypto`. Risk: S3-compatible quirks (B2 requires path-style and rejects some headers); mitigated by sending the minimum header set and the path-style toggle.

### D5. Archive format and streaming
Format: **zip** produced by `archiver` (`zlib.level = 1`, zip64 enabled) piped to a staging file. Reasons: restore can reuse the daemon's existing zip entry checks (`listArchiveEntries`, symlink target checks in `FileManager.unzip`), world files are already zlib-compressed so a higher level only burns CPU, and zip is openable by operators. tar.gz was rejected because extraction safety would need a new tar reader. Archiving walks the include paths with a bounded iterative walker (no `fs.readdirSync` of whole trees at once, lstat only, symlinks skipped, files over a plan limit not special-cased), applies excludes, and appends entries with `archiver.file`. The staging file is written first, then uploaded from the file, because multipart needs a known part boundary, resumable retry needs rewindable data, and a failed upload must not force re-archiving a live world. Cost: temporary disk space of one archive (prechecked, see D9). Rejected: pipe archiver straight into the upload (retries impossible, destination failure would stall the archiver and keep `save-off` active longer, one slow destination would hold the world in an unsaved-flush window).

CPU/IO priority: the archiver runs in the daemon process. To avoid starving game servers, the walker yields with `setImmediate` every 64 files and the daemon lowers its priority for the job with `os.setPriority(0, 10)` while a job runs and restores it after; on Linux an optional `ionice -c3`-style wrapper is not used because the work is in-process. Concurrency is one job per daemon; queue max 20.

Upload parts: S3 parts 8 MiB (16 MiB past 80 GB to stay under 10000 parts); Drive chunks 8 MiB (multiple of 256 KiB). Parts are read from the staging file with `fs.read` into one reused buffer.

### D6. Roles
- Destinations (create/update/delete/test/OAuth connect): administrators only (they carry credentials and network reach).
- Plans (create/update/delete): administrators only (they choose paths and destinations, and a bad plan could be a data-exfiltration or disk-exhaustion tool).
- Backup now, list, download local copy: administrators and assigned users. Justification: assigned users already may read and download the instance files through the file manager, so a download of an archive of that same directory does not widen access, and "Backup now" is a safe, rate-limited, additive action. A per-user per-plan limit of one request per 60 seconds prevents queue abuse.
- Restore and cancel: administrators only. Restore overwrites instance files and may run archives created from an instance directory that the user could also have edited, so it is kept admin-only; a later change can add per-instance opt-in.
- Schedules with a `backup` action: administrators only; existing schedules without it are unchanged for assigned users.
- Assigned users see destination names and types in records only, never remote keys, buckets, folder ids, or errors that contain URLs (errors are shown as short codes plus sanitized text).

### D7. SSRF
`resolveSafeUrl` currently rejects IP literals, `localhost`, `.local`, hostnames without a dot, and private resolved addresses. A self-hosted MinIO is typically on a LAN IP, so it needs an explicit switch. Decision: S3 destinations have `allowPrivateNetwork` (default false, admin-only, shown with a warning). When false the daemon uses `resolveSafeUrl` and pins `address` via the HTTP agent's `lookup` option (same approach as the URL download fix). When true the daemon still resolves once and pins the address, still rejects credentials in the URL, still rejects link-local metadata addresses (`169.254.0.0/16`, `fd00:ec2::/32`) and `0.0.0.0`, and allows `http` and IP literals. Google endpoints are hardcoded (`oauth2.googleapis.com`, `www.googleapis.com`) and not configurable.

### D8. Data model and storage
Types live in `common/src/backup.ts` (shared contract). Persistence uses `StorageSubsystem` on the daemon and `Storage.getStorage().store(...)` on the panel (no hand-rolled `fs.writeFile`).

```ts
type BackupDestinationType = "local" | "s3" | "gdrive";

interface BackupDestination {            // panel: data/BackupDestination/<id>.json
  id: string;                             // uuid
  type: BackupDestinationType;
  name: string;                           // 1..40
  config: LocalConfig | S3Config | GDriveConfig;   // non-secret
  secrets: Record<string, EncryptedSecret | undefined>; // encrypted at rest
  createdAt: number; updatedAt: number;
}
interface LocalConfig { directory: string; maxTotalBytes: number }   // absolute path, validated
interface S3Config {
  endpoint: string; region: string; bucket: string; prefix?: string;
  pathStyle: boolean; allowPrivateNetwork: boolean; accessKeyId: string;
  // secrets: secretAccessKey
}
interface GDriveConfig {
  authMethod: "oauth" | "service_account"; clientId?: string; folderId?: string;
  connectedEmail?: string;  // display only
  // secrets: clientSecret, refreshToken, serviceAccountJson
}

interface BackupPlan {                    // panel: data/BackupPlan/<id>.json
  id: string; daemonId: string; instanceUuid: string; name: string;
  preset: "minecraft-worlds" | "minecraft-worlds-plugins-configs" | "whole-directory" | "custom";
  include: string[]; exclude: string[];
  schedule?: { kind: "interval" | "cron"; value: string };   // optional; manual-only if absent
  retention: number;                      // 1..100
  destinationIds: string[];               // 1..5, "local" staging copy is always kept if listed
  minecraftSaveHook: boolean; enabled: boolean;
}

interface BackupRecord {                  // daemon: data/BackupIndex/<instanceUuid>.json
  id: string; planId: string; createdAt: number; sizeBytes: number; sha256: string;
  trigger: "manual" | "schedule";
  warnings: string[];
  copies: Record<string /* destinationId */, {
    status: "ok" | "failed" | "deleted";
    type: BackupDestinationType; name: string;
    remoteId?: string;                    // S3 key or Drive file id or local file name
    error?: string;                       // sanitized
  }>;
}
```
Limits: 20 destinations per panel, 4 plans per instance, 500 records per instance index (oldest fully-deleted records dropped first; if the index is full, new jobs are refused with a limit error until retention frees space).

The panel plan owns the schedule definition; on save it registers or updates a daemon schedule named `backup-<planId8>` with a single `backup` action through the existing `schedule/register` path (admin-only because of the delta spec), and removes it when the plan is deleted, disabled, or its schedule cleared. This avoids a second scheduler.

### D9. Failure handling
- Disk precheck: sum of file sizes (lstat walk) x 1.2 must be <= free space of the staging volume (`fs.statfs`), and for `local` the destination's `maxTotalBytes` must not be exceeded after the retention that this job would trigger.
- Staging file name `<stagingDir>/<backupId>.zip.tmp`, moved to the local destination directory by atomic rename if local is a destination on the same volume, otherwise copied; deleted after the last destination finishes. On daemon start, `*.tmp` files in the staging dir older than the daemon uptime are removed.
- Upload retries 3x (1 s, 4 s, 16 s) for network errors, 5xx, 429; 60 s per-request timeout; job timeout 6 h default.
- Retention counts only `ok` copies per destination (see spec). Deletion failures are recorded and retried at the next job.
- If the daemon restarts mid-job, the job is marked failed on start (`daemon_restart`) and temp files are cleaned. Orphaned multipart uploads are aborted on a best-effort basis from the persisted in-flight list (`data/BackupIndex/inflight.json` holds only ids, not secrets) when credentials are next available.

### D10. Retention algorithm
```
afterJob(plan, newRecord):
  for each destination d in plan.destinationIds:
    ok = records(plan.id).filter(r => r.copies[d]?.status == "ok").sortBy(createdAt desc)
    if newRecord.copies[d]?.status != "ok": continue   // do not prune a destination whose latest upload failed
    for r in ok.slice(plan.retention):
      if r.id == newRecord.id: continue                // defensive
      deleteRemote(d, r.copies[d].remoteId)            // by recorded id only
      mark r.copies[d].status = "deleted" (on failure keep "ok" and set warning)
  drop records whose copies are all deleted
```
Retention is skipped for a destination whose current upload failed, so a failing destination never deletes its last good copies.

### D11. Restore
Panel checks admin and instance stopped (`instance/detail` status), sends `backup/restore` with the record id. Daemon: fetch the remote copy into staging if no local copy, verify sha256, `listArchiveEntries` and validate each entry (no absolute names, no `..`, symlink targets inside the instance directory, total uncompressed size <= configured max zip size), move current contents of the restored top-level include paths into `<instance>/.mcsm_restore_rollback_<id>`, extract with the existing safe extraction in `FileManager`, remove the rollback directory on success, put it back on failure. The restore job takes the same global queue slot.

### D12. Events for the notifications change
`common/src/backup.ts` exports the interface below; the panel publishes it on its in-process event bus (a small typed `EventEmitter` in `panel/src/app/service/backup_events.ts`, `backupEvents.on("backup.succeeded" | "backup.failed", handler)`), which `discord-notifications` consumes.

```ts
interface BackupEventPayload {
  event: "backup.succeeded" | "backup.failed";
  occurredAt: number;                     // epoch ms
  instance: { daemonId: string; uuid: string; name: string };
  plan: { id: string; name: string };
  backupId: string;
  trigger: "manual" | "schedule";
  initiatedBy?: string;                   // user display name for manual
  sizeBytes?: number; durationMs: number;
  destinations: { id: string; name: string; type: BackupDestinationType;
                  status: "ok" | "failed"; error?: string }[];
  warnings: string[];
  errorSummary?: string;                  // failed only, sanitized, max 300 chars
}
```
No secrets, keys, paths, or URLs are included. A job emits exactly one event.

## Contracts

### Panel HTTP API (all under `/api/backup`, auth via existing middleware)
| Method + path | Role | Purpose |
|---|---|---|
| `GET /destinations` | admin | list (masked) |
| `POST /destinations` / `PUT /destinations` / `DELETE /destinations` | admin | CRUD; PUT keeps secrets on `__MCSM_SECRET_DATA__` |
| `POST /destinations/test` | admin | test connection |
| `GET /gdrive/connect?destinationId=` | admin | returns the Google consent URL (state stored server-side) |
| `GET /gdrive/callback?code=&state=` | admin session | exchange code, store refresh token, redirect to settings |
| `GET /plans?daemonId=&uuid=` | admin or assigned | list plans (destination names only for users) |
| `POST /plans` / `PUT /plans` / `DELETE /plans` | admin | CRUD plan + schedule sync |
| `POST /run` `{daemonId, uuid, planId}` | admin or assigned | Backup now |
| `GET /records?daemonId=&uuid=` | admin or assigned | list records (users: redacted) |
| `POST /cancel` | admin | cancel queued/running job |
| `POST /restore` `{daemonId, uuid, recordId}` | admin | restore (instance stopped) |
| `POST /download` `{daemonId, uuid, recordId}` | admin or assigned | single-use, 60 s download ticket for the local copy |
| `GET /jobs?daemonId=&uuid=` | admin or assigned | queue/running status, progress |

### Panel to daemon protocol (new `daemon/src/routers/backup_router.ts`)
| Event | Direction | Data |
|---|---|---|
| `backup/run` | panel to daemon | `{instanceUuid, plan, destinations: [{id,type,name,config,secrets(plain)}], trigger, initiatedBy?}` response `{backupId}` |
| `backup/status` | panel to daemon | `{instanceUuid}` returns queue, running job, progress |
| `backup/cancel` | panel to daemon | `{instanceUuid, backupId}` |
| `backup/records` | panel to daemon | `{instanceUuid}` returns index |
| `backup/restore` | panel to daemon | `{instanceUuid, recordId, destinations(for remote copy)}` |
| `backup/download_ticket` | panel to daemon | `{instanceUuid, recordId}` returns ticket path for the existing download channel |
| `backup/test_destination` | panel to daemon | `{destination}` returns `{ok, error?}` |
| `backup/trigger` | daemon to panel (broadcast) | `{instanceUuid, planId}` (scheduled firing) |
| `backup/finished` | daemon to panel (broadcast) | `{instanceUuid, record, errorSummary?, durationMs}` (source of the notification event) |

The daemon validates every request (`instanceUuid` exists, plan paths via `FileManager`, destination config shape) and never trusts that the panel already did.

## Risks and Trade-offs
- Staging disk usage of one archive; mitigated by precheck and cleanup.
- Hand-written SigV4 and Drive clients are maintenance cost; contained in two small modules with mock-server tests.
- The 1-job-per-daemon queue delays backups on busy nodes; acceptable for the RAM budget.
- `os.setPriority` affects the whole daemon process for the job duration, so daemon-side instance management gets slower during a backup; acceptable and documented.
- Google OAuth in "Testing" consent mode expires refresh tokens in 7 days; the settings UI must say to publish the app or use a service account.

## Open Questions
- A Google Cloud OAuth client (and, for the redirect URI, the panel public HTTPS URL) is required from the operator; the plan assumes the existing panel public URL setting is available.
