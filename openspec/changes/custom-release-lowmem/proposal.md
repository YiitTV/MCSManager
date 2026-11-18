# Proposal

## Why

The operator runs a private Minecraft network ("Minefield") on one Azure VM (Ubuntu 26.04 minimized, ~7.7 GB RAM, Caddy in front of the panel, MCSManager panel v10.22.1 and daemon v4.19.3 installed under `/opt/mcsmanager` as systemd units `mcsm-web` and `mcsm-daemon`, three game servers running as plain processes). Two problems:

1. **Update ownership.** The deployment will run a customised build of this fork (for example the Minefield branding). The stock auto-update would offer, and one click would apply, the official release, overwriting those customisations. There is no documented, repeatable way to build the fork and deploy it over the live install without risking `data/`.
2. **RAM budget.** The operator wants the OS, panel, daemon, Caddy and helpers to stay near 1 GB so the game servers get the rest. Today the panel is about 136 MB RSS and the daemon about 43 MB at idle, but both are started with `--max-old-space-size=8192` (no useful ceiling on a 7.7 GB machine), nothing caps the journal or reclaims idle OS memory, and there is no agreed, measurable target. Note: with 7.7 GB total and about 1 GB for the platform, at most roughly 6.5 GB is left for game servers, and the JVM heap budget must be smaller than that (see design).

## What Changes

- **Disable official updates without code.** The existing auto-update is manual-only (no background polling). It is switched off per install by clearing both `updateSourceUrl` and `updateSourceUrlFallback` (panel settings and daemon config); the existing "both empty disables the feature" rule already persists across restarts. No default changes for other installs. The same two fields can later point at this fork's own release manifest to re-enable the UI update flow.
- **Own release path.** The fork is built on a build host (not the 7.7 GB server) with `./build.sh` (`BUNDLE=1`), packed into the existing code-only update tarballs with `scripts/build-release-update-packages.mjs --repo <fork>`, copied to the server, and overlaid onto `/opt/mcsmanager/{web,daemon}` with a documented backup, preserve-`data/`, verify and rollback procedure.
- **Fork version marker.** Fork builds carry a fourth numeric version segment (e.g. panel `10.22.1.1`, daemon `4.19.3.1`) so the UI shows it is a customised build while staying comparable under the existing fail-closed version rules. A text suffix such as `-minefield.1` is rejected because the existing `isComparableVersion` would treat it as malformed.
- **Low-memory operation.** A measured baseline and a tuning set, applied through systemd drop-ins rather than code: Node heap ceilings and semi-space size for panel and daemon, `MALLOC_ARENA_MAX`, journald cap, zram swap, swappiness, a check-before-disable pass over idle services, and JVM sizing recommendations for the game servers (clearly marked as operator choices in `start.sh`, not repository code).
- **Acceptance target.** After deploy, idle `mcsm-web` + `mcsm-daemon` + `caddy` PSS is at most 350 MB combined, and with game servers stopped `free -m` "used" is at most about 1 GB; exact measurement commands are specified.
- **Findings, not rewrites.** A code review for unbounded long-lived structures found nothing significant; two minor non-evicting maps are recorded for a later follow-up and are out of scope here.

## Capabilities

### New Capabilities

- `custom-release-deployment`: Building the fork, packaging code-only update artifacts, and deploying them over an existing install while preserving `data/`, with verification and rollback.
- `low-memory-operation`: The memory budget, process tuning, OS tuning and acceptance measurements that define "low-memory" operation for a single-host panel + daemon deployment.

### Modified Capabilities

- `auto-update`: Adds a requirement that a build with a four-segment dotted numeric version is compared correctly and offered/declined by the existing rules, so fork builds work with a custom manifest.

## Impact

- Code: `panel/package.json` and `daemon/package.json` (version, and panel `daemonVersion`); extra cases in `common/src/__test__/upgrade.test.ts`. Optionally `.github/workflows/release.yml` (pass `--repo "${GITHUB_REPOSITORY}"`). No runtime logic changes, no API, data-format, permission or protocol changes.
- Operations (outside the repo): systemd drop-ins for `mcsm-web` and `mcsm-daemon`, `/etc/systemd/journald.conf.d/`, zram and sysctl configuration, Caddy untouched, game servers' `start.sh` (recommendations only).
- Docs: `runbook.md` in this change is the operator document; durable parts may later be folded into `docs/`.
- Operational risk to call out: restarting `mcsm-daemon` can stop the game servers it spawned (depends on the unit's `KillMode`); the runbook checks this before any restart.
