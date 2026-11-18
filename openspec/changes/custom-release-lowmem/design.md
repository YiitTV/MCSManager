# Design

## Context

Observed facts about the target (gathered by the operator, not reachable from the build environment): Ubuntu 26.04 minimized cloud image on Azure, kernel 7.0, about 7.7 GB RAM, `ufw` active, Caddy terminating HTTPS (duckdns hostname) and proxying to `127.0.0.1:23333`. MCSManager is installed the standard Linux way under `/opt/mcsmanager` (`web` = panel, `daemon`) with systemd units `mcsm-web` and `mcsm-daemon`. Idle RSS: panel about 136 MB, daemon about 43 MB. Three game servers run as plain processes (Lobi via `bash .../start.sh`, Main, Velocity), not Docker.

Observed in this repository:

- **Auto-update is manual-only.** `panel/src/app/service/upgrade_service.ts` and `daemon/src/service/upgrade_service.ts` only fetch a manifest when the UI asks (page load or refresh button) and only apply when an admin clicks update; there is no background polling and no auto-restart (`docs/auto-update.md` section 5). The feature is off when both `updateSourceUrl` and `updateSourceUrlFallback` are empty (`panel/src/app/service/upgrade_service.ts:87-88,123`, `daemon/src/service/upgrade_service.ts:97-100,137`). The only startup rewrite of these fields is `migrateLegacyUpdateSourceUrl` (`common/src/upgrade.ts:42`), which touches only a primary equal to the legacy mcsmanager.com URL, so empty values persist. The panel forwards its non-empty values to daemons; empty values are simply not forwarded (`panel/src/app/routers/upgrade_router.ts:24-30`). Defaults live in `panel/src/app/entity/setting.ts:153,157` and `daemon/src/entity/config.ts:60,64`.
- **Versions.** `getVersion()` reads `package.json` at startup (`panel/src/app/version.ts:57`). `isComparableVersion` requires `^\d+(\.\d+)*$` (`common/src/upgrade.ts:85`), and `compareVersions` handles any number of segments with missing ones as `0`. The frontend `hasVersionUpdate` (`frontend/src/tools/version.ts`) compares only major and minor, so a fourth segment cannot trigger the panel/daemon "version mismatch" warning.
- **Node flags.** `prod-scripts/linux/start-web.sh` and `start-daemon.sh` hard-code `node --max-old-space-size=8192 --enable-source-maps app.js`. The server's actual unit files are not known; they probably mirror this.
- **Release tooling.** `build.sh` with `BUNDLE=1` produces `production-code/`; `scripts/build-release-update-packages.mjs` packs the code-only tarballs and a manifest, but defaults `--repo` to `MCSManager/MCSManager`, and `.github/workflows/release.yml` does not pass `--repo`, so a CI run on a fork would write upstream URLs into the manifest.
- **Logs.** `app-log-rotation` (a separate active change) addresses disk growth of `logs/`; it does not affect RAM and is not a dependency.

## Goals / Non-Goals

**Goals:**

- Keep the official release from overwriting the customised build, with no code default changes.
- A repeatable, data-safe build, deploy, verify and rollback procedure using existing tooling.
- Platform memory (OS + panel + daemon + Caddy) near 1 GB, with a measurable, honestly stated target.
- Tuning applied by configuration the operator can revert, each step measured.

**Non-Goals:**

- No new update server, no auto-restart, no background updating, no CI pipeline beyond an optional one-line workflow fix.
- No change to the Docker/instance model, to instance start commands, or to game-server settings (JVM guidance is advisory).
- No code changes to bound the two minor maps listed under Findings.
- No attempt to reduce the Minecraft servers' own memory beyond recommendations.
- Not building on the 7.7 GB production host.

## Decisions

### D1. Disable official updates by clearing both source fields (config only)

Clear `updateSourceUrl` and `updateSourceUrlFallback` in Settings, Auto Update (panel), and in the daemon's `data/Config/global.json` (those two keys only, since that file holds the panel-daemon key and its content must never be printed or copied).

- Why it works: dual-empty disables the feature on both sides, nothing persists defaults over empty strings, and the migration does not touch empty values.
- Why the daemon file also needs it: the daemon uses its own sources when the panel forwards none; with the panel empty and the daemon default intact, the daemon would still query the upstream release (only when the panel asks for daemon info, which happens on the Nodes page).
- Re-enable later with our own manifest: set `updateSourceUrl` to `https://github.com/<fork>/releases/latest/download/mcsmanager_update_manifest.json` and keep the fallback empty (clearing only the primary does not disable, and a non-empty default fallback would still reach upstream). The fork must be public (or the manifest otherwise anonymously fetchable) because the fetch sends no credentials.

Alternatives rejected:
- Default-off setting or build-time flag: changes behavior contracts for every install and adds code for a problem solvable with two settings.
- Pointing the source at a dead URL: not "disabled", produces fetch errors in logs.
- Removing the feature from the build: large diff against upstream, conflicts on every merge.
- Network block (ufw/hosts for `github.com`): breaks unrelated functions (mod downloads, Steam, etc.).

### D2. Build off-box, ship the existing code-only packages, overlay

Build on a build host with Node 22 (`./install-dependents.sh` once, then `./build.sh`), pack with `node scripts/build-release-update-packages.mjs --tag <tag> --repo <fork> --out <dir>`, copy the two tarballs and their SHA-256 to the server, verify, back up, extract over `/opt/mcsmanager/{web,daemon}`, restart, verify.

- Reuses the exact package format that the in-product updater applies, so a later switch to UI updates from our manifest requires no new format.
- The tarballs never contain `data/`, `logs/`, `lib/`, `node_modules/` or a runtime, so an overlay cannot touch them. On the server, extraction uses plain `tar -xzf` into the existing directory without `--delete`; only `web/public` is removed first because its hashed asset names change on every build.
- The in-product transactional overlay is not used for the first deployment because the official updater is being disabled; manual extraction with a code backup gives the same rollback property.
- Alternative rejected: `rsync production-code/` onto `/opt/mcsmanager` (risks `--delete` accidents and ships `lib/`); build on the server (vite and webpack peaks would compete with game servers for RAM and add toolchains to a minimized host).
- Optional follow-up task: pass `--repo "${GITHUB_REPOSITORY}"` in `.github/workflows/release.yml` so a fork release produces a correct manifest.

### D3. Version marker as a fourth numeric segment

Panel `10.22.1.1`, daemon `4.19.3.1`, panel `daemonVersion` `4.19.3.1`; the last segment increments per fork build on the same upstream base, and resets when rebasing onto a new upstream version (`10.23.0` then `10.23.0.1`).

- Alternatives: `10.22.1-minefield.1` fails `isComparableVersion` (malformed, never offered) and `compareVersions` would parse `1-minefield` as `1`; a separate `build` field in `package.json` needs UI work. The fourth segment needs no runtime code change and one extra test.
- Side effects checked: the "Version changed" startup warning uses only the first two segments; `hasVersionUpdate` ignores segment three and later; the panel-daemon check compares major.minor only.
- Gate: if any unexpected consumer of the version string appears during implementation, drop the marker (it is optional) and keep the rest.
- A daemon version bump forces a daemon restart to take effect; defer the daemon bump to a window when the daemon is restarted anyway.

### D4. Node memory tuning through systemd drop-ins, measured one step at a time

Defaults to try, in this order (each measured, each revertible):

1. `Environment=MALLOC_ARENA_MAX=2` (glibc per-thread arenas inflate RSS of multi-threaded Node; common, low risk).
2. `--max-semi-space-size=4` (V8 default is up to 16 MB per semi-space; 4 MB trims young-generation growth at the cost of slightly more frequent scavenges).
3. `--max-old-space-size=256` for both processes. This is a ceiling, not an allocation: it will not shrink idle RSS by itself, but it bounds runaway growth and makes V8 collect earlier as the heap approaches it. Idle RSS is 136 MB and 43 MB, so 256 MB leaves about 2x headroom for the panel and 5x for the daemon. If a process ever restarts on `JavaScript heap out of memory`, raise that ceiling to 384 rather than removing it.

Delivery: a drop-in per unit (`systemctl edit`), using `NODE_OPTIONS` when the unit's `ExecStart` has no `--max-old-space-size`; if it does (e.g. `8192` copied from `start-*.sh`), a command-line flag wins over `NODE_OPTIONS`, so the drop-in must reset `ExecStart=` and restate it with the new values. The runbook branches on `systemctl cat`.

Honest expectation: these three together are expected to save tens of MB, not hundreds; the 350 MB target is met mostly because the baseline (136 + 43 + Caddy ~35 = about 215 MB) already fits. The measurement, not the flags, is the acceptance.

Alternatives rejected: `--jitless` and `--single-threaded` (CPU/latency cost for small gain; the daemon streams terminal output); worker restarts on a timer; swapping the runtime.

### D5. Never put a memory cgroup limit on `mcsm-daemon`

Plain-process game servers are children of the daemon and live in its cgroup (systemd default `KillMode=control-group`). `MemoryMax=` there would make the kernel OOM-kill a game server. Likewise `systemctl stop mcsm-daemon` sends SIGTERM to every game server. A `MemoryHigh=`/`MemoryMax=` on `mcsm-web` alone is allowed as a safety net (for example `MemoryHigh=300M`); `systemd-cgtop -m` shows per-unit totals including children. `KillMode=process` is rejected: the daemon cannot re-adopt orphaned plain processes after restart, leaving servers holding ports.

### D6. OS tuning as runbook, not repository code

- zram swap: `systemd-zram-generator` (fallback `zram-tools`), `zram-size = ram / 4`, `compression-algorithm = zstd`, high priority. Azure images normally have no swap, so zram gives an emergency buffer: about 1.9 GB of zram stores more than that of cold pages, at CPU cost that is small compared to a stalled JVM.
- `vm.swappiness=30` and `vm.page-cluster=0`. A higher swappiness (100+) is common with zram but moves JVM heap pages into zram sooner and can lengthen GC pauses; start at 30 and tune with `vmstat 1` and TPS observations.
- journald: `SystemMaxUse=100M` (drop-in under `/etc/systemd/journald.conf.d/`).
- Services: list first (`systemctl list-units --type=service --state=running`, `ps -eo rss,comm --sort=-rss`), disable only what is measured to cost RAM and is not needed. Candidates to look at, not assumptions: `snapd` (if present), `multipathd`, `ModemManager`, `udisks2`, `polkit`. Do not disable the Azure guest agent (`walinuxagent`/`waagent`), networking, `ssh`, `chrony`/time sync, `ufw`, `cron`/timers needed for backups. `unattended-upgrades` is kept but its timers inspected; an upgrade run is a RAM spike, so prefer scheduling it off-peak instead of removing it.
- Caddy (about 30-40 MB) stays. Panel `gzip` stays at its default `false`; if compression is wanted, enable `encode zstd gzip` in Caddy instead, which keeps the Node heap free of compression buffers.

### D7. JVM recommendations (advisory)

Budget with 7.7 GB total: platform about 1.0 GB; JVM heaps total at most about 5.0 GB, for example Main 3 GB, Lobi 1.5 GB, Velocity 512 MB; JVM non-heap overhead (metaspace, thread stacks, code cache, GC structures) adds roughly 10 to 15% (about 0.6 to 0.75 GB); the remainder (about 1 GB) is page cache and slack. Setting `-Xms` equal to `-Xmx` avoids resize churn; `-XX:+AlwaysPreTouch` makes RSS equal the heap immediately, so the budget is real from the start. Paper-family servers: the Aikar G1 flag set for heaps under 12 GB. Velocity: its documented small-heap flag set. These are written in the runbook for the operator to apply in each `start.sh`; they are not repository code and the operator may choose different sizes.

### D8. Acceptance measurement

PSS (proportional set size) from `/proc/<pid>/smaps_rollup` for `mcsm-web`, `mcsm-daemon` and `caddy` (main PIDs from `systemctl show -p MainPID --value`), summed, at most 350 MB, after 10 idle minutes with game servers stopped. System: `free -m` "used" at most about 1024 MB in the same state. Baseline taken before any tuning so every step has a delta. PSS is used rather than RSS so shared pages are not double counted; RSS (`ps`) is recorded too for comparison with the earlier figures.

## Findings: long-lived structures (AGENTS.md section 8)

A scan of `new Map` / `new Set` / `setInterval` in `panel/src/app` and `daemon/src` found no significant unbounded growth. Most are bounded by a cap, a TTL sweeper or by the number of instances: SSO tokens capped at 1000 (`panel/src/app/service/user_sso_service.ts:4,12-14`), mod cache capped at 1000 plus a daily clear (`mod_manager_service.ts:22-35`), nonce store and daemon mission passports swept on timers (`gateway_token.ts:53-66`, `daemon/src/service/mission_passport.ts:15-23`), charts are fixed-length `LineQueue`s, operation-log cache bounded by retention (`operation_logger.ts:51,76-86`, `operationLogMaxTotalLines` 20000, 30 days).

Two minor items, bounded in practice, recorded for a possible later cleanup (not in this change):

- `panel/src/app/service/instance_name_service.ts:11,33`: `nameCache` entries are only refreshed on read after the 60 s TTL and are never removed; the key space is daemons x instances, so growth requires instance churn.
- `daemon/src/routers/instance_event_router.ts:10,27-30`: `buffer` keeps one key per instance forever (value reset to an empty string after each flush); the per-instance string is capped at about 1 MiB by the reset on line 29.

## Risks / Trade-offs

- **Daemon restart stops game servers** (D5). Mitigation: runbook checks `KillMode`, requires a graceful stop of instances first, and the daemon deploy is a separate maintenance step.
- **Heap ceiling too low causes a crash loop.** Mitigation: ceilings are 256 MB against 136 MB and 43 MB idle; systemd `Restart=` behavior is checked; one step at a time with `journalctl -u` review; revert is deleting the drop-in.
- **`NODE_OPTIONS` rejected a flag** (service fails to start). Mitigation: pre-test the exact flags with the server's own node binary before restarting, and the rollback is removing the drop-in.
- **Swap and latency.** zram plus swappiness 30 can still push JVM pages to swap under pressure; monitor `vmstat` si/so and lower the heap budget rather than raising swappiness.
- **Fork drifts from upstream.** The fourth-segment convention and the `--repo` fix make rebases straightforward; security fixes upstream must be merged manually since official updates are off. This is an accepted cost of D1, to be reviewed periodically.
- **Manifest hosting.** A private fork cannot serve the manifest anonymously; until that is decided, deployment stays manual (open question).
- **Rollback depends on the backup.** Mitigation: backup before every deploy, checksum recorded, and one rehearsal before relying on it.

## Migration Plan

1. Implement the optional version marker and tests; run all suites.
2. Build and package on the build host; checksum.
3. On the server: baseline measurement, backups, disable auto-update settings, deploy the panel, verify; in a maintenance window deploy the daemon, verify.
4. Apply tuning one step at a time with measurements; apply OS tuning; acceptance measurement.
5. Rehearse rollback once.

Rollback: stop the unit, restore the code backup (`web` or `daemon`), start, verify; remove drop-ins and `systemctl daemon-reload` to undo tuning; `swapoff`/remove the zram config to undo swap. `data/` is never modified by any step.

## Open Questions

- Is the fork repository public (needed to serve the manifest for a later UI-driven update flow)?
- Does the existing `ExecStart` carry `--max-old-space-size=8192`, and is `KillMode` default? (Read by the runbook; the answers select a branch.)
- Which user do the units run as (affects `chown` after extraction)?
- Is the operator willing to schedule a short game-server downtime for the daemon deployment?
